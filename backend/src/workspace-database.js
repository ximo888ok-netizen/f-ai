import { AsyncLocalStorage } from 'node:async_hooks';
import { checkMigrations, row, rows } from './db.js';
import { ApiError } from './http.js';
import { notify } from './notifications.js';

const unavailable = () => new ApiError(503,'WORKSPACE_DATABASE_UNAVAILABLE','The configured enterprise database is unavailable');
const routeFields = 'workspace_id AS "workspaceId",database_key AS "databaseKey",binding_id AS "bindingId",state';

export async function assertControlDatabase(db) {
  if (await row(db,'SELECT 1 FROM dedicated_database_identity WHERE singleton=true')) {
    throw new Error('DATABASE_URL points to a dedicated workspace database');
  }
}

export async function syncWorkspaceIdentity(control, target, workspaceId, createWallets = true) {
  const workspace = await row(control,'SELECT kind,name,created_at FROM workspaces WHERE id=$1',[workspaceId]);
  if (workspace?.kind !== 'enterprise') throw unavailable();
  await target.query(`INSERT INTO workspaces(id,kind,name,created_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE workspaces.name IS DISTINCT FROM excluded.name`,
  [workspaceId,workspace.kind,workspace.name,workspace.created_at]);
  const members = await rows(control,`SELECT a.id,a.email,a.display_name,a.account_type,a.created_at,
    m.role,m.state,m.created_at AS member_since FROM memberships m JOIN accounts a ON a.id=m.account_id
    WHERE m.workspace_id=$1 ORDER BY a.id`,[workspaceId]);
  // Only directory fields are copied. Password hashes and sessions remain in the control database.
  const data = JSON.stringify(members);
  await target.query(`WITH directory AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(id uuid,email text,display_name text,account_type text,created_at timestamptz)
    ) INSERT INTO accounts(id,email,password_hash,display_name,account_type,created_at)
    SELECT id,email,'managed-by-control-database',display_name,account_type,created_at FROM directory
    ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,account_type=excluded.account_type
    WHERE (accounts.email,accounts.display_name,accounts.account_type) IS DISTINCT FROM
      (excluded.email,excluded.display_name,excluded.account_type)`,[data]);
  await target.query(`WITH directory AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS d(id uuid,role text,state text,member_since timestamptz)
    ) INSERT INTO memberships(workspace_id,account_id,role,state,created_at)
    SELECT $1,id,role,state,member_since FROM directory ON CONFLICT(workspace_id,account_id)
    DO UPDATE SET role=excluded.role,state=excluded.state
    WHERE (memberships.role,memberships.state) IS DISTINCT FROM (excluded.role,excluded.state)`,[workspaceId,data]);
  if (createWallets) await target.query(`INSERT INTO wallets(workspace_id,account_id)
    SELECT workspace_id,account_id FROM memberships WHERE workspace_id=$1 ON CONFLICT DO NOTHING`,[workspaceId]);
}

export async function recordMemberEvent(db, workspaceId, accountId, type, key, data) {
  const bound = await row(db,'SELECT 1 FROM workspace_database_routes WHERE workspace_id=$1',[workspaceId]);
  if (!bound) return notify(db,workspaceId,accountId,'member',type,key,data);
  // Serialize inserts so the per-workspace delivery cursor observes commit order.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),832156)',[workspaceId]);
  await db.query('INSERT INTO workspace_identity_events(workspace_id,account_id,type,event_key,data) VALUES($1,$2,$3,$4,$5)',
    [workspaceId,accountId,type,key,data]);
}

async function deliverIdentityEvents(control, target, workspaceId, after, through) {
  const pending = await rows(control,`SELECT id::text,account_id,type,event_key,data FROM workspace_identity_events
    WHERE workspace_id=$1 AND id>$2 AND id<=$3 ORDER BY workspace_identity_events.id LIMIT 200`,[workspaceId,after,through]);
  for (const event of pending) {
    await notify(target,workspaceId,event.account_id,'member',event.type,event.event_key,event.data);
  }
  if (pending.length) {
    await target.query('UPDATE dedicated_database_identity SET delivered_event=$1 WHERE singleton=true',[pending.at(-1).id]);
  }
}

export function workspaceDatabaseRouter(control, databases, migrations) {
  const scope = new AsyncLocalStorage();
  const opening = new Map();
  const current = () => scope.getStore() ?? control;
  const db = {
    query: (...args) => current().query(...args),
    transaction: (...args) => current().transaction(...args),
  };

  async function open(binding) {
    if (binding.state !== 'active') throw unavailable();
    const key = JSON.stringify([binding.databaseKey, binding.workspaceId, binding.bindingId]);
    const pending = opening.get(key);
    if (pending) return pending;
    const transaction = validateAndSync(binding);
    opening.set(key, transaction);
    try {
      return await transaction;
    } finally {
      opening.delete(key);
    }
  }

  async function validateAndSync(binding) {
    const target = databases.get(binding.databaseKey);
    if (!target || target === control) throw unavailable();
    const args = [binding.workspaceId, binding.bindingId];
    const identityQuery = `SELECT delivered_event::text, identity_synced FROM dedicated_database_identity
      WHERE singleton=true AND workspace_id=$1 AND binding_id=$2
      AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id<>$1)`;
    try {
      if (!(await checkMigrations(target, migrations))) throw unavailable();
      const identity = await row(target, identityQuery, args);
      if (!identity) throw unavailable();
      // Membership changes append identity events in the same control transaction.
      const newest = await row(control, `SELECT id::text FROM workspace_identity_events
        WHERE workspace_id=$1 ORDER BY workspace_identity_events.id DESC LIMIT 1`, [binding.workspaceId]);
      const through = newest?.id ?? '0';
      if (identity.identity_synced && identity.delivered_event === through) return target;

      await target.transaction(async tx => {
        const locked = await row(tx, identityQuery + ' FOR UPDATE', args);
        if (!locked) throw unavailable();
        if (locked.identity_synced && locked.delivered_event === through) return;
        await syncWorkspaceIdentity(control, tx, binding.workspaceId);
        // Do not advance past events committed after the member snapshot began.
        await deliverIdentityEvents(control, tx, binding.workspaceId, locked.delivered_event, through);
        if (!locked.identity_synced) {
          await tx.query('UPDATE dedicated_database_identity SET identity_synced=true WHERE singleton=true');
        }
      });
    } catch {
      throw unavailable();
    }
    return target;
  }

  return {
    db,
    async binding(workspaceId) {
      return row(control,'SELECT '+routeFields+' FROM workspace_database_routes WHERE workspace_id=$1',[workspaceId]);
    },
    async forWorkspace(workspaceId) {
      const binding = await this.binding(workspaceId);
      return binding ? open(binding) : control;
    },
    async status(workspaceId) {
      const binding = await this.binding(workspaceId);
      if (!binding) return {mode:'shared',state:'ready'};
      if (binding.state === 'preparing') return {mode:'dedicated',state:'preparing'};
      try {
        await open(binding);
        return {mode:'dedicated',state:'ready'};
      } catch {
        return {mode:'dedicated',state:'unavailable'};
      }
    },
    async workerDatabase(databaseKey) {
      const binding = await row(control,`SELECT ${routeFields} FROM workspace_database_routes
        WHERE database_key=$1 AND state='active'`,[databaseKey]);
      return binding ? open(binding) : null;
    },
    async run(workspaceId, handler) {
      return scope.run(await this.forWorkspace(workspaceId),handler);
    },
  };
}
