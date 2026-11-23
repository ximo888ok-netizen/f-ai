
import { createHash, randomUUID } from 'node:crypto';
import { searchTerms } from './customer-answer.js';
import { row, rows } from './db.js';
import { ApiError, array, choice, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const tags = ['Customer service'];
const idParams = object({ id: uuid });
const conversationFields = [
  'id', 'account_id AS "accountId"', 'operator_id AS "operatorId"', 'subject', 'state',
  'knowledge_base_ids AS "knowledgeBaseIds"', 'last_search AS "lastSearch"',
  'product_reference AS "productReference"', 'order_reference AS "orderReference"',
  'created_at AS "createdAt"', 'updated_at AS "updatedAt"',
].join(', ');
const messageFields = 'id::text, sender, content, sources, reply_to::text AS "replyTo", created_at AS "createdAt"';
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

async function message(db,workspaceId,conversationId,sender,content,{sources=[],clientId=null,hash=null,replyTo=null}={}) {
  return row(db,`INSERT INTO service_messages (workspace_id,conversation_id,sender,content,sources,client_id,request_hash,reply_to)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING ${messageFields}`,
    [workspaceId,conversationId,sender,content,JSON.stringify(sources),clientId,hash,replyTo]);
}

async function snippets(db, context, current, search) {
  const {workspaceId,accountId}=context;
  const {knowledgeBaseIds,productReference}=current;
  if (!knowledgeBaseIds.length || !search) return [];
  return rows(db, [
    'SELECT d.base_id AS "baseId", b.name AS "baseName", d.id AS "documentId", d.name AS "documentName", c.ordinal, c.content AS snippet',
    'FROM document_chunks c JOIN documents d ON d.id = c.document_id JOIN knowledge_bases b ON b.id = d.base_id',
    'JOIN memberships m ON m.workspace_id = d.workspace_id AND m.account_id = $2',
    'WHERE d.workspace_id = $1 AND d.base_id = ANY($3::uuid[])',
    "AND (m.role <> 'member' OR EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.base_id = d.base_id AND g.account_id = $2))",
    'AND (strpos(lower(c.content), lower($4)) > 0 OR EXISTS(SELECT 1 FROM unnest($5::text[]) AS token WHERE strpos(lower(c.content), token)>0))',
    'ORDER BY (strpos(lower(c.content), lower($4))>0) DESC,',
    '(SELECT count(*) FROM unnest($5::text[]) AS token WHERE strpos(lower(c.content), token)>0) DESC,',
    '(CASE WHEN $6::text IS NULL THEN false ELSE strpos(lower(c.content),lower($6))>0 END) DESC, d.created_at DESC,d.id,c.ordinal LIMIT 3',
  ].join(' '), [workspaceId,accountId,knowledgeBaseIds,search,searchTerms(search),productReference]);
}

async function evidence(db,context,current,requestedSearch,content) {
  const search=requestedSearch ?? content.slice(0,160);
  const sources=await snippets(db,context,current,search);
  if (sources.length || requestedSearch || search===current.lastSearch) return {sources,search};
  return {sources:await snippets(db,context,current,current.lastSearch),search:current.lastSearch};
}

async function sendMessage(db,context,id,body,answer) {
  const {workspaceId,accountId}=context;
  const content=nonblank(body.content);
  const sender=body.sender ?? 'customer';
  const requestedSearch=body.search && nonblank(body.search);
  const hash=body.clientId && createHash('sha256').update(JSON.stringify([sender,content,requestedSearch])).digest('hex');
  const turn=await db.transaction(async tx=>{
    await enabled(tx,workspaceId);
    const current=await conversation(tx,context,id,true);
    if ((sender==='customer' && current.accountId!==accountId)
      || (sender==='operator' && (current.state!=='human' || current.operatorId!==accountId || !operator(context)))) {
      throw new ApiError(403,'FORBIDDEN','The current member cannot post as this sender');
    }
    const previous=body.clientId && await row(tx,`SELECT ${messageFields},request_hash FROM service_messages
      WHERE workspace_id=$1 AND conversation_id=$2 AND client_id=$3`,[workspaceId,id,body.clientId]);
    if (previous) {
      const {request_hash,...created}=previous;
      if (request_hash!==hash) throw new ApiError(409,'IDEMPOTENCY_CONFLICT','The client ID belongs to another message');
      const assistant=await row(tx,`SELECT ${messageFields} FROM service_messages WHERE workspace_id=$1 AND conversation_id=$2 AND reply_to=$3`,
        [workspaceId,id,created.id]);
      return {created,state:current.state,assistant:assistant ?? null,replay:true};
    }
    const created=await message(tx,workspaceId,id,sender,content,{clientId:body.clientId,hash});
    const {sources,search}=sender==='customer' && current.state==='assistant'
      ? await evidence(tx,context,current,requestedSearch,content) : {sources:[],search:null};
    const lastSearch=sources.length?search:current.lastSearch;
    await tx.query('UPDATE service_conversations SET updated_at=now(),last_search=$2 WHERE id=$1',[id,lastSearch]);
    if (!sources.length) return {created,state:current.state,assistant:null};
    if (!answer) {
      const assistant=await message(tx,workspaceId,id,'assistant',sources[0].snippet,{sources,replyTo:created.id});
      return {created,state:current.state,assistant};
    }
    const history=await rows(tx,`SELECT sender,content FROM service_messages WHERE workspace_id=$1 AND conversation_id=$2
      AND sender IN ('customer','assistant') ORDER BY id DESC LIMIT 9`,[workspaceId,id]);
    return {created,state:current.state,sources,search,history:history.reverse(),
      productReference:current.productReference,orderReference:current.orderReference};
  });
  if (!turn.history) return turn;
  let response;
  try { response=await answer(turn); } catch { response=''; }
  return db.transaction(async tx=>{
    const current=await conversation(tx,context,id,true);
    const outcome={created:turn.created,state:current.state,assistant:null};
    if (current.state!=='assistant') return outcome;
    const setting=await row(tx,"SELECT enabled FROM plugin_settings WHERE workspace_id=$1 AND plugin_id='customer-service'",[workspaceId]);
    if (setting?.enabled===false) return outcome;
    const latest=await row(tx,`SELECT id::text FROM service_messages WHERE workspace_id=$1 AND conversation_id=$2
      AND sender='customer' ORDER BY service_messages.id DESC LIMIT 1`,[workspaceId,id]);
    if (latest?.id!==turn.created.id) return outcome;
    const sources=await snippets(tx,context,current,turn.search);
    if (!sources.length) return outcome;
    const unchanged=JSON.stringify(sources)===JSON.stringify(turn.sources);
    const assistant=await message(tx,workspaceId,id,'assistant',unchanged && response || sources[0].snippet,
      {sources,replyTo:turn.created.id});
    return {...outcome,assistant};
  });
}

export function registerCustomerService(app, db, answer=null) {
  route(app, 'GET', '/v1/customer-service/conversations', {
    tags, summary: 'List conversations visible to the current member or enterprise operator', querystring: page,
  }, async request => {
    const { workspaceId, accountId } = request.context;
    await enabled(db, workspaceId);
    return { items: await rows(db, 'SELECT ' + conversationFields + ' FROM service_conversations WHERE workspace_id = $1 AND ($3::boolean OR account_id = $2) ORDER BY updated_at DESC, id LIMIT $4 OFFSET $5', [workspaceId, accountId, operator(request.context), ...paginate(request.query)]) };
  });

  route(app, 'POST', '/v1/customer-service/conversations', { feature: 'customer-service.conversation',
    tags, summary: 'Create a support conversation with an optional knowledge scope',
    body: object({ subject: text(160), knowledgeBaseIds: array(uuid, 20),
      productReference: text(100), orderReference: text(100) }, ['subject']),
  }, async (request, reply) => {
    const { workspaceId, accountId } = request.context;
    await enabled(db, workspaceId);
    const baseIds = [...new Set((request.body.knowledgeBaseIds ?? []).map(id=>id.toLowerCase()))];
    if (baseIds.length) {
      const allowed = await rows(db, [
        'SELECT b.id FROM knowledge_bases b WHERE b.workspace_id = $1 AND b.id = ANY($3::uuid[])',
        'AND ($4::boolean OR EXISTS (SELECT 1 FROM knowledge_grants g WHERE g.base_id = b.id AND g.account_id = $2))',
      ].join(' '), [workspaceId, accountId, baseIds, request.context.role !== 'member']);
      if (allowed.length !== baseIds.length) throw notFound('Knowledge base');
    }
    const created = await row(db, [
      'INSERT INTO service_conversations (id, workspace_id, account_id, subject, knowledge_base_ids, state, product_reference, order_reference)',
      "VALUES ($1, $2, $3, $4, $5, 'assistant', $6, $7) RETURNING " + conversationFields,
    ].join(' '), [randomUUID(), workspaceId, accountId, nonblank(request.body.subject), baseIds,
      request.body.productReference?.trim() || null,request.body.orderReference?.trim() || null]);
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

  route(app, 'POST', '/v1/customer-service/conversations/:id/messages', { feature: 'customer-service.answer',
    tags, summary: 'Post or safely replay a customer or operator message', params: idParams,
    body: object({ content: text(4000), search: text(160), sender: choice('customer', 'operator'), clientId: uuid }, ['content']),
  }, async (request, reply) => {
    const {created,assistant,state,replay}=await sendMessage(db,request.context,request.params.id,request.body,answer);
    reply.code(replay?200:201);
    return {message:created,assistant,state};
  });

  route(app, 'POST', '/v1/customer-service/conversations/:id/handoff', { feature: 'customer-service.handoff',
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

  route(app, 'POST', '/v1/customer-service/quick-replies', { feature: 'customer-service.quick-replies',
    manager: true, tags, summary: 'Create a scoped quick reply', body: replyInput,
  }, async (request, reply) => {
    const { workspaceId } = request.context;
    await enabled(db, workspaceId);
    const { title, scenario, content } = request.body;
    const created = await row(db, 'INSERT INTO service_replies (id, workspace_id, title, scenario, content) VALUES ($1, $2, $3, $4, $5) RETURNING ' + replyFields, [randomUUID(), workspaceId, nonblank(title), nonblank(scenario), nonblank(content)]);
    reply.code(201);
    return created;
  });

  route(app, 'PUT', '/v1/customer-service/quick-replies/:id', { feature: 'customer-service.quick-replies',
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
