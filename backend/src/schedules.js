
import { randomUUID } from 'node:crypto';
import { digest } from './auth.js';
import { capabilityRules, catalog } from './catalog.js';
import { row, rows } from './db.js';
import { ApiError, choice, freeObject, invalid, notFound, object, page, paginate, route, uuid } from './http.js';
import { providerFor } from './providers.js';
import { keySchema, stableJson, submitInTransaction } from './tasks.js';
import { accessibleProject } from './workspace.js';

const tags = ['Schedules'];
const schedulable = [...catalog.values()].filter(capability => !capability.requiresConfirmation && ['local', 'gateway'].includes(capability.execution));
const byId = new Map(schedulable.map(capability => [capability.id, capability]));
const fields = 'id, run_at AS "runAt", request, state, task_id AS "taskId", error_code AS "errorCode", created_at AS "createdAt", updated_at AS "updatedAt"';

export function registerSchedules(app, db, providers) {
  route(app, 'POST', '/v1/schedules', {
    tags, summary: 'Schedule a one-time task without reserving credits until dispatch',
    body: {
      ...object({
        runAt: { type: 'string', format: 'date-time' }, capabilityId: choice(...byId.keys()),
        mode: choice('chat', 'workflow'), projectId: uuid, parameters: freeObject, idempotencyKey: keySchema,
      }, ['runAt', 'capabilityId', 'mode', 'parameters', 'idempotencyKey']),
      allOf: capabilityRules.filter(rule => byId.has(rule.if.properties.capabilityId.const)),
    },
  }, async (request, reply) => {
    const { runAt, idempotencyKey, ...input } = request.body;
    const parsed = new Date(runAt);
    if (!Number.isFinite(parsed.getTime())) throw invalid('Invalid schedule date');
    const hash = digest(stableJson({ runAt: parsed.toISOString(), input }));
    const args = [request.context.workspaceId, request.context.accountId, idempotencyKey];
    const readExisting = async () => {
      const existing = await row(db, 'SELECT ' + fields + ', request_hash FROM schedules WHERE workspace_id = $1 AND account_id = $2 AND idempotency_key = $3', args);
      if (existing && existing.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to a different schedule');
      return existing;
    };
    const existing = await readExisting();
    if (existing) return existing;
    const now = Date.now();
    if (parsed.getTime() <= now || parsed.getTime() > now + 366 * 24 * 60 * 60 * 1000) {
      throw invalid('runAt must be in the next 366 days');
    }
    providerFor(providers, byId.get(input.capabilityId));
    await accessibleProject(db, request.context, input.projectId, true);
    const schedule = await row(db, [
      'INSERT INTO schedules (id, workspace_id, account_id, idempotency_key, run_at, request, request_hash, state)',
      "VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')",
      'ON CONFLICT (workspace_id, account_id, idempotency_key) DO NOTHING RETURNING ' + fields,
    ].join(' '), [randomUUID(), ...args, parsed, input, hash]);
    if (!schedule) return readExisting();
    reply.code(201);
    return schedule;
  });

  route(app, 'GET', '/v1/schedules', {
    tags, summary: 'List current member schedules and their linked task IDs', querystring: page,
  }, async request => ({
    items: await rows(db, 'SELECT ' + fields + ' FROM schedules WHERE workspace_id = $1 AND account_id = $2 ORDER BY created_at DESC, id LIMIT $3 OFFSET $4', [request.context.workspaceId, request.context.accountId, ...paginate(request.query)]),
  }));

  route(app, 'POST', '/v1/schedules/:id/cancel', {
    tags, summary: 'Cancel a schedule before dispatch', params: object({ id: uuid }),
  }, async request => {
    const args = [request.context.workspaceId, request.context.accountId, request.params.id];
    return db.transaction(async connection => {
      const current = await row(connection, 'SELECT ' + fields + ' FROM schedules WHERE workspace_id = $1 AND account_id = $2 AND id = $3 FOR UPDATE', args);
      if (!current) throw notFound('Schedule');
      if (current.state === 'cancelled') return current;
      if (current.state !== 'pending') throw new ApiError(409, 'SCHEDULE_RESOLVED', 'This schedule has already been resolved');
      return row(connection, "UPDATE schedules SET state = 'cancelled', updated_at = now() WHERE workspace_id = $1 AND account_id = $2 AND id = $3 RETURNING " + fields, args);
    });
  });
}

export async function dispatchSchedule({ db, providers, shops }) {
  return db.transaction(async connection => {
    const pending = await row(connection, [
      'SELECT s.id, s.workspace_id, s.account_id, s.request, m.role, w.kind',
      'FROM schedules s JOIN memberships m ON m.workspace_id = s.workspace_id AND m.account_id = s.account_id',
      'JOIN workspaces w ON w.id = s.workspace_id',
      "WHERE s.state = 'pending' AND s.run_at <= now() ORDER BY s.run_at, s.id",
      'LIMIT 1 FOR UPDATE OF s SKIP LOCKED',
    ].join(' '));
    if (!pending) return false;

    const context = { workspaceId: pending.workspace_id, accountId: pending.account_id, role: pending.role, kind: pending.kind };
    await connection.query('SAVEPOINT submit_schedule');
    try {
      const { task } = await submitInTransaction(connection, providers, shops, context, {
        ...pending.request, idempotencyKey: 'schedule:' + pending.id,
      });
      await connection.query("UPDATE schedules SET state = 'submitted', task_id = $2, updated_at = now() WHERE id = $1", [pending.id, task.id]);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await connection.query('ROLLBACK TO SAVEPOINT submit_schedule');
      await connection.query("UPDATE schedules SET state = 'failed', error_code = $2, updated_at = now() WHERE id = $1", [pending.id, error.code]);
    }
    await connection.query('RELEASE SAVEPOINT submit_schedule');
    return true;
  });
}
