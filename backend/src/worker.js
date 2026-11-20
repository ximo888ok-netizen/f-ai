
import { randomUUID } from 'node:crypto';
import { taskAssets } from './assets.js';
import { catalog } from './catalog.js';
import { row, rows } from './db.js';
import { ApiError } from './http.js';
import { ProviderError } from './providers.js';
import { dispatchSchedule } from './schedules.js';
import { finishTask, shopFingerprint } from './tasks.js';
import { accessibleProject } from './workspace.js';

const maxAttempts = 3;

async function claim(db) {
  return db.transaction(async connection => {
    const task = await row(connection, [
      'SELECT * FROM tasks',
      "WHERE (state = 'queued' AND available_at <= now()) OR (state = 'running' AND lease_until <= now())",
      'ORDER BY available_at, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED',
    ].join(' '));
    if (!task) return null;
    if (task.attempts >= maxAttempts) {
      await finishTask(connection, task, 'failed', null, 'WORKER_LEASE_EXPIRED');
      return { expired: true };
    }
    const lease = randomUUID();
    return row(connection, [
      "UPDATE tasks SET state = 'running', attempts = attempts + 1, updated_at = now(),",
      "lease_id = $2, lease_until = now() + interval '120 seconds' WHERE id = $1 RETURNING *",
    ].join(' '), [task.id, lease]);
  });
}

async function providerPayload(db, task, capability, shops) {
  const scope = await row(db, 'SELECT m.role, w.kind FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = $1 AND m.account_id = $2', [task.workspace_id, task.account_id]);
  if (!scope) throw new ProviderError('MEMBERSHIP_REVOKED');
  const context = { ...scope, workspaceId: task.workspace_id, accountId: task.account_id };
  await accessibleProject(db, context, task.project_id, true);
  const setting = await row(db, 'SELECT enabled FROM plugin_settings WHERE workspace_id = $1 AND plugin_id = $2', [task.workspace_id, task.plugin_id]);
  if (setting?.enabled === false) throw new ProviderError('PLUGIN_DISABLED');
  if (task.provider_id === 'local') return null;

  const { mode, parameters } = task.input;
  const { assetIds, shopId, listing, ...providerParameters } = parameters;

  let shopReference;
  if (shopId) {
    const shop = shops.get(shopId);
    if (!shop || shop.workspaceId !== task.workspace_id || shop.platform !== parameters.platform || context.role === 'member' || !shop.capabilities.includes(capability.id)) {
      throw new ProviderError('SHOP_PERMISSION_DENIED');
    }
    if (task.input.shopFingerprint !== shopFingerprint(shop)) throw new ProviderError('SHOP_BINDING_CHANGED');
    shopReference = shop.gatewayReference;
  }
  const ids = await taskAssets(db, context, assetIds ?? listing?.assetIds ?? [], capability);
  const assets = ids.length ? await rows(db, 'SELECT id, media_type, data, consent_expires_at FROM assets WHERE workspace_id = $1 AND account_id = $2 AND id = ANY($3::uuid[])', [task.workspace_id, task.account_id, ids]) : [];
  const assetsById = new Map(assets.map(asset => [asset.id, asset]));
  if (assets.length !== ids.length) throw new ProviderError('ASSET_REMOVED');
  if (capability.requiresConsent && assets.some(asset => new Date(asset.consent_expires_at).getTime() <= Date.now())) {
    throw new ProviderError('CONSENT_REQUIRED');
  }
  if (listing) {
    const { assetIds: listingAssets, ...fields } = listing;
    providerParameters.listing = fields;
  }
  return {
    capabilityId: capability.id, mode, parameters: providerParameters,
    ...(shopReference ? { shopReference } : {}),
    assets: ids.map(id => {
      const asset = assetsById.get(id);
      return { mediaType: asset.media_type, dataBase64: Buffer.from(asset.data).toString('base64') };
    }),
  };
}

export async function workOnce({ db, providers, shops }) {
  const task = await claim(db);
  if (!task) return false;
  if (task.expired) return true;
  const capability = catalog.get(task.capability_id);
  const provider = providers.get(task.provider_id);
  let result;
  let failure;
  try {
    if (!capability || !provider?.supports(capability)) throw new ProviderError('CAPABILITY_UNAVAILABLE');
    result = await provider.run(task, await providerPayload(db, task, capability, shops));
  } catch (error) {
    if (error instanceof ApiError) failure = new ProviderError(error.code);
    else if (error instanceof ProviderError) failure = error;
    else failure = new ProviderError('TASK_EXECUTION_ERROR', true);
  }
  await db.transaction(async connection => {
    const current = await row(connection, "SELECT * FROM tasks WHERE id = $1 AND lease_id = $2 AND state = 'running' FOR UPDATE", [task.id, task.lease_id]);
    if (!current) return;
    if (failure?.retryable && current.attempts < maxAttempts) {
      await connection.query([
        "UPDATE tasks SET state = 'queued', lease_id = NULL, lease_until = NULL,",
        "available_at = now() + $2::integer * interval '1 second', error_code = $3, updated_at = now() WHERE id = $1",
      ].join(' '), [current.id, 2 ** current.attempts, failure.code]);
    } else {
      await finishTask(connection, current, failure ? 'failed' : 'succeeded', result ?? null, failure?.code ?? null);
    }
  });
  return true;
}

export function startWorker(dependencies, logger) {
  let stopping = false;
  let timer;
  let pending;
  const run = () => {
    if (stopping) return;
    pending = dispatchSchedule(dependencies)
      .then(() => workOnce(dependencies))
      .catch(() => logger.error('Background work could not be processed'))
      .finally(() => {
        if (!stopping) timer = setTimeout(run, 500);
      });
  };
  run();
  return async () => {
    stopping = true;
    clearTimeout(timer);
    await pending;
  };
}
