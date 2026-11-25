import { row } from './db.js';
import { ApiError } from './http.js';

export async function pluginEnabled(db, workspaceId, pluginId) {
  const setting = await row(db, 'SELECT enabled FROM plugin_settings WHERE workspace_id=$1 AND plugin_id=$2', [workspaceId,pluginId]);
  return setting?.enabled !== false;
}

export async function requirePlugin(db, workspaceId, pluginId) {
  if (!(await pluginEnabled(db,workspaceId,pluginId))) throw disabled();
}

const disabled = () => new ApiError(409,'PLUGIN_DISABLED','Plugin is disabled for this workspace');

// Use a transaction when accepting new work so a simultaneous disable is ordered with it.
export async function lockPlugin(db, workspaceId, pluginId) {
  const key = [workspaceId,pluginId];
  await db.query('INSERT INTO plugin_settings(workspace_id,plugin_id,enabled) VALUES($1,$2,true) ON CONFLICT DO NOTHING',key);
  const setting = await row(db,'SELECT enabled FROM plugin_settings WHERE workspace_id=$1 AND plugin_id=$2 FOR SHARE',key);
  if (!setting.enabled) throw disabled();
}
