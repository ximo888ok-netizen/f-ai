import { randomUUID } from 'node:crypto';
import { rows } from './db.js';
import { choice, freeObject, integer, invalid, object, route, text, uuid } from './http.js';

const stamp = { type: 'string', format: 'date-time' };
const event = object({
  id: uuid, actorId: uuid, actorName: text(100), scope: choice('identity', 'workspace'), action: text(64),
  targetId: text(128), detail: freeObject, requestId: text(128), occurredAt: stamp,
});

export function audit(tx, request, scope, action, targetId, detail) {
  const { workspaceId, accountId } = request.context;
  return tx.query(
    'INSERT INTO merchant_events(id,workspace_id,actor_id,scope,action,target_id,detail,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), workspaceId, accountId, scope, action, targetId, detail, request.id],
  );
}

function auditPage(db, workspace, scope, query, limit) {
  return rows(db, `SELECT id,actor_id AS "actorId",scope,action,target_id AS "targetId",detail,
    request_id AS "requestId",occurred_at AS "occurredAt" FROM merchant_events
    WHERE workspace_id=$1 AND scope=$2 AND ($3::text IS NULL OR action=$3)
    AND ($4::timestamptz IS NULL OR occurred_at >= $4) AND ($8::text IS NULL OR target_id=$8)
    AND ($5::timestamptz IS NULL OR (occurred_at,id)<($5,$6::uuid))
    ORDER BY occurred_at DESC,id DESC LIMIT $7`,
  [workspace, scope, query.action ?? null, query.from ?? null, query.beforeAt ?? null, query.beforeId ?? null, limit, query.targetId ?? null]);
}

function byNewest(a, b) {
  return new Date(b.occurredAt) - new Date(a.occurredAt) || (a.id < b.id ? 1 : -1);
}

export function registerMerchantAudit(app, control, workspaceDb) {
  route(app, 'GET', '/v1/merchant/audit-events', {
    manager: true, enterprise: true, tags: ['Merchant'], summary: 'Read workspace administration history',
    querystring: object({ limit: integer(1, 100), action: text(64), targetId: text(128), from: stamp, beforeAt: stamp, beforeId: uuid }, []),
    response: { 200: object({ items: { type: 'array', items: event }, hasMore: { type: 'boolean' } }) },
  }, async request => {
    const query = request.query;
    if (Boolean(query.beforeAt) !== Boolean(query.beforeId)) throw invalid('Specify both cursor fields');
    const limit = query.limit ?? 30;
    const workspaceId = request.context.workspaceId;
    const [identity, operations] = await Promise.all([
      auditPage(control, workspaceId, 'identity', query, limit + 1),
      auditPage(workspaceDb, workspaceId, 'workspace', query, limit + 1),
    ]);
    const items = [...identity, ...operations].sort(byNewest);
    const selected = items.slice(0, limit);
    const members = await rows(control, `SELECT a.id,a.display_name AS name FROM accounts a JOIN memberships m ON m.account_id=a.id
      WHERE m.workspace_id=$1 AND a.id=ANY($2::uuid[])`, [workspaceId, selected.map(item => item.actorId)]);
    const names = new Map(members.map(member => [member.id, member.name]));
    return { items: selected.map(item => ({ ...item, actorName: names.get(item.actorId) ?? item.actorId })), hasMore: items.length > limit };
  });
}
