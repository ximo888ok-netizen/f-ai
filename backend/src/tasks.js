
import { randomUUID } from 'node:crypto';
import { digest } from './auth.js';
import { taskAssets } from './assets.js';
import { capabilityId, capabilityRules, catalog, plugins } from './catalog.js';
import { row, rows } from './db.js';
import { ApiError, bool, choice, freeObject, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { modelIdSchema } from './models.js';
import { matchingProviders, providerFor, taskProvider } from './providers.js';
import { finishCredits, reserveCredits } from './wallet.js';
import { accessibleProject } from './workspace.js';
import { guidedMessages } from './workspace-library.js';
import { notify } from './notifications.js';
import { logTask, registerTaskEvents } from './task-events.js';
import { registerTaskStream } from './task-stream.js';

const tags = ['Tasks'];
const idParams = object({ id: uuid });
export const keySchema = { ...text(100, 8), pattern: '^(?!schedule:)[A-Za-z0-9_.:-]+$' };
const taskFields = [
  'id', 'capability_id AS "capabilityId"', 'plugin_id AS "pluginId"', 'project_id AS "projectId"',
  'parent_id AS "parentId"', "CASE WHEN provider_id LIKE 'model:%' THEN substr(provider_id, 7) END AS \"modelId\"", 'state', 'cost', 'attempts', 'result', 'error_code AS "errorCode"',
  'created_at AS "createdAt"', 'updated_at AS "updatedAt"',
  "COALESCE(capability_id = 'model.chat' AND input->'parameters'->'stream' = 'true'::jsonb, false) AS streamed",
].join(', ');
const stateSchema = choice('queued', 'running', 'succeeded', 'failed', 'cancelled');

export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function shopFingerprint(shop) {
  return digest(stableJson([shop.id, shop.platform, shop.gatewayReference]));
}

function bindingFor(shops, context, capability, parameters) {
  if (capability.pluginId !== 'operations') return null;
  const shop = shops.get(parameters.shopId);
  if (!shop || shop.workspaceId !== context.workspaceId || shop.platform !== parameters.platform) throw notFound('Authorized shop');
  if (!shop.capabilities.includes(capability.id)) throw new ApiError(403, 'SHOP_PERMISSION_DENIED', 'This shop lacks the requested permission');
  return shop;
}

async function lockPlugin(db, workspaceId, pluginId) {
  // A missing row means enabled. Write once so disabling and submitting serialize.
  await db.query('INSERT INTO plugin_settings (workspace_id, plugin_id, enabled) VALUES ($1, $2, true) ON CONFLICT DO NOTHING', [workspaceId, pluginId]);
  const setting = await row(db, 'SELECT enabled FROM plugin_settings WHERE workspace_id = $1 AND plugin_id = $2 FOR UPDATE', [workspaceId, pluginId]);
  if (!setting.enabled) throw new ApiError(409, 'PLUGIN_DISABLED', 'Plugin is disabled for this workspace');
}

async function findTask(db, context, id, fields = taskFields, lock = false) {
  const task = await row(db, 'SELECT ' + fields + ' FROM tasks WHERE workspace_id = $1 AND account_id = $2 AND id = $3' + (lock ? ' FOR UPDATE' : ''), [context.workspaceId, context.accountId, id]);
  if (!task) throw notFound('Task');
  return task;
}

async function submit(db, providers, shops, context, input, parentId = null) {
  return db.transaction(connection => submitInTransaction(connection, providers, shops, context, input, parentId));
}

export async function submitInTransaction(connection, providers, shops, context, input, parentId = null) {
  const { workspaceId, accountId } = context;
  const { capabilityId: id, projectId, mode, parameters, idempotencyKey, confirmationId } = input;
  const capability = catalog.get(id);
  const storedInput = { mode, parameters };
  if (input.modelId !== undefined) storedInput.modelId = input.modelId;
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

  const providerId = providerFor(providers,capability,input.modelId,id==='model.chat' && parameters.stream===true);
  const provider = taskProvider(providers,providerId);
  provider.validate?.(capability, parameters);
  if (provider.taskConfiguration) storedInput.providerConfiguration=provider.taskConfiguration(parameters);
  if (id === 'model.chat' && parameters.guidanceIds?.length) {
    storedInput.guidedMessages = await guidedMessages(connection, workspaceId, parameters.guidanceIds, parameters.messages);
  }
  if (provider.signature) {
    storedInput.modelSignature = provider.signature;
    storedInput.modelId = provider.info.id;
  }
  await lockPlugin(connection, workspaceId, capability.pluginId);
  await accessibleProject(connection, context, projectId, true);
  if (capability.pluginId === 'operations' && context.role === 'member') {
    throw new ApiError(403, 'FORBIDDEN', 'Workspace owner or administrator required for shop operations');
  }
  const shop = bindingFor(shops, context, capability, parameters);
  const binding = shop ? shopFingerprint(shop) : null;
  if (binding) storedInput.shopFingerprint = binding;
  await taskAssets(connection, context, parameters.assetIds ?? parameters.listing?.assetIds ?? [], capability);
  if (capability.requiresConfirmation) {
    const preview = confirmationId && await row(connection, 'SELECT parameters, shop_fingerprint FROM shop_previews WHERE id = $1 AND workspace_id = $2 AND account_id = $3 AND capability_id = $4 AND used_at IS NULL AND expires_at > now() FOR UPDATE', [confirmationId, workspaceId, accountId, id]);
    if (!preview || preview.shop_fingerprint !== binding || stableJson(preview.parameters) !== stableJson(parameters)) {
      throw new ApiError(409, 'CONFIRMATION_REQUIRED', 'A current preview matching these exact parameters is required');
    }
    await connection.query('UPDATE shop_previews SET used_at = now() WHERE id = $1', [confirmationId]);
  } else if (confirmationId) {
    throw invalid('This capability does not accept a confirmation ID');
  }

  const taskId = randomUUID();
  await reserveCredits(connection, workspaceId, accountId, taskId, capability.cost);
  const task = await row(connection, [
    'INSERT INTO tasks (id, workspace_id, account_id, project_id, parent_id, capability_id, provider_id, plugin_id, input, request_hash, idempotency_key, state, cost)',
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12) RETURNING " + taskFields,
  ].join(' '), [taskId, workspaceId, accountId, projectId ?? null, parentId, id, providerId, capability.pluginId, storedInput, hash, idempotencyKey, capability.cost]);
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

export function registerTasks(app, db, providers, shops) {
  registerTaskEvents(app, db, findTask);
  registerTaskStream(app,findTask);
  route(app, 'GET', '/v1/plugins', { tags: ['Plugins'], summary: 'List business plugins, capabilities and input contracts' }, async request => {
    const settings = new Map((await rows(db, 'SELECT plugin_id, enabled FROM plugin_settings WHERE workspace_id = $1', [request.context.workspaceId])).map(setting => [setting.plugin_id, setting.enabled]));
    const describe = plugin => ({
      ...plugin, enabled: settings.get(plugin.id) ?? true,
      capabilities: [...catalog.values()].filter(capability => capability.pluginId === plugin.id).map(capability => {
        const { execution, ...contract } = capability;
        return { ...contract, available: execution === 'endpoint' || matchingProviders(providers, capability).length > 0 };
      }),
    });
    return { items: plugins.map(describe), models: describe({ id: 'models', name: '模型工具' }) };
  });

  route(app, 'PUT', '/v1/plugins/:id/state', {
    manager: true, tags: ['Plugins'], summary: 'Enable or disable new submissions in a workspace',
    params: object({ id: choice('models', ...plugins.map(plugin => plugin.id)) }),
    body: object({ enabled: bool }),
  }, async request => {
    const { workspaceId } = request.context;
    await db.query('INSERT INTO plugin_settings (workspace_id, plugin_id, enabled) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, plugin_id) DO UPDATE SET enabled = EXCLUDED.enabled', [workspaceId, request.params.id, request.body.enabled]);
    return { id: request.params.id, enabled: request.body.enabled };
  });

  route(app, 'GET', '/v1/shops', { manager: true, tags: ['Shops'], summary: 'List provisioned shop bindings and granted capabilities' }, async request => ({
    items: [...shops.values()].filter(shop => shop.workspaceId === request.context.workspaceId)
      .map(({ id, name, platform, capabilities }) => ({ id, name, platform, capabilities })),
  }));

  route(app, 'POST', '/v1/shops/previews', {
    manager: true, tags: ['Shops'], summary: 'Create a short-lived preview for manual confirmation',
    body: { ...object({ capabilityId: choice('operations.publish', 'operations.bulk-maintenance'), parameters: freeObject }), allOf: capabilityRules.filter(rule => catalog.get(rule.if.properties.capabilityId.const).requiresConfirmation) },
  }, async (request, reply) => {
    const { workspaceId, accountId } = request.context;
    const { capabilityId: id, parameters } = request.body;
    const capability = catalog.get(id);
    providerFor(providers, capability);
    const shop = bindingFor(shops, request.context, capability, parameters);
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
        capabilityId, modelId: modelIdSchema, mode: choice('chat', 'workflow'), parameters: freeObject, idempotencyKey: keySchema, projectId: uuid, confirmationId: uuid,
      }, ['capabilityId', 'mode', 'parameters', 'idempotencyKey']),
      allOf: capabilityRules,
    },
  }, async (request, reply) => {
    const result = await submit(db, providers, shops, request.context, request.body);
    reply.code(result.created ? 202 : 200);
    return result.task;
  });

  route(app, 'GET', '/v1/tasks', {
    tags, summary: 'List tasks for the authenticated member',
    querystring: object({ ...page.properties, state: stateSchema }, []),
  }, async request => ({
    items: await rows(db, 'SELECT ' + taskFields + ' FROM tasks WHERE workspace_id = $1 AND account_id = $2 AND ($3::text IS NULL OR state = $3) ORDER BY created_at DESC, id LIMIT $4 OFFSET $5', [request.context.workspaceId, request.context.accountId, request.query.state ?? null, ...paginate(request.query)]),
  }));

  route(app, 'GET', '/v1/tasks/:id', { tags, summary: 'Read task status, error and output', params: idParams },
    request => findTask(db, request.context, request.params.id));

  route(app, 'POST', '/v1/tasks/:id/cancel', {
    tags, summary: 'Cancel a task before the worker acquires it', params: idParams,
  }, async request => db.transaction(async connection => {
    const existing = await findTask(connection, request.context, request.params.id, '*', true);
    if (existing.state !== 'cancelled') {
      if (existing.state !== 'queued' || existing.attempts > 0) throw new ApiError(409, 'TASK_ALREADY_STARTED', 'Only tasks that have never started can be cancelled');
      await finishTask(connection, existing, 'cancelled', null, null);
    }
    return findTask(connection, request.context, existing.id);
  }));

  route(app, 'POST', '/v1/tasks/:id/regenerate', {
    tags, summary: 'Create a new execution linked to a completed task',
    params: idParams, body: object({ idempotencyKey: keySchema }),
  }, async (request, reply) => {
    const previous = await findTask(db, request.context, request.params.id, '*');
    if (['queued', 'running'].includes(previous.state)) throw new ApiError(409, 'TASK_IN_PROGRESS', 'Wait for the original task to finish');
    if (catalog.get(previous.capability_id).requiresConfirmation) {
      throw new ApiError(409, 'CONFIRMATION_REQUIRED', 'Create a fresh shop preview before submitting again');
    }
    const result = await submit(db, providers, shops, request.context, {
      ...previous.input, capabilityId: previous.capability_id, projectId: previous.project_id,
      idempotencyKey: request.body.idempotencyKey,
    }, previous.id);
    reply.code(result.created ? 202 : 200);
    return result.task;
  });
}
