
import { randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ensureKnowledgeCategory, lockKnowledgeBase, registerKnowledgeCategories } from './knowledge-categories.js';
import { array, invalid, notFound, object, page, paginate, requireEnterprise, route, text, uuid } from './http.js';

const idParams = object({ id: uuid });
const knowledgeTags = ['Knowledge'];
const manager = context => context.role !== 'member';
const baseFields = 'id, name, created_at AS "createdAt"';
const documentFields = 'id, name, category, created_at AS "createdAt"';
const documentParams = object({ id: uuid, documentId: uuid });
const documentPatch = object({ name:text(200),category:text(100,0),content:text(200000) },[]);

function requiredText(value) {
  const trimmed = value.trim();
  if (!trimmed) throw invalid('Text cannot be blank');
  return trimmed;
}

async function memberIn(db, workspaceId, accountId) {
  if (!(await row(db, 'SELECT 1 FROM memberships WHERE workspace_id = $1 AND account_id = $2', [workspaceId, accountId]))) {
    throw notFound('Workspace member');
  }
}

async function accessibleBase(db, context, baseId) {
  const result = await row(db, [
    'SELECT ' + baseFields + ' FROM knowledge_bases b WHERE workspace_id = $1 AND id = $2',
    'AND ($3::boolean OR EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.base_id = b.id AND g.account_id = $4))',
  ].join(' '), [context.workspaceId, baseId, manager(context), context.accountId]);
  if (!result) throw notFound('Knowledge base');
  return result;
}

function splitDocument(value) {
  const points = Array.from(value);
  const chunks = [];
  for (let i = 0; i < points.length; i += 900) {
    chunks.push(points.slice(i, i + 1000).join(''));
    if (i + 1000 >= points.length) break;
  }
  return chunks;
}

async function indexDocument(db, id, content) {
  const chunks = splitDocument(content);
  await db.query(`INSERT INTO document_chunks (document_id, ordinal, content)
    SELECT $1, (ordinal - 1)::integer, content FROM unnest($2::text[]) WITH ORDINALITY AS chunks(content, ordinal)`, [id,chunks]);
}

export function registerWorkspace(app, db) {
  registerKnowledgeCategories(app, db, accessibleBase);
  route(app, 'GET', '/v1/knowledge/bases', {
    tags: knowledgeTags, summary: 'List authorized knowledge bases', querystring: page,
  }, async request => {
    const context = request.context;
    return { items: await rows(db, [
      'SELECT ' + baseFields + ' FROM knowledge_bases b WHERE workspace_id = $1',
      'AND ($3::boolean OR EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.base_id = b.id AND g.account_id = $2))',
      'ORDER BY created_at DESC, id LIMIT $4 OFFSET $5',
    ].join(' '), [context.workspaceId, context.accountId, manager(context), ...paginate(request.query)]) };
  });

  route(app, 'POST', '/v1/knowledge/bases', {
    manager: true, tags: knowledgeTags, summary: 'Create a knowledge base', body: object({ name: text(120) }),
  }, async (request, reply) => {
    const base = await row(db, 'INSERT INTO knowledge_bases (id, workspace_id, name) VALUES ($1, $2, $3) RETURNING ' + baseFields, [randomUUID(), request.context.workspaceId, requiredText(request.body.name)]);
    reply.code(201);
    return base;
  });

  route(app, 'PATCH', '/v1/knowledge/bases/:id', {
    manager: true, tags: knowledgeTags, summary: 'Rename a knowledge base', params: idParams, body: object({ name: text(120) }),
  }, async request => {
    const base = await row(db, 'UPDATE knowledge_bases SET name = $3 WHERE workspace_id = $1 AND id = $2 RETURNING ' + baseFields, [request.context.workspaceId, request.params.id, requiredText(request.body.name)]);
    if (!base) throw notFound('Knowledge base');
    return base;
  });

  route(app, 'DELETE', '/v1/knowledge/bases/:id', {
    manager: true, tags: knowledgeTags, summary: 'Delete a knowledge base and its index', params: idParams,
  }, async (request, reply) => {
    const deleted = await row(db, 'DELETE FROM knowledge_bases WHERE workspace_id = $1 AND id = $2 RETURNING id', [request.context.workspaceId, request.params.id]);
    if (!deleted) throw notFound('Knowledge base');
    reply.code(204).send();
  });

  route(app, 'GET', '/v1/knowledge/bases/:id/grants', {
    manager:true, enterprise:true, tags:knowledgeTags, summary:'List explicit member grants for this knowledge base',
    params:idParams, querystring:page, response:{200:object({items:array(object({accountId:uuid}),100)})},
  }, async request => {
    await accessibleBase(db,request.context,request.params.id);
    return {items:await rows(db,'SELECT account_id AS "accountId" FROM knowledge_grants WHERE workspace_id=$1 AND base_id=$2 ORDER BY account_id LIMIT $3 OFFSET $4',
      [request.context.workspaceId,request.params.id,...paginate(request.query)])};
  });
  route(app, ['PUT', 'DELETE'], '/v1/knowledge/bases/:id/grants/:memberId', {
    manager: true, tags: knowledgeTags, summary: 'Grant or remove a knowledge-base permission', params: object({ id: uuid, memberId: uuid }),
  }, async (request, reply) => {
    requireEnterprise(request);
    const { workspaceId } = request.context;
    const { id, memberId } = request.params;
    await accessibleBase(db, request.context, id);
    await memberIn(db, workspaceId, memberId);
    if (request.method === 'PUT') {
      await db.query('INSERT INTO knowledge_grants (workspace_id, base_id, account_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [workspaceId, id, memberId]);
    } else {
      await db.query('DELETE FROM knowledge_grants WHERE workspace_id = $1 AND base_id = $2 AND account_id = $3', [workspaceId, id, memberId]);
    }
    reply.code(204).send();
  });

  route(app, 'GET', '/v1/knowledge/bases/:id/documents', {
    tags: knowledgeTags, summary: 'List document metadata', params: idParams,
    querystring:object({ ...page.properties, category:text(100,0) },[]),
  }, async request => {
    const { id } = request.params;
    await accessibleBase(db, request.context, id);
    return { items: await rows(db,`SELECT ${documentFields} FROM documents WHERE workspace_id=$1 AND base_id=$2
      AND ($3::text IS NULL OR category=$3) ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,
      [request.context.workspaceId,id,request.query.category?.trim() ?? null,...paginate(request.query)]) };
  });

  route(app, 'POST', '/v1/knowledge/bases/:id/documents', {
    manager: true, tags: knowledgeTags, summary: 'Ingest and index a UTF-8 text document', params: idParams,
    body: object({ name: text(200), category: text(100), content: text(200000) }, ['name', 'content']),
  }, async (request, reply) => {
    const { id } = request.params;
    const { workspaceId } = request.context;
    const content = requiredText(request.body.content);
    const name = requiredText(request.body.name);
    const inserted = await db.transaction(async connection => {
      await lockKnowledgeBase(connection,workspaceId,id);
      const category = request.body.category?.trim() ?? '';
      await ensureKnowledgeCategory(connection,workspaceId,id,category);
      const document = await row(connection, `INSERT INTO documents (id,workspace_id,base_id,name,category,content)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${documentFields}`,[randomUUID(),workspaceId,id,name,category,content]);
      await indexDocument(connection,document.id,content);
      return document;
    });
    reply.code(201);
    return inserted;
  });

  route(app, 'GET', '/v1/knowledge/bases/:id/documents/:documentId', {
    tags: knowledgeTags, summary: 'Read a document in an authorized base', params: object({ id: uuid, documentId: uuid }),
  }, async request => {
    const { id, documentId } = request.params;
    await accessibleBase(db, request.context, id);
    const document = await row(db, 'SELECT id, name, category, content, created_at AS "createdAt" FROM documents WHERE workspace_id = $1 AND base_id = $2 AND id = $3', [request.context.workspaceId, id, documentId]);
    if (!document) throw notFound('Document');
    return document;
  });

  route(app, 'PATCH', '/v1/knowledge/bases/:id/documents/:documentId', {
    manager:true, tags:knowledgeTags, summary:'Edit document metadata or replace and rebuild its text index',
    params:documentParams, body:documentPatch,
  }, request => db.transaction(async tx => {
    const {workspaceId} = request.context;
    const {id,documentId} = request.params;
    const patch = request.body;
    if (!Object.keys(patch).length) throw invalid('Provide at least one field to update');
    const name = patch.name === undefined ? null : requiredText(patch.name);
    const category = patch.category?.trim() ?? null;
    const content = patch.content === undefined ? null : requiredText(patch.content);
    await lockKnowledgeBase(tx,workspaceId,id);
    const updated = await row(tx,`UPDATE documents SET name=COALESCE($4,name),category=COALESCE($5,category),content=COALESCE($6,content)
      WHERE workspace_id=$1 AND base_id=$2 AND id=$3 RETURNING ${documentFields}`,[workspaceId,id,documentId,name,category,content]);
    if (!updated) throw notFound('Document');
    await ensureKnowledgeCategory(tx,workspaceId,id,updated.category);
    if (content !== null) {
      await tx.query('DELETE FROM document_chunks WHERE document_id=$1',[documentId]);
      await indexDocument(tx,documentId,content);
    }
    return updated;
  }));

  route(app, 'DELETE', '/v1/knowledge/bases/:id/documents/:documentId', {
    manager: true, tags: knowledgeTags, summary: 'Delete a document and its search entries', params: object({ id: uuid, documentId: uuid }),
  }, async (request, reply) => {
    const { id, documentId } = request.params;
    await accessibleBase(db, request.context, id);
    const deleted = await row(db, 'DELETE FROM documents WHERE workspace_id = $1 AND base_id = $2 AND id = $3 RETURNING id', [request.context.workspaceId, id, documentId]);
    if (!deleted) throw notFound('Document');
    reply.code(204).send();
  });

  route(app, 'POST', '/v1/knowledge/search', {
    tags: knowledgeTags, accountRateLimit: 60,
    summary: 'Retrieve authorized chunks by keyword',
    body: object({ query:text(160), baseIds:array(uuid,40,1), category:text(100,0), ...page.properties }, ['query']),
  }, async request => {
    const context = request.context;
    const { baseIds } = request.body;
    if (baseIds) for (const baseId of new Set(baseIds)) await accessibleBase(db, context, baseId);
    return { items: await rows(db, [
      'SELECT b.id AS "baseId", b.name AS "baseName", d.id AS "documentId", d.name, d.category, c.ordinal, c.content AS snippet',
      'FROM document_chunks c JOIN documents d ON c.document_id = d.id JOIN knowledge_bases b ON b.id = d.base_id',
      'WHERE d.workspace_id = $1 AND ($4::uuid[] IS NULL OR b.id = ANY($4::uuid[]))',
      'AND ($3::boolean OR EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.base_id = b.id AND g.account_id = $2))',
      'AND strpos(lower(c.content),lower($5)) > 0 AND ($6::text IS NULL OR d.category=$6)',
      'ORDER BY d.created_at DESC,d.id,c.ordinal LIMIT $7 OFFSET $8',
    ].join(' '),[context.workspaceId,context.accountId,manager(context),baseIds ?? null,requiredText(request.body.query),
      request.body.category?.trim() ?? null,...paginate(request.body)]) };
  });
}
