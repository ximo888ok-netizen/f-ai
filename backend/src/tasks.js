import { shopGrantExpired, connectionEnabled, modelProviders, requireConnection } from './merchant-connections.js';
import { featureAllowed, memberFeatureSettings, requireFeature, updateFeature } from './merchant-features.js';

import { randomUUID } from 'node:crypto';
import { digest } from './auth.js';
import { taskAssets } from './assets.js';
import { needsImageReview } from './image-preflight.js';
import { capabilityId, capabilityRules, catalog, plugins } from './catalog.js';
import { row, rows } from './db.js';
import { ApiError, bool, choice, freeObject, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { modelIdSchema } from './models.js';
import { matchingProviders, providerFor, taskProvider } from './providers.js';
import { finishCredits, reserveCredits } from './wallet.js';
import { accessibleProject } from './merchant-projects.js';
import { guidedMessages } from './workspace-library.js';
import { notify } from './notifications.js';
import { imageDelivery, imagePlanRetryUrl } from './product-image-contract.js';
import { logTask, registerTaskEvents } from './task-events.js';
import { registerTaskStream } from './task-stream.js';

const tags = ['Tasks'];
const idParams = object({ id: uuid });
export const keySchema = { ...text(100, 8), pattern: '^(?!schedule:)[A-Za-z0-9_.:-]+$' };
const taskFields = [
  'id', 'capability_id AS "capabilityId"', 'plugin_id AS "pluginId"', 'project_id AS "projectId"',
  'parent_id AS "parentId"', 'feature_version AS "featureVersion"', "CASE WHEN provider_id LIKE 'model:%' THEN substr(provider_id, 7) END AS \"modelId\"", 'state', 'cost', 'attempts', 'result', 'error_code AS "errorCode"',
  'created_at AS "createdAt"', 'updated_at AS "updatedAt"',
  `CASE WHEN plugin_id='copywriting' AND capability_id<>'copywriting.detect-terms'
    THEN coalesce((input->'parameters'->>'templateVersion')::integer,1) END AS "templateVersion"`,
  "COALESCE(capability_id = 'model.chat' AND input->'parameters'->'stream' = 'true'::jsonb, false) AS streamed",
].join(', ');
const stateSchema = choice('queued', 'running', 'succeeded', 'failed', 'cancelled');
const taskReadFields = taskFields + `, COALESCE((SELECT MAX(e.id) FROM task_events e WHERE e.task_id=tasks.id),0)::text AS "eventCursor",
  (SELECT jsonb_build_object('planId',a.plan_id,'position',a.position,'attempt',a.attempt,'assetId',asset.id,'latest',
    NOT EXISTS(SELECT 1 FROM product_image_attempts successor WHERE successor.workspace_id=a.workspace_id
      AND successor.account_id=a.account_id AND successor.plan_id=a.plan_id AND successor.position=a.position
      AND successor.attempt>a.attempt))
   FROM product_image_attempts a
   LEFT JOIN assets asset ON tasks.state='succeeded'
     AND asset.id=CASE WHEN tasks.input->>'requireImageAsset'='true' THEN (tasks.result->>'assetId')::uuid END
     AND asset.workspace_id=a.workspace_id AND asset.account_id=a.account_id AND NOT asset.rights_restricted
   WHERE a.task_id=tasks.id AND a.workspace_id=tasks.workspace_id
     AND a.account_id=tasks.account_id) AS "imagePlan"`;

function presentTask(task) {
  if (task.imagePlan) {
    const {planId,position,latest,assetId} = task.imagePlan;
    const canRetry = latest && ['failed','cancelled'].includes(task.state);
    task.imagePlan = {...task.imagePlan,canRetry,retryUrl:canRetry ? imagePlanRetryUrl(planId,position) : null,
      ...imageDelivery(assetId)};
  }
  return task;
}

export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function capabilitySignature(capability) {
  const { execution, parameters, cost, minAssets, requiresConsent, requiresConfirmation, modes } = capability;
  return digest(stableJson({ execution, parameters, cost, minAssets, requiresConsent, requiresConfirmation, modes }));
}

export function shopFingerprint(shop) {
  return digest(stableJson([shop.id, shop.platform, shop.gatewayReference]));
}

function bindingFor(shops, context, capability, parameters) {
  if (capability.pluginId !== 'operations') return null;
  const shop = shops.get(parameters.shopId);
  if (!shop || shop.workspaceId !== context.workspaceId || shop.platform !== parameters.platform) throw notFound('Authorized shop');
  if (shopGrantExpired(shop)) throw new ApiError(403,'SHOP_AUTH_EXPIRED','Shop authorization expired');
  if (!shop.capabilities.includes(capability.id)) throw new ApiError(403, 'SHOP_PERMISSION_DENIED', 'This shop lacks the requested permission');
  return shop;
}

async function findTask(db, context, id, fields = taskFields, lock = false) {
  const task = await row(db, 'SELECT ' + fields + ' FROM tasks WHERE workspace_id = $1 AND account_id = $2 AND id = $3' + (lock ? ' FOR UPDATE' : ''), [context.workspaceId, context.accountId, id]);
  if (!task) throw notFound('Task');
  return task;
}

async function readTask(db, context, id) {
  return presentTask(await findTask(db,context,id,taskReadFields));
}

async function submit(db, providers, shops, context, input, parentId = null) {
  return db.transaction(connection => submitInTransaction(connection, providers, shops, context, input, parentId));
}

export async function submitInTransaction(connection, providers, shops, context, input, parentId = null, { requireImageAsset = false } = {}) {
  const { workspaceId, accountId } = context;
  const { capabilityId: id, projectId, mode, parameters, idempotencyKey, confirmationId, imageQuality } = input;
  const capability = catalog.get(id);
  const storedInput = { mode, parameters };
  if (requireImageAsset) storedInput.requireImageAsset = true;
  if (input.modelId !== undefined) storedInput.modelId = input.modelId;
  if (imageQuality !== undefined) storedInput.imageQuality = imageQuality;
  const hash = digest(stableJson({ id, projectId: projectId ?? null, storedInput, parentId, confirmationId: confirmationId ?? null }));
  // The workspace plugin lock prevents submit/disable races. A per-wallet lock also
  // serializes requests that reuse an idempotency key across different plugins.
  await row(connection, 'SELECT balance FROM wallets WHERE workspace_id = $1 AND account_id = $2 FOR UPDATE', [workspaceId, accountId]);
  const existing = await row(connection, 'SELECT ' + taskFields + ', request_hash FROM tasks WHERE workspace_id = $1 AND account_id = $2 AND idempotency_key = $3', [workspaceId, accountId, idempotencyKey]);
  if (existing) {
    const { request_hash: previous, ...task } = existing;
    if (previous !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to a different request');
    return { task, created: false };
  }

  const featureVersion = await requireFeature(connection, context, capability.pluginId, id, true);
  const assetIds=parameters.assetIds ?? parameters.listing?.assetIds ?? [];
  const reviewImages=needsImageReview(capability);
  // Return actionable source errors even on a deployment without an image model.
  if (reviewImages) await taskAssets(connection,context,assetIds,capability);
  const availableProviders = await modelProviders(connection, workspaceId, providers);
  const providerId = providerFor(availableProviders, capability, input.modelId, id==='model.chat' && parameters.stream===true);
  const provider = taskProvider(availableProviders, providerId);
  if (imageQuality !== undefined && (id !== 'image.main-image' || !provider.info?.imageQuality)) {
    throw invalid('The selected model does not support independent main image quality');
  }
  if (capability.pluginId==='copywriting' && capability.execution==='gateway') {
    storedInput.parameters={...parameters,templateVersion:parameters.templateVersion ?? 2};
  }
  provider.validate?.(capability, parameters);
  if (provider.taskConfiguration) storedInput.providerConfiguration=provider.taskConfiguration(parameters);
  if (id === 'model.chat' && parameters.guidanceIds?.length) {
    storedInput.guidedMessages = await guidedMessages(connection, workspaceId, parameters.guidanceIds, parameters.messages);
  }
  if (provider.signature) {
    storedInput.modelSignature = provider.signature;
    storedInput.modelId = provider.info.id;
  }
  await accessibleProject(connection, context, projectId, true, true);
  if (capability.pluginId === 'operations' && context.role === 'member') {
    throw new ApiError(403, 'FORBIDDEN', 'Workspace owner or administrator required for shop operations');
  }
  const shop = bindingFor(shops, context, capability, parameters);
  if (shop) await requireConnection(connection, workspaceId, 'shop', shop.id);
  const binding = shop ? shopFingerprint(shop) : null;
  if (binding) storedInput.shopFingerprint = binding;
  if (!reviewImages) await taskAssets(connection,context,assetIds,capability);
  if (capability.requiresConfirmation) {
    const preview = confirmationId && await row(connection, 'SELECT parameters, shop_fingerprint FROM shop_previews WHERE id = $1 AND workspace_id = $2 AND account_id = $3 AND capability_id = $4 AND used_at IS NULL AND expires_at > now() FOR UPDATE', [confirmationId, workspaceId, accountId, id]);
    if (!preview || preview.shop_fingerprint !== binding || stableJson(preview.parameters) !== stableJson(parameters)) {
      throw new ApiError(409, 'CONFIRMATION_REQUIRED', 'A current preview matching these exact parameters is required');
    }
    await connection.query('UPDATE shop_previews SET used_at = now() WHERE id = $1', [confirmationId]);
  } else if (confirmationId) {
    throw invalid('This capability does not accept a confirmation ID');
  }

  storedInput.capabilitySignature = capabilitySignature(capability);
  const taskId = randomUUID();
  await reserveCredits(connection, workspaceId, accountId, taskId, capability.cost);
  const task = await row(connection, [
    'INSERT INTO tasks (id, workspace_id, account_id, project_id, parent_id, capability_id, provider_id, plugin_id, input, request_hash, idempotency_key, state, cost, feature_version)',
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12, $13) RETURNING " + taskFields,
  ].join(' '), [taskId, workspaceId, accountId, projectId ?? null, parentId, id, providerId, capability.pluginId, storedInput, hash, idempotencyKey, capability.cost, featureVersion]);
  await logTask(connection, taskId, 'queued', 0);
  return { task, created: true };
}

export async function finishTask(db, task, state, result, errorCode) {
  if (state!=='succeeded' && task.input?.parameters?.stream===true) {
    await db.query('DELETE FROM task_text_chunks WHERE task_id=$1',[task.id]);
  }
  await db.query('UPDATE tasks SET state = $2, result = $3, error_code = $4, lease_id = NULL, lease_until = NULL, updated_at = now() WHERE id = $1', [task.id, state, result, errorCode]);
  await finishCredits(db, task, state === 'succeeded');
  await logTask(db, task.id, state, task.attempts, errorCode);
  await notify(db, task.workspace_id, task.account_id, 'task', 'task.' + state, 'task:' + task.id,
    { taskId: task.id, capabilityId: task.capability_id, state, errorCode });
}

export function registerTasks(app, db, providers, shops, retryProductImageTask) {
  registerTaskEvents(app, db, readTask);
  registerTaskStream(app,findTask);
  route(app, 'GET', '/v1/plugins', { tags: ['Plugins'], summary: 'List business plugins, capabilities and input contracts' }, async request => {
    const [settings, availableProviders] = await Promise.all([
      memberFeatureSettings(db, request.context), modelProviders(db, request.context.workspaceId, providers),
    ]);
    const describe = plugin => ({
      ...plugin, enabled: featureAllowed(settings.get(plugin.id)),
      capabilities: [...catalog.values()].filter(capability => capability.pluginId === plugin.id).map(capability => {
        const { execution, ...contract } = capability;
        return { ...contract, available: featureAllowed(settings.get(plugin.id), capability.id) &&
          (execution === 'endpoint' || matchingProviders(availableProviders, capability).length > 0) };
      }),
    });
    return { items: plugins.map(describe), models: describe({ id: 'models', name: '模型工具' }) };
  });

  route(app, 'PUT', '/v1/plugins/:id/state', {
    manager: true, tags: ['Plugins'], summary: 'Enable or disable new submissions in a workspace',
    params: object({ id: choice('models', ...plugins.map(plugin => plugin.id)) }),
    body: object({ enabled: bool }),
  }, request => updateFeature(db, request, null, true));

  route(app, 'GET', '/v1/shops', { manager: true, tags: ['Shops'], summary: 'List provisioned shop bindings and granted capabilities' }, async request => ({
    items: (await Promise.all([...shops.values()].filter(shop => shop.workspaceId === request.context.workspaceId)
      .map(async shop => await connectionEnabled(db, request.context.workspaceId, 'shop', shop.id)
        ? { id:shop.id, name:shop.name, platform:shop.platform, capabilities:shopGrantExpired(shop)?[]:shop.capabilities,
          ...(shop.authorizedUntil?{authorizedUntil:new Date(shop.authorizedUntil).toISOString()}: {}) } : null))).filter(Boolean),
  }));

  route(app, 'POST', '/v1/shops/previews', {
    manager: true, feature: 'operations', tags: ['Shops'], summary: 'Create a short-lived preview for manual confirmation',
    body: { ...object({ capabilityId: choice('operations.publish', 'operations.bulk-maintenance'), parameters: freeObject }), allOf: capabilityRules.filter(rule => catalog.get(rule.if.properties.capabilityId.const).requiresConfirmation) },
  }, async (request, reply) => {
    const { workspaceId, accountId } = request.context;
    const { capabilityId: id, parameters } = request.body;
    const capability = catalog.get(id);
    await requireFeature(db, request.context, capability.pluginId, id);
    providerFor(providers, capability);
    const shop = bindingFor(shops, request.context, capability, parameters);
    await requireConnection(db, workspaceId, 'shop', shop.id);
    await taskAssets(db, request.context, parameters.listing?.assetIds ?? [], capability);
    const previewId = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await db.query('INSERT INTO shop_previews (id, workspace_id, account_id, capability_id, parameters, expires_at, shop_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7)', [previewId, workspaceId, accountId, id, parameters, expiresAt, shopFingerprint(shop)]);
    reply.code(201);
    return { confirmationId: previewId, expiresAt, capabilityId: id, parameters };
  });

  route(app, 'POST', '/v1/tasks', {
    tags, summary: 'Submit a priced and idempotent plugin task',
    body: {
      ...object({
        capabilityId, modelId: modelIdSchema, mode: choice('chat', 'workflow'), parameters: freeObject, idempotencyKey: keySchema,
        projectId: uuid, confirmationId: uuid, parentId: uuid, imageQuality: choice('low', 'medium', 'high'),
      }, ['capabilityId', 'mode', 'parameters', 'idempotencyKey']),
      allOf: capabilityRules,
    },
  }, async (request, reply) => {
    const parent = request.body.parentId;
    if (parent) {
      const source = await findTask(db, request.context, parent, 'capability_id, state');
      if (source.capability_id !== request.body.capabilityId || ['queued','running'].includes(source.state)) throw invalid('Select a finished task of the same capability');
    }
    const result = await submit(db, providers, shops, request.context, request.body, parent ?? null);
    reply.code(result.created ? 202 : 200);
    return result.task;
  });

  route(app, 'GET', '/v1/tasks', {
    tags, summary: 'List tasks for the authenticated member',
    querystring: object({ ...page.properties, state: stateSchema }, []),
  }, async request => ({
    items: (await rows(db, 'SELECT ' + taskReadFields + ' FROM tasks WHERE workspace_id = $1 AND account_id = $2 AND ($3::text IS NULL OR state = $3) ORDER BY created_at DESC, id LIMIT $4 OFFSET $5', [request.context.workspaceId, request.context.accountId, request.query.state ?? null, ...paginate(request.query)])).map(presentTask),
  }));

  route(app, 'GET', '/v1/tasks/:id', { tags, summary: 'Read task status, error and output', params: idParams },
    request => readTask(db, request.context, request.params.id));

  route(app, 'GET', '/v1/tasks/:id/inputs', { tags, summary: 'Read your own editable task parameters', params: idParams },
    request => findTask(db, request.context, request.params.id,
      `capability_id AS "capabilityId", project_id AS "projectId", input->>'mode' AS mode,
       input->>'modelId' AS "modelId", input->'parameters' AS parameters`));

  route(app, 'POST', '/v1/tasks/:id/cancel', {
    tags, summary: 'Cancel a task before the worker acquires it', params: idParams,
  }, async request => db.transaction(async connection => {
    const existing = await findTask(connection, request.context, request.params.id, '*', true);
    if (existing.state !== 'cancelled') {
      if (existing.state !== 'queued' || existing.attempts > 0) throw new ApiError(409, 'TASK_ALREADY_STARTED', 'Only tasks that have never started can be cancelled');
      await finishTask(connection, existing, 'cancelled', null, null);
    }
    return readTask(connection, request.context, existing.id);
  }));

  route(app, 'POST', '/v1/tasks/:id/regenerate', {
    tags, summary: 'Create a new execution linked to a completed task or retry one failed product image',
    params: idParams, body: object({ idempotencyKey: keySchema, instructions:text(2000) }, ['idempotencyKey']),
  }, async (request, reply) => {
    const previous = await findTask(db, request.context, request.params.id, '*');
    if (previous.input.requireImageAsset) {
      if (request.body.instructions !== undefined) throw invalid('Revision instructions apply to copywriting generation tasks');
      const {imagePlan} = await readTask(db, request.context, previous.id);
      if (!imagePlan) throw new ApiError(409, 'IMAGE_PLAN_RETRY_REQUIRED', 'Retry this image from its product image plan');
      const result = await retryProductImageTask(request.context, imagePlan.planId, imagePlan.position, previous.id);
      reply.code(result.created ? 202 : 200);
      return readTask(db, request.context, result.image.taskId);
    }
    if (['queued', 'running'].includes(previous.state)) throw new ApiError(409, 'TASK_IN_PROGRESS', 'Wait for the original task to finish');
    if (catalog.get(previous.capability_id).requiresConfirmation) {
      throw new ApiError(409, 'CONFIRMATION_REQUIRED', 'Create a fresh shop preview before submitting again');
    }
    let parameters=previous.input.parameters;
    if (previous.plugin_id==='copywriting' && previous.capability_id!=='copywriting.detect-terms') {
      parameters={...parameters,templateVersion:parameters.templateVersion ?? 1};
    }
    if (request.body.instructions!==undefined) {
      if (previous.plugin_id!=='copywriting' || previous.capability_id==='copywriting.detect-terms') {
        throw invalid('Revision instructions apply to copywriting generation tasks');
      }
      if (!request.body.instructions.trim()) throw invalid('Supply nonblank revision instructions');
      parameters={...parameters,instructions:request.body.instructions};
    }
    const result = await submit(db, providers, shops, request.context, {
      ...previous.input, capabilityId: previous.capability_id, projectId: previous.project_id,
      parameters,idempotencyKey: request.body.idempotencyKey,
    }, previous.id);
    reply.code(result.created ? 202 : 200);
    return result.task;
  });
}
