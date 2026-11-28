import { row, rows } from './db.js';
import { ApiError, array, bool, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { audit } from './merchant-audit.js';
import { moveAvailableCredits } from './wallet.js';

const options = { manager: true, enterprise: true, tags: ['Workspace administration'] };
const base = '/v1/admin/workspace';
const balance = integer(0, 2147483647);
const tally = { type: 'string', pattern: '^[0-9]+$' };
const member = object({
  id: uuid, name: text(100), email: text(254), role: choice('owner', 'admin', 'member'),
  enabled: bool, balance, available: balance, taskLimit: { ...balance, type: ['integer', 'null'] },
});
const walletEntry = object({
  id: tally, userName: text(100), operation: choice('credit', 'transfer_in', 'transfer_out', 'reserve', 'settle', 'release'),
  amount: balance, reference: text(300), at: { type: 'string', format: 'date-time' },
});
const overview = object({
  totals: object({ users: balance, credits: tally }),
  trend: array(object({ date: { type: 'string', format: 'date' }, issuedCredits: tally, usage: tally }), 7, 7),
});

async function reallocate(db, request) {
  const { workspaceId, accountId, role } = request.context;
  const { userId, delta, reason, operationId } = request.body;
  if (role !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Only the workspace owner can reallocate credits');
  if (userId === accountId || !delta || !reason.trim()) throw invalid('Choose another member, a credit amount and a reason');
  const amount = Math.abs(delta);
  const [source, destination] = delta > 0 ? [accountId, userId] : [userId, accountId];
  const reference = 'admin-workspace:' + accountId + ':' + operationId;
  return db.transaction(async tx => {
    const accounts = [workspaceId, accountId, userId];
    const wallets = await rows(tx, `SELECT account_id,balance,reserved FROM wallets
      WHERE workspace_id=$1 AND account_id IN ($2,$3) ORDER BY account_id FOR UPDATE`, accounts);
    if (wallets.length !== 2) throw notFound('Member wallet');
    const entries = await rows(tx, `SELECT account_id,amount,operation FROM ledger
      WHERE workspace_id=$1 AND account_id IN ($2,$3) AND reference=$4
      AND operation IN ('transfer_in','transfer_out')`, [...accounts, reference]);
    if (entries.length) {
      if (entries.length !== 2 || !entries.some(e => e.account_id === source && e.amount === amount && e.operation === 'transfer_out') ||
          !entries.some(e => e.account_id === destination && e.amount === amount && e.operation === 'transfer_in')) {
        throw new ApiError(409, 'CREDIT_REFERENCE_CONFLICT', 'This operation already has a different transfer');
      }
      return { replayed: true };
    }
    const member = await row(tx, `SELECT state FROM memberships WHERE workspace_id=$1 AND account_id=$2`, [workspaceId, userId]);
    if (member?.state !== 'active') throw new ApiError(409, 'MEMBER_SUSPENDED', 'Choose an active workspace member');
    const from = wallets.find(wallet => wallet.account_id === source);
    const to = wallets.find(wallet => wallet.account_id === destination);
    await moveAvailableCredits(tx, workspaceId, from, to, amount, reference, reference);
    await audit(tx, request, 'workspace', 'credits.reallocated', userId, { delta, reason: reason.trim(), reference });
    return { replayed: false };
  });
}

export function registerWorkspaceAdmin(app, db) {
  route(app, 'GET', base + '/overview', {
    ...options, summary: 'Read workspace activity and credit totals', response: { 200: overview },
  }, async request => {
    const id = request.context.workspaceId;
    const [totals, trend] = await Promise.all([
      row(db, `SELECT (SELECT count(*)::int FROM memberships WHERE workspace_id=$1) AS users,
        COALESCE(sum(balance),0)::text AS credits FROM wallets WHERE workspace_id=$1`, [id]),
      rows(db, `WITH days AS (
        SELECT (now() AT TIME ZONE 'UTC')::date-offset_days AS date FROM generate_series(0,6) offset_days
      ), activity AS (
        SELECT (created_at AT TIME ZONE 'UTC')::date AS date,
          COALESCE(sum(amount) FILTER (WHERE operation='credit'),0)::text AS "issuedCredits",
          COALESCE(sum(amount) FILTER (WHERE operation='settle'),0)::text AS usage
        FROM ledger WHERE workspace_id=$1 AND created_at>=((now() AT TIME ZONE 'UTC')::date-6)::timestamp AT TIME ZONE 'UTC'
        AND operation IN ('credit','settle') GROUP BY 1
      ) SELECT to_char(days.date,'YYYY-MM-DD') AS date,
        COALESCE(activity."issuedCredits",'0') AS "issuedCredits",COALESCE(activity.usage,'0') AS usage
      FROM days LEFT JOIN activity USING(date) ORDER BY days.date`, [id]),
    ]);
    return { totals, trend };
  });

  route(app, 'GET', base + '/members', {
    ...options, querystring: page, summary: 'List members with wallet balance and quotas', response: { 200: object({ items: array(member, 100) }) },
  }, async request => ({
    items: await rows(db, `SELECT a.id,a.display_name AS name,a.email,m.role,m.state='active' AS enabled,
      COALESCE(w.balance,0) AS balance,COALESCE(w.balance-w.reserved,0) AS available,w.task_limit AS "taskLimit"
      FROM memberships m JOIN accounts a ON a.id=m.account_id
      LEFT JOIN wallets w ON w.workspace_id=m.workspace_id AND w.account_id=m.account_id
      WHERE m.workspace_id=$1 ORDER BY m.created_at,a.id LIMIT $2 OFFSET $3`,
    [request.context.workspaceId, ...paginate(request.query)]),
  }));

  route(app, 'GET', base + '/ledger', {
    ...options, querystring: page, summary: 'Read workspace wallet entries', response: { 200: object({ items: array(walletEntry, 100) }) },
  }, async request => ({
    items: await rows(db, `SELECT l.id::text,a.display_name AS "userName",l.operation,l.amount,l.reference,l.created_at AS at
      FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE l.workspace_id=$1
      ORDER BY l.id DESC LIMIT $2 OFFSET $3`, [request.context.workspaceId, ...paginate(request.query)]),
  }));

  route(app, 'POST', base + '/credits/adjust', {
    ...options, summary: 'Move available credits between the owner and an active member',
    body: object({ userId: uuid, delta: integer(-1000000, 1000000), reason: text(160), operationId: uuid }),
    response: { 200: object({ replayed: bool }) },
  }, request => reallocate(db, request));
}
