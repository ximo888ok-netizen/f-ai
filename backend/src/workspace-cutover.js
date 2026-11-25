import { randomUUID } from 'node:crypto';
import { checkMigrations, migrationFiles, row, rows } from './db.js';
import { syncWorkspaceIdentity } from './workspace-database.js';

const byWorkspace = 'workspace_id=$1';
const related = (column, parent) => column + ' IN (SELECT id FROM ' + parent + ' WHERE workspace_id=$1)';
const segments = [
  ['wallets'], ['ledger'], ['projects'], ['project_members'],
  ['knowledge_bases'], ['knowledge_grants'], ['knowledge_categories'], ['documents'], ['document_chunks',related('document_id','documents')],
  ['assets'], ['plugin_settings'], ['tasks'], ['task_events',related('task_id','tasks')], ['task_text_chunks',related('task_id','tasks')],
  ['notifications'], ['account_settings'], ['memory_items'], ['shop_previews'],
  ['desk_shops'], ['service_conversations'], ['service_messages'], ['service_replies'], ['schedules'],
  ['studio_categories'], ['studio_products'], ['studio_transfers'],
  ['listing_drafts'], ['listing_draft_images',related('draft_id','listing_drafts')], ['listing_draft_variants',related('draft_id','listing_drafts')],
  ['operation_books'], ['operation_records',related('book_id','operation_books')], ['inventory_draft_imports',related('book_id','operation_books')],
  ['workspace_library_entries'], ['workspace_library_builtin_state'], ['workspace_feedback'], ['studio_psd_documents'],
  ['asset_cloud_copies'], ['feishu_messages'], ['feishu_replies'], ['rights_notices'], ['rights_notice_events'], ['studio_image_batches'], ['studio_video_storyboards'],
  ['workspace_copywriting_rules'], ['merchant_plugin_members'], ['merchant_connections'],
  ['merchant_events',"workspace_id=$1 AND scope='workspace'"],
].map(([table, filter = byWorkspace]) => ({table,filter}));
const identityTables = ['migrations','workspaces','accounts','memberships','sessions','invitations',
  'workspace_database_routes','workspace_identity_events','dedicated_database_identity'];
const expectedTables = [...segments.map(({table})=>table),...identityTables].sort();
const sequences = ['ledger','task_events','notifications','service_messages'];

async function compatible(db, names) {
  const tables = await rows(db,`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()
    AND table_type='BASE TABLE' ORDER BY table_name COLLATE "C"`);
  if (!(await checkMigrations(db,names)) || tables.map(t=>t.table_name).join(',') !== expectedTables.join(',') ||
      (await row(db,'SELECT count(*)::int AS count FROM migrations')).count !== names.length) {
    throw new Error('Run the same application migrations on both databases before cutover');
  }
}

async function assertEmpty(target) {
  // Account/workspace rows and route markers identify initialized databases.
  const state = await row(target,`SELECT EXISTS(SELECT 1 FROM accounts) OR EXISTS(SELECT 1 FROM workspaces)
    OR EXISTS(SELECT 1 FROM dedicated_database_identity) AS occupied`);
  if (state.occupied) throw new Error('The selected target database already belongs to a workspace');
}

async function count(db, segment, workspaceId) {
  return (await row(db,`SELECT count(*)::int AS count FROM ${segment.table} WHERE ${segment.filter}`,[workspaceId])).count;
}

async function fingerprint(db,{table,filter},workspaceId) {
  return (await row(db,`SELECT encode(sha256(convert_to(COALESCE(string_agg(digest,'' ORDER BY digest),''),'UTF8')),'hex') AS digest
    FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest
      FROM ${table} t WHERE ${filter}) encoded`,[workspaceId])).digest;
}

async function copySegment(source,target,segment,workspaceId,expected) {
  const {table,filter} = segment;
  const take = table === 'assets' ? 1 : 40;
  // Parent tasks must be inserted before their descendants for the self-reference.
  const sourceSql = table === 'tasks' ? `
    WITH RECURSIVE tree AS (
      SELECT id,0 AS depth FROM tasks WHERE workspace_id=$1 AND parent_id IS NULL
      UNION ALL SELECT t.id, tree.depth+1 FROM tasks t JOIN tree ON t.parent_id=tree.id WHERE t.workspace_id=$1
    )
    SELECT t AS record FROM tree JOIN tasks t USING(id) ORDER BY tree.depth,t.id LIMIT $2 OFFSET $3
  ` : `SELECT t AS record FROM ${table} t WHERE ${filter} ORDER BY t.ctid LIMIT $2 OFFSET $3`;
  for (let offset=0; offset<expected; offset+=take) {
    const batch = await row(source,`SELECT jsonb_agg(to_jsonb(batch.record))::text AS data FROM (${sourceSql}) batch`,
      [workspaceId,take,offset]);
    if (!batch?.data) throw new Error('The workspace data changed during copy');
    await target.query(`INSERT INTO ${table} OVERRIDING SYSTEM VALUE
      SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[batch.data]);
  }
}

export async function cutoverWorkspace(control,target,workspaceId,databaseKey) {
  if (control === target) throw new Error('The control and dedicated databases must be separate');
  const migrations = await migrationFiles();
  await compatible(control,migrations);
  await compatible(target,migrations);

  // Preparation is durable. It prevents API/worker fallback after an interrupted copy.
  await control.transaction(async source => {
    const workspace = await row(source,'SELECT kind FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
    if (workspace?.kind !== 'enterprise') throw new Error('An existing enterprise workspace is required');
    const active = await row(source,`SELECT database_key,binding_id,state FROM workspace_database_routes
      WHERE workspace_id=$1`,[workspaceId]);
    if (active) {
      if (active.database_key !== databaseKey) throw new Error('This workspace is already assigned to another database');
      return;
    }
    await assertEmpty(target);
    await source.query(`INSERT INTO workspace_database_routes(workspace_id,database_key,binding_id,state)
      VALUES($1,$2,$3,'preparing')`,[workspaceId,databaseKey,randomUUID()]);
  });

  return control.transaction(async source => {
    await source.query("SET LOCAL TIME ZONE 'UTC'");
    const binding = await row(source,`SELECT binding_id,state FROM workspace_database_routes
      WHERE workspace_id=$1 AND database_key=$2 FOR UPDATE`,[workspaceId,databaseKey]);
    if (!binding) throw new Error('The prepared workspace route was not found');
    const {binding_id:bindingId} = binding;

    const copied = await target.transaction(async destination => {
      await destination.query("SET LOCAL TIME ZONE 'UTC'");
      const marker = await row(destination,'SELECT workspace_id,binding_id FROM dedicated_database_identity WHERE singleton=true FOR UPDATE');
      if (marker && (marker.workspace_id !== workspaceId || marker.binding_id !== bindingId)) {
        throw new Error('The selected target database has a different workspace binding');
      }
      if (binding.state === 'active') {
        if (!marker) throw new Error('The configured database is missing the active binding marker');
        return null;
      }

      if (!marker) {
        await assertEmpty(destination);
        await syncWorkspaceIdentity(source,destination,workspaceId,false);
      }
      const totals = [];
      for (const segment of segments) {
        const expected = await count(source,segment,workspaceId);
        if (!marker) await copySegment(source,destination,segment,workspaceId,expected);
        if ((await count(destination,segment,workspaceId)) !== expected) {
          throw new Error('The copied workspace record counts differ from the source');
        }
        if (expected && await fingerprint(source,segment,workspaceId) !== await fingerprint(destination,segment,workspaceId)) {
          throw new Error('The copied workspace record checksums differ from the source');
        }
        totals.push(expected);
      }
      if (!marker) {
        for (const table of sequences) {
          await destination.query(`SELECT setval(pg_get_serial_sequence($1,'id'),COALESCE(max(id),1),count(*)>0) FROM ${table}`,[table]);
        }
        await destination.query(`INSERT INTO dedicated_database_identity(singleton,workspace_id,binding_id)
          VALUES(true,$1,$2)`,[workspaceId,bindingId]);
      }
      return totals;
    });

    if (!copied) return { state:'active', alreadyActive:true };
    // Commit the complete, verified target before removing any source business rows.
    for (let i=segments.length-1;i>=0;i--) {
      const {table,filter} = segments[i];
      const removed = await row(source,`WITH removed AS (DELETE FROM ${table} WHERE ${filter} RETURNING 1)
        SELECT count(*)::int AS count FROM removed`,[workspaceId]);
      if (removed.count !== copied[i]) throw new Error('The workspace data changed during cutover');
    }
    await source.query("UPDATE workspace_database_routes SET state='active' WHERE workspace_id=$1",[workspaceId]);
    return { state:'active', rows:copied.reduce((sum,value)=>sum+value,0) };
  });
}
