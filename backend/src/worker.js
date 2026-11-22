
import { randomUUID } from 'node:crypto';
import { GeneratedFile } from './model-file.js';
import { PendingModelJob } from './model-http.js';
import { taskAssets } from './assets.js';
import { catalog } from './catalog.js';
import { row, rows } from './db.js';
import { ApiError } from './http.js';
import { ProviderError, taskProvider } from './providers.js';
import { dispatchSchedule } from './schedules.js';
import { finishTask, shopFingerprint } from './tasks.js';
import { accessibleProject } from './workspace.js';
import { logTask } from './task-events.js';
import { dispatchFeishuReply } from './feishu-channel.js';
import { dispatchSms } from './sms-channel.js';
import { maintainRealtimeVoice } from './realtime-voice.js';
import { appendTaskText } from './task-stream.js';

const maxAttempts = 3;

async function claim(db) {
  return db.transaction(async connection => {
    const task = await row(connection, [
      'SELECT * FROM tasks',
      "WHERE ((state = 'queued' AND available_at <= now()) OR (state = 'running' AND lease_until <= now()))",
      'AND NOT EXISTS (SELECT 1 FROM workspace_database_routes r WHERE r.workspace_id = tasks.workspace_id)',
      'ORDER BY available_at, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED',
    ].join(' '));
    if (!task) return null;
    if (task.provider_sent_at && !task.provider_job_id && task.state === 'running') {
      await finishTask(connection, task, 'failed', null, 'PROVIDER_OUTCOME_UNKNOWN');
      return { expired: true };
    }
    if (task.provider_job_id && Date.now() - new Date(task.provider_sent_at).getTime() >= 24 * 3600 * 1000) {
      await finishTask(connection, task, 'failed', null, 'MODEL_JOB_EXPIRED');
      return { expired: true };
    }
    if (!task.provider_job_id && task.attempts >= maxAttempts) {
      await finishTask(connection, task, 'failed', null, 'WORKER_LEASE_EXPIRED');
      return { expired: true };
    }
    const lease = randomUUID();
    const claimed = await row(connection, [
      "UPDATE tasks SET state = 'running', attempts = attempts + CASE WHEN provider_job_id IS NULL THEN 1 ELSE 0 END, updated_at = now(),",
      "lease_id = $2, lease_until = now() + interval '120 seconds' WHERE id = $1 RETURNING *",
    ].join(' '), [task.id, lease]);
    if (!claimed.provider_job_id) await logTask(connection, claimed.id, 'running', claimed.attempts);
    return claimed;
  });
}

async function providerPayload(db, identityDb, task, capability, shops) {
  const scope = await row(identityDb, 'SELECT m.role, w.kind FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = $1 AND m.account_id = $2', [task.workspace_id, task.account_id]);
  if (!scope) throw new ProviderError('MEMBERSHIP_REVOKED');
  const context = { ...scope, workspaceId: task.workspace_id, accountId: task.account_id };
  await accessibleProject(db, context, task.project_id, true);
  const setting = await row(db, 'SELECT enabled FROM plugin_settings WHERE workspace_id = $1 AND plugin_id = $2', [task.workspace_id, task.plugin_id]);
  if (setting?.enabled === false) throw new ProviderError('PLUGIN_DISABLED');
  if (task.provider_id === 'local') return null;

  const { mode, parameters } = task.input;
  const { assetIds, shopId, listing, guidanceIds, ...providerParameters } = parameters;
  if (task.input.guidedMessages) providerParameters.messages = task.input.guidedMessages;

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
  const assets = ids.length ? await rows(db, 'SELECT id, media_type, data, consent_expires_at FROM assets WHERE workspace_id = $1 AND account_id = $2 AND id = ANY($3::uuid[]) AND NOT rights_restricted', [task.workspace_id, task.account_id, ids]) : [];
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

export async function workOnce({ db, providers, shops, videoArchive, identityDb = db }) {
  const task = await claim(db);
  if (!task) return false;
  if (task.expired) return true;
  const capability = catalog.get(task.capability_id);
  const provider = taskProvider(providers,task.provider_id);
  let result;
  let failure;
  try {
    if (!capability || !provider?.supports(capability)) throw new ProviderError('CAPABILITY_UNAVAILABLE');
    if (provider.signature && task.input.modelSignature !== provider.signature) throw new ProviderError('MODEL_CONFIGURATION_CHANGED');
    if (task.provider_job_id) {
      result = await provider.poll(task.provider_job_id);
    } else {
      const payload = await providerPayload(db, identityDb, task, capability, shops);
      if (provider.signature || provider.nonRepeatable) {
        const marked = await row(db, 'UPDATE tasks SET provider_sent_at = now() WHERE id = $1 AND lease_id = $2 RETURNING id', [task.id, task.lease_id]);
        if (!marked) return true;
      }
      if (task.capability_id==='model.chat' && task.input.parameters.stream===true) {
        if (!provider.streamText) throw new ProviderError('MODEL_STREAM_UNAVAILABLE');
        result=await provider.streamText(payload,(sequence,text)=>appendTaskText(db,task,sequence,text));
      } else result=await provider.run(task,payload);
    }
  } catch (error) {
    if (error instanceof ApiError) failure = new ProviderError(error.code);
    else if (error instanceof ProviderError) failure = error;
    else failure = new ProviderError('TASK_EXECUTION_ERROR', (!provider?.signature && !provider?.nonRepeatable) || Boolean(task.provider_job_id));
  }
  const archive = videoArchive && capability?.pluginId === 'video' && result?.type === 'video' && typeof result.url === 'string'
    ? await videoArchive(result.url) : null;
  if (archive) result = { ...result, archiveStatus: archive.status };

  await db.transaction(async connection => {
    const current = await row(connection, "SELECT * FROM tasks WHERE id = $1 AND lease_id = $2 AND state = 'running' FOR UPDATE", [task.id, task.lease_id]);
    if (!current) return;
    if (result instanceof PendingModelJob || (current.provider_job_id && failure?.retryable && current.poll_failures < maxAttempts - 1)) {
      const jobId = current.provider_job_id ?? result.id;
      await connection.query([
        "UPDATE tasks SET provider_job_id = $2, lease_until = now() + interval '15 seconds', lease_id = NULL,",
        'poll_failures = $3, error_code = $4, updated_at = now() WHERE id = $1',
      ].join(' '), [current.id, jobId, failure ? current.poll_failures + 1 : 0, failure?.code ?? null]);
      if (!current.provider_job_id) await logTask(connection, current.id, 'provider_pending', current.attempts);
      else if (failure) await logTask(connection, current.id, 'retrying', current.attempts, failure.code);
    } else if (!current.provider_job_id && failure?.retryable && current.attempts < maxAttempts) {
      await connection.query([
        "UPDATE tasks SET state = 'queued', lease_id = NULL, lease_until = NULL, provider_sent_at = NULL,",
        "available_at = now() + $2::integer * interval '1 second', error_code = $3, updated_at = now() WHERE id = $1",
      ].join(' '), [current.id, 2 ** current.attempts, failure.code]);
      await logTask(connection, current.id, 'retrying', current.attempts, failure.code);
    } else {
      const file = archive?.file ?? (result instanceof GeneratedFile ? result : null);
      if (file) {
        const assetId = randomUUID();
        const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4' }[file.mediaType];
        await connection.query([
          'INSERT INTO assets (id, workspace_id, account_id, name, media_type, source, purpose, data)',
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        ].join(' '), [assetId, current.workspace_id, current.account_id, current.id + extension, file.mediaType, current.provider_id, current.capability_id, file.bytes]);
        result = { ...(archive ? result : file.result), type: file.mediaType.split('/')[0], modelId: current.input.modelId,
          assetId, mediaType: file.mediaType };
      }
      await finishTask(connection, current, failure ? 'failed' : 'succeeded', result ?? null, failure?.code ?? null);
    }
  });
  return true;
}

function pollDatabase(dependencies,logger,processDatabase,interval) {
  let stopping = false;
  let timer;
  let pending;
  const run = () => {
    if (stopping) return;
    pending = Promise.resolve()
      .then(() => dependencies.resolveDatabase ? dependencies.resolveDatabase() : dependencies.db)
      .then(db => db && processDatabase(db))
      .catch(() => logger.error('Background work could not be processed'))
      .finally(() => {
        if (!stopping) timer = setTimeout(run, interval);
      });
  };
  run();
  return async () => {
    stopping = true;
    clearTimeout(timer);
    await pending;
  };
}

export function startWorker(dependencies, logger) {
  const stopTasks = pollDatabase(dependencies,logger,async db => {
    const scoped = {...dependencies,db};
    const tasks = dispatchSchedule(scoped).then(() => workOnce(scoped));
    const results = await Promise.allSettled(scoped.feishu ? [tasks,dispatchFeishuReply(scoped)] : [tasks]);
    for (const result of results) {
      if (result.status === 'rejected') logger.error('Background work could not be processed');
    }
  },500);
  // Expiring a call must not wait for an unrelated long-running model task.
  const stopVoice = dependencies.realtimeVoice && pollDatabase(dependencies,logger,
    db => maintainRealtimeVoice(db,dependencies.realtimeVoice),1000);
  const stopSms = dependencies.sms && pollDatabase(dependencies,logger,
    db => dispatchSms({...dependencies,db}),1000);
  return async () => { await Promise.all([stopTasks(),stopVoice?.(),stopSms?.()]); };
}
