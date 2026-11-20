
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { registerAssets } from './assets.js';
import { registerAuth } from './auth.js';
import { contracts, errorContracts } from './contracts.js';
import { registerCustomerService } from './customer.js';
import { migrationFiles, row } from './db.js';
import { ApiError } from './http.js';
import { createProviders } from './providers.js';
import { registerSchedules } from './schedules.js';
import { registerStudio } from './studio.js';
import { registerStudioProducts } from './studio-products.js';
import { registerSupport } from './support.js';
import { registerModels } from './models.js';
import { registerTasks } from './tasks.js';
import { registerWallet } from './wallet.js';
import { registerWorkspace } from './workspace.js';

export async function buildApp({
  db, providers = createProviders(), shops = new Map(), origins = [], logger = false,
}) {
  const app = Fastify({
    logger,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    bodyLimit: 15000000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(cors, { origin: origins, allowedHeaders: ['authorization', 'content-type', 'x-workspace-id'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
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

    const response = contracts.get(options.url)?.[options.method];
    if (response && options.schema) options.schema.response = { ...response, ...errorContracts };
  });

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
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
  app.get('/health', { schema: { tags: ['Health'], summary: 'Check server liveness' } }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: { tags: ['Health'], summary: 'Check the database and migration readiness' } }, async () => {
    try {
      const migration = await row(db, 'SELECT count(*)::integer AS count FROM migrations WHERE name = ANY($1::text[])', [requiredMigrations]);
      if (migration?.count !== requiredMigrations.length) throw new Error('Migration missing');
    } catch {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database or required migration is unavailable');
    }
    return { status: 'ready' };
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  registerStudio(app);
  registerAuth(app, db);
  registerStudioProducts(app, db);
  registerWallet(app, db);
  registerWorkspace(app, db);
  registerAssets(app, db);
  registerSupport(app, db);
  registerCustomerService(app, db);
  registerModels(app, providers);
  registerTasks(app, db, providers, shops);
  registerSchedules(app, db, providers);
  return app;
}
