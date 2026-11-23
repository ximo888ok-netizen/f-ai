import { catalog, plugins } from './catalog.js';
import { row, rows } from './db.js';
import { ApiError, array, bool, choice, invalid, integer, object, route, text, uuid } from './http.js';
import { audit } from './merchant-audit.js';
import { modelProviders } from './merchant-connections.js';
import { matchingProviders } from './providers.js';

export const featurePlugins = [...plugins, { id: 'models', name: '模型工具' }];
const pluginId = choice(...featurePlugins.map(plugin => plugin.id));
const version = { ...text(48), pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$' };
const stages = choice('all', 'trial');
const options = { manager: true, enterprise: true, tags: ['Merchant features'] };

export function featureReleases(input = '[]') {
  const values = typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid merchant feature release catalog');
  const directory = new Map(featurePlugins.map(plugin => [
    plugin.id, [{ version: 'builtin', notes: '当前部署内置能力', capabilities: null }],
  ]));
  for (const value of values) {
    const releases = directory.get(value?.pluginId);
    if (!releases || typeof value.version !== 'string' || !new RegExp(version.pattern).test(value.version) ||
        releases.some(release => release.version === value.version) || typeof value.notes !== 'string' ||
        !value.notes.trim() || value.notes.length > 1000 || !Array.isArray(value.capabilities) ||
        !value.capabilities.length || new Set(value.capabilities).size !== value.capabilities.length ||
        value.capabilities.some(id => catalog.get(id)?.pluginId !== value.pluginId)) {
      throw new Error('Invalid or duplicate merchant feature release');
    }
    releases.push({ version: value.version, notes: value.notes, capabilities: value.capabilities });
  }
  return directory;
}

async function readSettings(db, context, plugin, lock) {
  return row(db, `SELECT enabled,revision,release_mode AS mode,release_version AS version,release_capabilities AS capabilities,
    EXISTS (SELECT 1 FROM merchant_plugin_members m
      WHERE m.workspace_id=s.workspace_id AND m.plugin_id=s.plugin_id AND m.account_id=$3) AS included
    FROM plugin_settings s WHERE workspace_id=$1 AND plugin_id=$2` + (lock ? ' FOR UPDATE OF s' : ''),
  [context.workspaceId, plugin, context.accountId]);
}

export function featureAllowed(state, capability) {
  return state?.enabled !== false && (state?.mode !== 'trial' || state.included) &&
    (!capability || !state?.capabilities || state.capabilities.includes(capability));
}

export async function requireFeature(db, context, plugin, capability, lock = false) {
  if (lock) await db.query('INSERT INTO plugin_settings(workspace_id,plugin_id,enabled) VALUES($1,$2,true) ON CONFLICT DO NOTHING',
    [context.workspaceId, plugin]);
  const state = await readSettings(db, context, plugin, lock);
  if (!featureAllowed(state, capability)) {
    const code = state.enabled === false ? 'PLUGIN_DISABLED' : 'FEATURE_NOT_AVAILABLE';
    throw new ApiError(409, code, 'This capability is unavailable for this member');
  }
  return state?.version ?? 'builtin';
}

function comparePolicy(current, next, members) {
  return current.enabled === next.enabled && current.mode === next.mode && (current.version ?? 'builtin') === next.version &&
    JSON.stringify(current.capabilities) === JSON.stringify(next.capabilities) &&
    members.join(',') === next.memberIds.join(',');
}

export async function updateFeature(db, request, directory, legacy = false) {
  const { workspaceId } = request.context;
  const plugin = request.params.id;
  return db.transaction(async tx => {
    await tx.query('INSERT INTO plugin_settings(workspace_id,plugin_id,enabled) VALUES($1,$2,true) ON CONFLICT DO NOTHING', [workspaceId, plugin]);
    const current = await readSettings(tx, request.context, plugin, true);
    if (request.body.revision !== undefined && request.body.revision !== current.revision) {
      throw new ApiError(409, 'FEATURE_CHANGED', 'The feature policy changed. Reload before retrying');
    }
    const { enabled } = request.body;
    const members = (await rows(tx, `SELECT account_id AS id FROM merchant_plugin_members
      WHERE workspace_id=$1 AND plugin_id=$2 ORDER BY account_id`, [workspaceId, plugin])).map(member => member.id);
    const chosen = legacy ? { mode: current.mode, version: current.version ?? 'builtin', capabilities: current.capabilities, memberIds: members }
      : { ...request.body, memberIds: request.body.memberIds.map(id => id.toLowerCase()).sort() };
    if (!legacy) {
      const release = directory.get(plugin).find(item => item.version === chosen.version);
      if (!release) throw invalid('Select a provisioned feature release');
      chosen.capabilities = release.capabilities;
      if ((chosen.mode === 'trial') !== Boolean(chosen.memberIds.length)) throw invalid('Trial mode requires at least one trial member');
      if (new Set(chosen.memberIds).size !== chosen.memberIds.length) throw invalid('Trial member IDs must be unique');
      const active = await row(tx, `SELECT count(*)::int AS total FROM memberships
        WHERE workspace_id=$1 AND state='active' AND account_id=ANY($2::uuid[])`, [workspaceId, chosen.memberIds]);
      if (active.total !== chosen.memberIds.length) throw invalid('A trial member is unavailable in this workspace');
    }
    const next = { ...chosen, enabled };
    if (comparePolicy(current, next, members)) return { id: plugin, enabled, revision: current.revision };
    const { revision } = await row(tx, `UPDATE plugin_settings SET enabled=$3,release_mode=$4,release_version=$5,release_capabilities=$6,revision=revision+1
      WHERE workspace_id=$1 AND plugin_id=$2 RETURNING revision`,
    [workspaceId, plugin, enabled, next.mode, next.version, next.capabilities ? JSON.stringify(next.capabilities) : null]);
    if (!legacy) {
      await tx.query('DELETE FROM merchant_plugin_members WHERE workspace_id=$1 AND plugin_id=$2', [workspaceId, plugin]);
      await tx.query(`INSERT INTO merchant_plugin_members(workspace_id,plugin_id,account_id)
        SELECT $1,$2,id FROM unnest($3::uuid[]) ids(id)`, [workspaceId, plugin, next.memberIds]);
    }
    await audit(tx, request, 'workspace', 'feature.policy-changed', plugin, {
      previous: { enabled: current.enabled, mode: current.mode, version: current.version ?? 'builtin', members },
      current: { enabled, mode: next.mode, version: next.version, members: next.memberIds },
    });
    return { id: plugin, enabled, revision };
  });
}

export function registerMerchantFeatures(app, db, providers, directory) {
  route(app, 'GET', '/v1/merchant/features', { ...options, summary: 'List workspace feature policies and published releases' }, async request => {
    const { workspaceId } = request.context;
    const [settings, available] = await Promise.all([
      rows(db, `SELECT s.plugin_id AS id,s.enabled,s.revision,s.release_mode AS mode,COALESCE(s.release_version,'builtin') AS version,
        ARRAY(SELECT m.account_id FROM merchant_plugin_members m
          WHERE m.workspace_id=s.workspace_id AND m.plugin_id=s.plugin_id ORDER BY m.account_id) AS "memberIds"
        FROM plugin_settings s WHERE s.workspace_id=$1`, [workspaceId]),
      modelProviders(db, workspaceId, providers),
    ]);
    const byId = new Map(settings.map(setting => [setting.id, setting]));
    return { items: featurePlugins.map(plugin => ({
      ...plugin, enabled: true, revision: 0, mode: 'all', version: 'builtin', memberIds: [], ...byId.get(plugin.id),
      releases: directory.get(plugin.id),
      provisioned: [...catalog.values()].some(capability => capability.pluginId === plugin.id &&
        (capability.execution === 'endpoint' || matchingProviders(available, capability).length > 0)),
    })) };
  });

  route(app, 'PUT', '/v1/merchant/features/:id', {
    ...options, summary: 'Set feature availability and trial membership',
    params: object({ id: pluginId }),
    body: object({ enabled: bool, mode: stages, version, revision: integer(0, 2147483646),
      memberIds: { ...array(uuid, 100), uniqueItems: true } }),
    response: { 200: object({ id: pluginId, enabled: bool, revision: integer(0, 2147483647) }) },
  }, request => updateFeature(db, request, directory));
}
