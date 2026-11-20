
import { randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, array, choice, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const tags = ['Customer service'];
const idParams = object({ id: uuid });
const conversationFields = [
  'id', 'account_id AS "accountId"', 'operator_id AS "operatorId"', 'subject', 'state',
  'knowledge_base_ids AS "knowledgeBaseIds"', 'last_search AS "lastSearch"',
  'created_at AS "createdAt"', 'updated_at AS "updatedAt"',
].join(', ');
const messageFields = 'id::text, sender, content, sources, created_at AS "createdAt"';
const replyFields = 'id, title, scenario, content, revision, updated_at AS "updatedAt"';
const operator = context => context.kind === 'enterprise' && context.role !== 'member';

function nonblank(value) {
  const normalized = value.trim();
  if (!normalized) throw invalid('Text cannot be blank');
  return normalized;
}

async function enabled(db, workspaceId) {
  const settings = await row(db, "SELECT enabled FROM plugin_settings WHERE workspace_id = $1 AND plugin_id = 'customer-service'", [workspaceId]);
  if (settings?.enabled === false) throw new ApiError(409, 'PLUGIN_DISABLED', 'Customer service plugin is disabled for this workspace');
}

async function conversation(db, context, id, lock = false) {
  const result = await row(db, [
    'SELECT ' + conversationFields + ' FROM service_conversations',
    'WHERE workspace_id = $1 AND id = $2 AND ($4::boolean OR account_id = $3)',
    lock ? 'FOR UPDATE' : '',
  ].join(' '), [context.workspaceId, id, context.accountId, operator(context)]);
  if (!result) throw notFound('Conversation');
  return result;
}

async function message(db, workspaceId, conversationId, sender, content, sources = []) {
  return row(db, 'INSERT INTO service_messages (workspace_id, conversation_id, sender, content, sources) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ' + messageFields, [workspaceId, conversationId, sender, content, JSON.stringify(sources)]);
}

async function snippets(db, workspaceId, accountId, baseIds, search) {
  if (!baseIds.length) return [];
  return rows(db, [
    'SELECT d.base_id AS "baseId", b.name AS "baseName", d.id AS "documentId", d.name AS "documentName", c.ordinal, c.content AS snippet',
    'FROM document_chunks c JOIN documents d ON d.id = c.document_id JOIN knowledge_bases b ON b.id = d.base_id',
    'JOIN memberships m ON m.workspace_id = d.workspace_id AND m.account_id = $2',
    'WHERE d.workspace_id = $1 AND d.base_id = ANY($3::uuid[])',
    "AND (m.role <> 'member' OR EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.base_id = d.base_id AND g.account_id = $2))",
    'AND strpos(lower(c.content), lower($4)) > 0',
    'ORDER BY d.created_at DESC, d.id, c.ordinal LIMIT 3',
  ].join(' '), [workspaceId, accountId, baseIds, search]);
}

export function registerCustomerService(app, db) {
  route(app, 'GET', '/v1/customer-service/conversations', {
    tags, summary: 'List conversations visible to the current member or enterprise operator', querystring: page,
  }, async request => {
    const { workspaceId, accountId } = request.context;
    await enabled(db, workspaceId);
    return { items: await rows(db, 'SELECT ' + conversationFields + ' FROM service_conversations WHERE workspace_id = $1 AND ($3::boolean OR account_id = $2) ORDER BY updated_at DESC, id LIMIT $4 OFFSET $5', [workspaceId, accountId, operator(request.context), ...paginate(request.query)]) };
  });

  route(app, 'POST', '/v1/customer-service/conversations', {
    tags, summary: 'Create a support conversation with an optional knowledge scope',
    body: object({ subject: text(160), knowledgeBaseIds: array(uuid, 20) }, ['subject']),
  }, async (request, reply) => {
    const { workspaceId, accountId } = request.context;
    await enabled(db, workspaceId);
    const baseIds = [...new Set(request.body.knowledgeBaseIds ?? [])];
    if (baseIds.length) {
      const allowed = await rows(db, [
        'SELECT b.id FROM knowledge_bases b WHERE b.workspace_id = $1 AND b.id = ANY($3::uuid[])',
        'AND ($4::boolean OR EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.base_id = b.id AND g.account_id = $2))',
      ].join(' '), [workspaceId, accountId, baseIds, request.context.role !== 'member']);
      if (allowed.length !== baseIds.length) throw notFound('Knowledge base');
    }
    const created = await row(db, [
      'INSERT INTO service_conversations (id, workspace_id, account_id, subject, knowledge_base_ids, state)',
      "VALUES ($1, $2, $3, $4, $5, 'assistant') RETURNING " + conversationFields,
    ].join(' '), [randomUUID(), workspaceId, accountId, nonblank(request.body.subject), baseIds]);
    reply.code(201);
    return created;
  });

  route(app, 'GET', '/v1/customer-service/conversations/:id/messages', {
    tags, summary: 'Read the conversation history', params: idParams, querystring: page,
  }, async request => {
    const { workspaceId } = request.context;
    await enabled(db, workspaceId);
    const current = await conversation(db, request.context, request.params.id);
    return { conversation: current, items: await rows(db, 'SELECT ' + messageFields + ' FROM service_messages WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY service_messages.id LIMIT $3 OFFSET $4', [workspaceId, current.id, ...paginate(request.query)]) };
  });

  route(app, 'POST', '/v1/customer-service/conversations/:id/messages', {
    tags, summary: 'Post a customer message or reply as the assigned operator', params: idParams,
    body: object({ content: text(4000), search: text(160), sender: choice('customer', 'operator') }, ['content']),
  }, async (request, reply) => {
    const { workspaceId, accountId } = request.context;
    const content = nonblank(request.body.content);
    const sender = request.body.sender ?? 'customer';
    const result = await db.transaction(async connection => {
      await enabled(connection, workspaceId);
      const current = await conversation(connection, request.context, request.params.id, true);
      if ((sender === 'customer' && current.accountId !== accountId)
        || (sender === 'operator' && (current.state !== 'human' || current.operatorId !== accountId || !operator(request.context)))) {
        throw new ApiError(403, 'FORBIDDEN', 'The current member cannot post as this sender');
      }
      const created = await message(connection, workspaceId, current.id, sender, content);
      let assistant = null;
      let lastSearch = current.lastSearch;
      if (sender === 'customer' && current.state === 'assistant') {
        const search = request.body.search ? nonblank(request.body.search) : content.slice(0, 160);
        let sources = await snippets(connection, workspaceId, accountId, current.knowledgeBaseIds, search);
        if (sources.length) lastSearch = search;
        else if (!request.body.search && lastSearch && lastSearch !== search) {
          sources = await snippets(connection, workspaceId, accountId, current.knowledgeBaseIds, lastSearch);
        }
        if (sources.length) assistant = await message(connection, workspaceId, current.id, 'assistant', sources[0].snippet, sources);
      }
      await connection.query('UPDATE service_conversations SET updated_at = now(), last_search = $2 WHERE id = $1', [current.id, lastSearch]);
      return { message: created, assistant, state: current.state };
    });
    reply.code(201);
    return result;
  });

  route(app, 'POST', '/v1/customer-service/conversations/:id/handoff', {
    manager: true, tags, summary: 'Atomically take over a conversation and stop assistant replies', params: idParams,
  }, async request => db.transaction(async connection => {
    const { workspaceId, accountId } = request.context;
    if (!operator(request.context)) throw new ApiError(403, 'FORBIDDEN', 'Enterprise operator required');
    await enabled(connection, workspaceId);
    const current = await conversation(connection, request.context, request.params.id, true);
    if (current.state === 'human' && current.operatorId !== accountId) {
      throw new ApiError(409, 'ALREADY_ASSIGNED', 'Another operator owns this conversation');
    }
    if (current.state === 'human') return current;
    return row(connection, "UPDATE service_conversations SET state = 'human', operator_id = $2, updated_at = now() WHERE id = $1 RETURNING " + conversationFields, [current.id, accountId]);
  }));

  const replyInput = object({ title: text(160), scenario: text(100), content: text(4000) });
  route(app, 'GET', '/v1/customer-service/quick-replies', {
    tags, summary: 'Find quick replies for a scenario', querystring: object({ ...page.properties, scenario: text(100) }, []),
  }, async request => {
    const { workspaceId } = request.context;
    await enabled(db, workspaceId);
    return { items: await rows(db, 'SELECT ' + replyFields + ' FROM service_replies WHERE workspace_id = $1 AND ($2::text IS NULL OR scenario = $2) ORDER BY updated_at DESC, id LIMIT $3 OFFSET $4', [workspaceId, request.query.scenario ?? null, ...paginate(request.query)]) };
  });

  route(app, 'POST', '/v1/customer-service/quick-replies', {
    manager: true, tags, summary: 'Create a scoped quick reply', body: replyInput,
  }, async (request, reply) => {
    const { workspaceId } = request.context;
    await enabled(db, workspaceId);
    const { title, scenario, content } = request.body;
    const created = await row(db, 'INSERT INTO service_replies (id, workspace_id, title, scenario, content) VALUES ($1, $2, $3, $4, $5) RETURNING ' + replyFields, [randomUUID(), workspaceId, nonblank(title), nonblank(scenario), nonblank(content)]);
    reply.code(201);
    return created;
  });

  route(app, 'PUT', '/v1/customer-service/quick-replies/:id', {
    manager: true, tags, summary: 'Update quick reply text and revision', params: idParams, body: replyInput,
  }, async request => {
    const { workspaceId } = request.context;
    await enabled(db, workspaceId);
    const { title, scenario, content } = request.body;
    const updated = await row(db, 'UPDATE service_replies SET title = $3, scenario = $4, content = $5, revision = revision + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING ' + replyFields, [workspaceId, request.params.id, nonblank(title), nonblank(scenario), nonblank(content)]);
    if (!updated) throw notFound('Quick reply');
    return updated;
  });

  route(app, 'DELETE', '/v1/customer-service/quick-replies/:id', {
    manager: true, tags, summary: 'Delete a scoped quick reply', params: idParams,
  }, async (request, reply) => {
    const { workspaceId } = request.context;
    await enabled(db, workspaceId);
    const deleted = await row(db, 'DELETE FROM service_replies WHERE workspace_id = $1 AND id = $2 RETURNING id', [workspaceId, request.params.id]);
    if (!deleted) throw notFound('Quick reply');
    reply.code(204).send();
  });
}
