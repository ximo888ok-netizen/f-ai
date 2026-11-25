import { catalog } from './catalog.js';
import { registerMerchantConnections } from './merchant-connections.js';
import { registerMerchantMembers } from './merchant-members.js';
import { registerMerchantAudit } from './merchant-audit.js';
import { featureReleases, registerMerchantFeatures, requireFeature } from './merchant-features.js';
import { registerProjects } from './merchant-projects.js';

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { registerAssets } from './assets.js';
import { registerAuth } from './auth.js';
import { contracts, errorContracts } from './contracts.js';
import { registerCustomerService } from './customer.js';
import { checkMigrations, migrationFiles } from './db.js';
import { ApiError, choice, object, route } from './http.js';
import { createProviders } from './providers.js';
import { registerSchedules } from './schedules.js';
import { registerListingDrafts } from './listing-drafts.js';
import { registerStudio } from './studio.js';
import { registerShopOperations } from './shop-operations.js';
import { registerStudioProducts } from './studio-products.js';
import { registerSupport } from './support.js';
import { registerModels } from './models.js';
import { registerTasks } from './tasks.js';
import { registerWallet } from './wallet.js';
import { registerWorkspace } from './workspace.js';
import { registerWorkspaceLibrary } from './workspace-library.js';
import { registerWorkspaceDiagnostics } from './workspace-diagnostics.js';
import { registerWebSearch } from './web-search.js';
import { workspaceDatabaseRouter } from './workspace-database.js';
import { registerStudioPsd } from './studio-psd.js';
import { registerCloudAssets } from './cloud-assets.js';
import { registerFeishuChannel } from './feishu-channel.js';
import { registerVideoDelivery } from './video-delivery.js';
import { registerRightsNotices } from './rights-notices.js';
import { registerSkillRuns } from './skill-runs.js';
import { registerImageStudio } from './image-studio.js';
import { registerStoryboards } from './video-storyboards.js';
import { registerCopywritingReview } from './copywriting-review.js';
import { installIntegrations, registerIntegrations } from './plugin-integrations.js';
import { installMediaSkills, registerMediaSkills } from './media-skill-runtime.js';
import { registerDeskShops } from './desk-shops.js';
import { taobaoSettings, registerShopAuth } from './shop-authorization.js';

export async function buildApp({
  db, providers = createProviders(), shops = new Map(), origins = [], logger = false, webSearch = null, dedicatedDatabases = new Map(), previewAdmin = false,
  integrations = {}, integrationRunner, mediaRuntime, shopAuth = taobaoSettings(), shopTokenExchange,
  cloudAssets = new Map(), feishu = new Map(), videoDelivery = null, customerAnswer = null, loopbackOnly = false, releases = featureReleases(process.env.FAI_FEATURE_RELEASES_JSON),
}) {
  const app = Fastify({
    logger,
    genReqId: () => randomUUID(),
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    bodyLimit: 15000000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(cors, { origin: origins, allowedHeaders: ['authorization', 'content-type', 'x-workspace-id'], exposedHeaders:['x-content-sha256'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new ApiError(429, 'RATE_LIMITED', 'Too many authentication requests'),
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'f-ai Platform API', version: '0.1.0' },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
    },
  });

  app.addHook('onRoute', options => {

    const response = contracts.get(options.url)?.[options.method] ?? options.schema?.response;
    if (response && options.schema) options.schema.response = { ...response, ...errorContracts };
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    if (loopbackOnly && request.headers.host !== '127.0.0.1:'+request.raw.socket.localPort) {
      throw new ApiError(403,'LOCAL_HOST_REQUIRED','Access the desktop workspace through its local address');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    let failure;
    if (error instanceof ApiError) failure = error;
    else if (error.validation) failure = new ApiError(400, 'INVALID_INPUT', error.message);
    else if (error.statusCode === 413) failure = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    else if (error.statusCode === 415) failure = new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
    else if (error.statusCode === 400) failure = new ApiError(400, 'INVALID_INPUT', 'Invalid request');
    else {
      request.log.error({ errorCode: error.code }, 'Request processing failed');
      failure = new ApiError(500, 'INTERNAL_ERROR', 'The server could not complete this request');
    }
    if (failure.statusCode === 401) reply.header('www-authenticate', 'Bearer');
    return reply.code(failure.statusCode).send({ error: { code: failure.code, message: failure.message, requestId: request.id } });
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id },
  }));

  const requiredMigrations = await migrationFiles();
  const databaseRouter = workspaceDatabaseRouter(db, dedicatedDatabases, requiredMigrations);
  const workspaceDb = databaseRouter.db;
  const runtimes = await installIntegrations(providers, integrations, integrationRunner);
  const mediaDirectory=await installMediaSkills(providers,mediaRuntime,loopbackOnly);
  app.decorate('workspaceDatabaseRouter', databaseRouter);
  app.decorate('withWorkspaceDatabase', (id, handler) => databaseRouter.run(id, handler));
  app.get('/health', { schema: { tags: ['Health'], summary: 'Check server liveness' } }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: { tags: ['Health'], summary: 'Check the database and migration readiness' } }, async () => {
    try {
      if (!(await checkMigrations(db, requiredMigrations))) throw new Error('Migration missing');
    } catch {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database or required migration is unavailable');
    }
    return { status: 'ready' };
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  registerStudio(app);
  registerAuth(app, db, previewAdmin);
  app.decorate('verifyFeature', (context, plugin) => {
    const capability = catalog.get(plugin);
    return requireFeature(workspaceDb, context, capability?.pluginId ?? plugin, capability?.id);
  });
  registerMerchantMembers(app, db);
  registerMerchantAudit(app, db, workspaceDb);
  registerMerchantFeatures(app, workspaceDb, providers, releases);
  registerProjects(app, workspaceDb);
  registerMerchantConnections(app, workspaceDb, { providers, shops, cloudAssets, feishu, integrations });
  route(app, 'GET', '/v1/merchant/context', {
    manager: true, enterprise: true, database: 'identity', tags: ['Merchant'], summary: 'Read access to the merchant workspace',
  }, request => ({ role: request.context.role, workspaceId: request.context.workspaceId }));
  route(app,'GET','/v1/workspace/database',{
    database:'identity', manager:true, tags:['Workspace support'], summary:'Read the current workspace database mode and connection state',
    response:{200:object({mode:choice('shared','dedicated'),state:choice('ready','preparing','unavailable')})},
  }, request => databaseRouter.status(request.context.workspaceId));
  registerStudioProducts(app, workspaceDb);
  registerStudioPsd(app, workspaceDb, videoDelivery);
  registerVideoDelivery(app, workspaceDb, videoDelivery);
  registerStoryboards(app,workspaceDb,videoDelivery);
  registerListingDrafts(app, workspaceDb);
  registerShopOperations(app, workspaceDb);
  registerWallet(app, workspaceDb);
  registerWorkspace(app, workspaceDb);
  registerWorkspaceLibrary(app, workspaceDb);
  registerSkillRuns(app,workspaceDb,providers,shops);
  registerRightsNotices(app,workspaceDb);
  registerWorkspaceDiagnostics(app, workspaceDb, requiredMigrations);
  registerWebSearch(app, webSearch);
  registerAssets(app, workspaceDb);
  registerImageStudio(app,workspaceDb);
  registerCopywritingReview(app,workspaceDb);
  registerCloudAssets(app,workspaceDb,cloudAssets);
  registerFeishuChannel(app,workspaceDb,feishu);
  registerSupport(app, workspaceDb);
  registerCustomerService(app, workspaceDb, customerAnswer, integrations);
  registerDeskShops(app, workspaceDb, integrations, shopAuth);
  registerShopAuth(app, workspaceDb, shopAuth, shopTokenExchange);
  registerIntegrations(app, workspaceDb, integrations, runtimes, integrationRunner, shopAuth);
  registerMediaSkills(app,workspaceDb,providers,mediaDirectory);
  registerModels(app, providers, workspaceDb);
  registerTasks(app, workspaceDb, providers, shops);
  registerSchedules(app, workspaceDb, providers);
  return app;
}
