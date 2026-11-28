
import { row, rows } from './db.js';
import { ApiError, integer, object, page, paginate, requireEnterprise, route, text, uuid } from './http.js';

const tags = ['Credits'];
const walletFields = 'balance, reserved, balance - reserved AS available';
const limitFields = object({
  limit: { ...integer(0,1000000000), type: ['integer','null'] },
  spent: { type: 'string', pattern: '^[0-9]+$' },
  reserved: integer(0,2147483647),
});
const scope = object({ id: uuid });
const insufficient = () => new ApiError(409, 'INSUFFICIENT_CREDITS', 'Available credits are insufficient');

export async function ledgerEntry(db, workspaceId, accountId, reference, operation, amount) {
  await db.query('INSERT INTO ledger (workspace_id, account_id, reference, operation, amount) VALUES ($1, $2, $3, $4, $5)', [workspaceId, accountId, reference, operation, amount]);
}

export async function moveAvailableCredits(tx, workspaceId, from, to, amount, outgoingRef, incomingRef) {
  if (from.balance - from.reserved < amount) throw insufficient();
  if (to.balance + amount > 2147483647) throw new ApiError(409, 'CREDIT_LIMIT_EXCEEDED', 'Wallet balance limit exceeded');
  await tx.query('UPDATE wallets SET balance=balance-$3 WHERE workspace_id=$1 AND account_id=$2', [workspaceId, from.account_id, amount]);
  await tx.query('UPDATE wallets SET balance=balance+$3 WHERE workspace_id=$1 AND account_id=$2', [workspaceId, to.account_id, amount]);
  await ledgerEntry(tx, workspaceId, from.account_id, outgoingRef, 'transfer_out', amount);
  await ledgerEntry(tx, workspaceId, to.account_id, incomingRef, 'transfer_in', amount);
}

async function settledCredits(db, workspaceId, accountId) {
  const result = await row(db, "SELECT COALESCE(sum(amount),0)::text AS spent FROM ledger WHERE workspace_id=$1 AND account_id=$2 AND operation='settle'", [workspaceId,accountId]);
  return result.spent;
}

async function creditLimit(db, workspaceId, accountId) {
  const result = await row(db, `SELECT task_limit AS "limit", reserved, (
    SELECT COALESCE(sum(amount),0)::text FROM ledger l WHERE l.workspace_id=w.workspace_id AND l.account_id=w.account_id AND l.operation='settle'
  ) AS spent FROM wallets w WHERE workspace_id=$1 AND account_id=$2`, [workspaceId,accountId]);
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  return result;
}

export async function reserveCredits(db, workspaceId, accountId, reference, cost) {
  const wallet = await row(db, 'SELECT balance,reserved,task_limit FROM wallets WHERE workspace_id=$1 AND account_id=$2 FOR UPDATE', [workspaceId,accountId]);
  if (!wallet || wallet.balance - wallet.reserved < cost) throw insufficient();
  if (wallet.task_limit !== null) {
    const spent = BigInt(await settledCredits(db, workspaceId, accountId));
    if (spent + BigInt(wallet.reserved + cost) > BigInt(wallet.task_limit)) {
      throw new ApiError(409, 'CREDIT_LIMIT_EXCEEDED', 'The member task spending limit would be exceeded');
    }
  }
  await db.query('UPDATE wallets SET reserved=reserved+$3 WHERE workspace_id=$1 AND account_id=$2', [workspaceId,accountId,cost]);
  await ledgerEntry(db, workspaceId, accountId, reference, 'reserve', cost);
}

export async function finishCredits(db, task, success) {
  await db.query('UPDATE wallets SET reserved = reserved - $3, balance = balance - $4 WHERE workspace_id = $1 AND account_id = $2', [task.workspace_id, task.account_id, task.cost, success ? task.cost : 0]);
  await ledgerEntry(db, task.workspace_id, task.account_id, task.id, success ? 'settle' : 'release', task.cost);
}

export async function provisionCredits(db, workspaceId, accountId, amount, reference) {
  return db.transaction(async connection => {
    const locked = await row(connection, 'SELECT balance FROM wallets WHERE workspace_id = $1 AND account_id = $2 FOR UPDATE', [workspaceId, accountId]);
    if (!locked) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
    const existing = await row(connection, "SELECT amount FROM ledger WHERE workspace_id = $1 AND account_id = $2 AND reference = $3 AND operation = 'credit'", [workspaceId, accountId, reference]);
    if (existing && existing.amount !== amount) throw new ApiError(409, 'CREDIT_REFERENCE_CONFLICT', 'Reference has another amount');
    if (!existing) {
      await connection.query('UPDATE wallets SET balance = balance + $3 WHERE workspace_id = $1 AND account_id = $2', [workspaceId, accountId, amount]);
      await ledgerEntry(connection, workspaceId, accountId, reference, 'credit', amount);
    }
    return row(connection, 'SELECT ' + walletFields + ' FROM wallets WHERE workspace_id = $1 AND account_id = $2', [workspaceId, accountId]);
  });
}

export function registerWallet(app, db) {
  route(app, 'GET', '/v1/credits/wallet', { tags, summary: 'Get current wallet' }, async request =>
    row(db, 'SELECT ' + walletFields + ' FROM wallets WHERE workspace_id = $1 AND account_id = $2', [request.context.workspaceId, request.context.accountId]));

  route(app, 'GET', '/v1/credits/limit', { tags, summary: 'Get own task spending limit, cost and reservations',
    response: {200: limitFields} }, request => creditLimit(db, request.context.workspaceId, request.context.accountId));

  const memberLimit = '/v1/credits/members/:id/limit';
  route(app, 'GET', memberLimit, { tags, manager: true, params: scope, summary: 'Read an enterprise member task spending limit',
    response: {200: limitFields} }, request => {
    requireEnterprise(request);
    return creditLimit(db, request.context.workspaceId, request.params.id);
  });

  route(app, 'PUT', memberLimit, { tags, manager: true, params: scope, summary: 'Set or clear a member cumulative task spending limit',
    body: object({ limit: limitFields.properties.limit }), response: {200: limitFields} }, request => {
    requireEnterprise(request);
    const { workspaceId, role } = request.context;
    const id = request.params.id;
    return db.transaction(async tx => {
      const member = await row(tx, 'SELECT role FROM memberships WHERE workspace_id=$1 AND account_id=$2 FOR UPDATE', [workspaceId,id]);
      if (!member) throw new ApiError(404, 'NOT_FOUND', 'Workspace member not found');
      if (member.role === 'owner' || (role === 'admin' && member.role === 'admin')) {
        throw new ApiError(403, 'FORBIDDEN', 'Cannot change the spending limit for this role');
      }
      await tx.query('UPDATE wallets SET task_limit=$3 WHERE workspace_id=$1 AND account_id=$2', [workspaceId,id,request.body.limit]);
      return creditLimit(tx, workspaceId, id);
    });
  });

  route(app, 'GET', '/v1/credits/ledger', { tags, summary: 'List current wallet entries', querystring: page }, async request => ({
    items: await rows(db, 'SELECT id::text, reference, operation, amount, created_at AS "createdAt" FROM ledger WHERE workspace_id = $1 AND account_id = $2 ORDER BY id DESC LIMIT $3 OFFSET $4', [request.context.workspaceId, request.context.accountId, ...paginate(request.query)]),
  }));

  route(app, 'POST', '/v1/credits/allocate', {
    manager: true, tags, summary: 'Allocate credits to an enterprise member',
    body: object({ memberId: uuid, amount: integer(1, 1000000), reference: text(100) }),
  }, async request => {
    requireEnterprise(request);
    const { workspaceId, accountId } = request.context;
    const { memberId, amount, reference } = request.body;
    if (memberId === accountId) throw new ApiError(400, 'INVALID_INPUT', 'Cannot allocate credits to the current wallet');
    return db.transaction(async connection => {
      const wallets = await rows(connection, 'SELECT account_id, balance, reserved FROM wallets WHERE workspace_id = $1 AND account_id IN ($2, $3) ORDER BY account_id FOR UPDATE', [workspaceId, accountId, memberId]);
      if (wallets.length !== 2) throw new ApiError(404, 'NOT_FOUND', 'Member wallet not found');
      const existing = await row(connection, "SELECT amount FROM ledger WHERE workspace_id = $1 AND account_id = $2 AND reference = $3 AND operation = 'transfer_out'", [workspaceId, accountId, reference]);
      const receivingReference = accountId + ':' + reference;
      if (existing) {
        const recipient = await row(connection, "SELECT amount FROM ledger WHERE workspace_id = $1 AND account_id = $2 AND reference = $3 AND operation = 'transfer_in'", [workspaceId, memberId, receivingReference]);
        if (!recipient || existing.amount !== amount) throw new ApiError(409, 'CREDIT_REFERENCE_CONFLICT', 'Reference has another allocation');
      } else {
        const source = wallets.find(wallet => wallet.account_id === accountId);
        const target = wallets.find(wallet => wallet.account_id === memberId);
        await moveAvailableCredits(connection, workspaceId, source, target, amount, reference, receivingReference);
      }
      return row(connection, 'SELECT ' + walletFields + ' FROM wallets WHERE workspace_id = $1 AND account_id = $2', [workspaceId, accountId]);
    });
  });
}
