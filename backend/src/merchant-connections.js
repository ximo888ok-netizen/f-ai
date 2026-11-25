import { row, rows } from './db.js';
import { ApiError, bool, choice, integer, notFound, object, route, text } from './http.js';
import { audit } from './merchant-audit.js';

const kinds = choice('model', 'shop', 'feishu', 'webdav');
const params = object({ kind: kinds, id: { ...text(100), pattern: '^[A-Za-z0-9_-]+$' } });
const options = { manager: true, enterprise: true, tags: ['Merchant connections'] };
const columns = 'kind,connector_id AS id,enabled,revision,check_state AS "checkState",checked_at AS "checkedAt"';

export function shopGrantExpired(shop) {
  return shop.authorizedUntil != null && Date.parse(shop.authorizedUntil) <= Date.now();
}

function provisioned({ providers, shops, cloudAssets, feishu, integrations }, workspaceId) {
  const items = [];
  for (const provider of providers.values()) {
    if (provider.info && (!provider.availableIn||provider.availableIn(workspaceId))) items.push({ kind: 'model', id: provider.info.id, name: provider.info.name ?? provider.info.id });
  }
  const includedShops = new Set();
  for (const bindings of [shops, integrations?.customer?.shops, integrations?.commerce?.shops]) {
    for (const shop of bindings?.values() ?? []) {
      if (shop.workspaceId !== workspaceId || includedShops.has(shop.id)) continue;
      includedShops.add(shop.id);
      items.push({ kind: 'shop', id: shop.id, name: shop.name, platform: shop.platform });
    }
  }
  for (const binding of feishu.values()) {
    if (binding.workspaceId === workspaceId) items.push({ kind: 'feishu', id: binding.id, name: '飞书应用 ' + binding.id, check: binding.check });
  }
  const store = cloudAssets.get(workspaceId.toLowerCase());
  if (store) items.push({ kind: 'webdav', id: 'workspace', name: '工作区 WebDAV', check: store.check });
  return items;
}

async function connectionStates(db, workspace) {
  return rows(db, 'SELECT ' + columns + ' FROM merchant_connections WHERE workspace_id=$1', [workspace]);
}

export async function connectionEnabled(db, workspace, kind, id) {
  const state = await row(db, 'SELECT enabled FROM merchant_connections WHERE workspace_id=$1 AND kind=$2 AND connector_id=$3',
    [workspace, kind, id]);
  return state?.enabled !== false;
}

export async function requireConnection(db, workspace, kind, id) {
  if (!await connectionEnabled(db, workspace, kind, id)) {
    throw new ApiError(409, 'CONNECTION_DISABLED', 'This workspace has disconnected the integration');
  }
}

export async function modelProviders(db, workspace, providers) {
  const disabled = await rows(db, "SELECT connector_id AS id FROM merchant_connections WHERE workspace_id=$1 AND kind='model' AND NOT enabled", [workspace]);
  const unavailable = new Set(disabled.map(item => 'model:' + item.id));
  return new Map([...providers].filter(([id,p]) => !unavailable.has(id) && (!p.availableIn || p.availableIn(workspace))));
}

function selectConnection(config, request) {
  if (request.context.role !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Workspace owner required');
  const { kind, id } = request.params;
  const target = provisioned(config, request.context.workspaceId).find(item => item.kind === kind && item.id === id);
  if (!target) throw notFound('Provisioned connection');
  return target;
}

async function lockState(tx, workspace, { kind, id }) {
  const key = [workspace, kind, id];
  await tx.query('INSERT INTO merchant_connections(workspace_id,kind,connector_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', key);
  return row(tx, 'SELECT ' + columns + ' FROM merchant_connections WHERE workspace_id=$1 AND kind=$2 AND connector_id=$3 FOR UPDATE', key);
}

export function registerMerchantConnections(app, db, config) {
  const base = '/v1/merchant/connections';
  route(app, 'GET', base, { ...options, summary: 'Read approved workspace integrations' }, async request => {
    const workspace = request.context.workspaceId;
    const settings = new Map((await connectionStates(db, workspace)).map(state => [state.kind + ':' + state.id, state]));
    return { items: provisioned(config, workspace).map(({ check, ...item }) => ({
      ...item, enabled: true, revision: 0, checkState: 'unverified', checkedAt: null, ...settings.get(item.kind + ':' + item.id),
      canCheck: typeof check === 'function',
    })) };
  });
  route(app, 'POST', base + '/:kind/:id/check', {
    ...options, params, summary: 'Check configured connector authentication without modifying external data',
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async request => {
    const target = selectConnection(config, request);
    if (!target.check) throw new ApiError(409, 'CONNECTION_CHECK_UNAVAILABLE', 'This integration has no read-only probe');
    const workspace = request.context.workspaceId;
    const started = await db.transaction(tx => lockState(tx, workspace, target));
    let result = 'reachable';
    try { await target.check(); } catch { result = 'failed'; }
    return db.transaction(async tx => {
      const key = [workspace, target.kind, target.id];
      const saved = await row(tx, `UPDATE merchant_connections SET check_state=$4,checked_at=now(),revision=revision+1
        WHERE workspace_id=$1 AND kind=$2 AND connector_id=$3 AND revision=$5 RETURNING ` + columns,
      [...key, result, started.revision]);
      if (!saved) throw new ApiError(409, 'CONNECTION_CHANGED', 'The connection changed during the check');
      await audit(tx, request, 'workspace', 'connection.checked', target.kind + ':' + target.id, { result });
      return saved;
    });
  });
  route(app, 'PUT', base + '/:kind/:id', {
    ...options, params, body: object({ enabled: bool, revision: integer(0, 2147483646) }),
    summary: 'Connect or disconnect an operator-provisioned integration',
  }, request => {
    const target = selectConnection(config, request);
    const workspace = request.context.workspaceId;
    return db.transaction(async tx => {
      const current = await lockState(tx, workspace, target);
      const { enabled, revision } = request.body;
      if (current.revision !== revision) throw new ApiError(409, 'CONNECTION_CHANGED', 'Reload before changing this connection');
      if (enabled === current.enabled) return current;
      const recentCheck = current.checkState === 'reachable' && Date.now() - new Date(current.checkedAt).getTime() < 15 * 60 * 1000;
      if (enabled && target.check && !recentCheck) {
        throw new ApiError(409, 'CONNECTION_CHECK_REQUIRED', 'Check the connection before enabling it');
      }
      const saved = await row(tx, `UPDATE merchant_connections SET enabled=$4,revision=revision+1
        WHERE workspace_id=$1 AND kind=$2 AND connector_id=$3 RETURNING ` + columns, [workspace, target.kind, target.id, enabled]);
      await audit(tx, request, 'workspace', 'connection.state-changed', target.kind + ':' + target.id, { enabled });
      return saved;
    });
  });
}
