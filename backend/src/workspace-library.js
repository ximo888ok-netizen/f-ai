import { randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, array, bool, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { builtinEntries } from './library-defaults.js';

const root = '/v1/library';
const tags = ['Expert and skill library'];
const kinds = ['skill','expert','team'];
const idParams = object({ id: uuid });
const revision = integer(1, 2147483646);
const relatedIds = { ...array(uuid, 6), uniqueItems: true };
const definition = { name: text(100), description: text(500,0), instructions: text(2000), relatedIds };
const record = object({ ...definition, id: uuid, kind: choice(...kinds), builtin: bool, enabled: bool,
  revision, updatedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] } });
const columns = 'id, kind, name, description, instructions, related_ids AS "relatedIds", enabled, revision, updated_at AS "updatedAt", false AS builtin';
const limit = 200;
const conflict = message => new ApiError(409, 'LIBRARY_CONFLICT', message);

async function libraryEntries(db, workspace) {
  const custom = await rows(db, 'SELECT ' + columns + ' FROM workspace_library_entries WHERE workspace_id=$1 ORDER BY updated_at DESC,id', [workspace]);
  const states = await rows(db, 'SELECT entry_id, enabled FROM workspace_library_builtin_state WHERE workspace_id=$1', [workspace]);
  const enabled = new Map(states.map(state => [state.entry_id, state.enabled]));
  return [...builtinEntries.map(entry => ({
    ...entry, builtin: true, enabled: enabled.get(entry.id) ?? true, revision: 1, updatedAt: null,
  })), ...custom];
}

function findEntry(entries, id) {
  const entry = entries.find(record => record.id === id.toLowerCase());
  if (!entry) throw notFound('Library entry');
  return entry;
}

function validateDefinition(kind, body, entries, id) {
  const name = body.name.trim();
  const instructions = body.instructions.trim();
  if (!name || !instructions) throw invalid('Name and instructions cannot be blank');
  const relations = body.relatedIds.map(value => value.toLowerCase());
  if (new Set(relations).size !== relations.length) throw invalid('Related entries must be unique');
  if (kind === 'skill' && relations.length) throw invalid('Skills cannot reference other entries');
  if (kind === 'team' && !relations.length) throw invalid('An expert team must include at least one expert');
  for (const value of relations) {
    const related = findEntry(entries, value);
    if (related.kind !== (kind === 'team' ? 'expert' : 'skill')) throw invalid('Invalid related entry type');
  }
  if (entries.some(entry => entry.id !== id && entry.kind === kind && entry.name.toLowerCase() === name.toLowerCase())) {
    throw conflict('An entry of this type already has that name');
  }
  return [name, body.description.trim(), instructions, relations];
}

async function updateLibrary(db, workspace, action) {
  return db.transaction(async tx => {
    await row(tx, 'SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace]);
    return action(tx, await libraryEntries(tx, workspace));
  });
}

export async function guidedMessages(db, workspace, ids, messages) {
  const entries = await libraryEntries(db, workspace);
  const guidance = new Map();
  function select(id) {
    if (guidance.has(id.toLowerCase())) return;
    const entry = findEntry(entries, id);
    if (!entry.enabled) throw new ApiError(409, 'LIBRARY_DISABLED', 'A selected expert or skill is disabled');
    guidance.set(entry.id, entry);
    for (const related of entry.relatedIds) select(related);
  }
  for (const id of ids) select(id);
  const instructions = [...guidance.values()].map(entry => entry.name + ':\n' + entry.instructions).join('\n\n');
  const [first, ...rest] = messages;
  const hasSystem = first.role === 'system';
  const content = instructions + (hasSystem ? '\n\n' + first.content : '');
  if (Array.from(content).length > 8000 || (!hasSystem && messages.length === 32)) {
    throw invalid('Combined guidance and chat messages exceed the conversation limit');
  }
  return [{ role: 'system', content }, ...(hasSystem ? rest : messages)];
}

export function registerWorkspaceLibrary(app, db) {
  route(app, 'GET', root, { tags, summary: 'Search experts, teams and skills in the current workspace',
    querystring: object({ ...page.properties, kind: choice(...kinds), q: text(100), enabled: bool }, []),
    response: { 200: object({ items: array(record,100) }) } }, async request => {
    const { kind, q, enabled } = request.query;
    const [take, skip] = paginate(request.query);
    const query = q?.trim().toLowerCase();
    const entries = await libraryEntries(db, request.context.workspaceId);
    return { items: entries.filter(entry => (!kind || kind === entry.kind) && (enabled === undefined || enabled === entry.enabled) &&
      (!query || (entry.name + ' ' + entry.description).toLowerCase().includes(query))).slice(skip,skip+take) };
  });

  route(app, 'GET', root + '/:id', { tags, summary: 'Read a workspace library entry', params: idParams,
    response: {200: record} }, async request => findEntry(await libraryEntries(db, request.context.workspaceId), request.params.id));

  route(app, 'POST', root, { tags, manager: true, summary: 'Create a workspace expert, team or skill',
    body: object({ kind: choice(...kinds), ...definition }), response: {201: record} }, async (request, reply) => {
    const workspace = request.context.workspaceId;
    const { kind } = request.body;
    const entry = await updateLibrary(db, workspace, async (tx, entries) => {
      if (entries.length >= limit + builtinEntries.length) throw conflict('Workspace library is full');
      const values = validateDefinition(kind, request.body, entries);
      return row(tx, `INSERT INTO workspace_library_entries(workspace_id,id,kind,name,description,instructions,related_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`, [workspace,randomUUID(),kind,...values]);
    });
    reply.code(201);
    return entry;
  });

  route(app, 'PUT', root + '/:id', { tags, manager: true, summary: 'Edit a custom workspace library entry',
    params: idParams, body: object({ ...definition, revision }), response: {200: record} }, request => {
    const workspace = request.context.workspaceId;
    return updateLibrary(db, workspace, async (tx, entries) => {
      const entry = findEntry(entries, request.params.id);
      if (entry.builtin) throw conflict('Built-in entries can be enabled or disabled');
      if (entry.revision !== request.body.revision) throw conflict('The library entry changed; reload before editing');
      const values = validateDefinition(entry.kind, request.body, entries, entry.id);
      return row(tx, `UPDATE workspace_library_entries SET name=$3,description=$4,instructions=$5,related_ids=$6,
        revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING ${columns}`, [workspace,entry.id,...values]);
    });
  });

  route(app, 'PUT', root + '/:id/state', { tags, manager: true, summary: 'Enable or disable a library entry',
    params: idParams, body: object({ enabled: bool }), response: {200: record} }, request => {
    const workspace = request.context.workspaceId;
    return updateLibrary(db, workspace, async (tx, entries) => {
      const entry = findEntry(entries, request.params.id);
      const { enabled } = request.body;
      if (entry.enabled === enabled) return entry;
      if (entry.builtin) {
        await tx.query(`INSERT INTO workspace_library_builtin_state(workspace_id,entry_id,enabled) VALUES($1,$2,$3)
          ON CONFLICT(workspace_id,entry_id) DO UPDATE SET enabled=excluded.enabled`, [workspace,entry.id,enabled]);
        return { ...entry, enabled };
      }
      return row(tx, `UPDATE workspace_library_entries SET enabled=$3,revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND id=$2 RETURNING ${columns}`, [workspace,entry.id,enabled]);
    });
  });

  route(app, 'DELETE', root + '/:id', { tags, manager: true, summary: 'Delete an unreferenced custom library entry',
    params: idParams, response: {204: {type:'null'}} }, async (request, reply) => {
    const workspace = request.context.workspaceId;
    await updateLibrary(db, workspace, async (tx, entries) => {
      const entry = findEntry(entries, request.params.id);
      if (entry.builtin || entries.some(record => record.relatedIds.includes(entry.id))) {
        throw conflict('The entry is built in or still referenced by another entry');
      }
      await tx.query('DELETE FROM workspace_library_entries WHERE workspace_id=$1 AND id=$2', [workspace,entry.id]);
    });
    reply.code(204).send();
  });
}
