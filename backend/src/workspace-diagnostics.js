import { statfs } from 'node:fs/promises';
import { checkMigrations, row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, object, page, paginate, route, text, uuid } from './http.js';

const tags = ['Workspace support'];
const feedback = '/v1/feedback';
const feedbackFields = {
  id: uuid, category: choice('issue','suggestion'), message: text(4000),
};
const feedbackRecord = object({ ...feedbackFields, createdAt: {type:'string',format:'date-time'} });
const columns = 'id,category,message,created_at AS "createdAt"';
const resultState = choice('ok','degraded','unavailable');
const bytes = {type:'string',pattern:'^[0-9]+$'};
const count = integer(0,2147483647);

async function databaseHealth(db, migrations) {
  try {
    return await checkMigrations(db, migrations) ? 'ok' : 'degraded';
  } catch {
    return 'unavailable';
  }
}

async function storageHealth() {
  try {
    const stats = await statfs(process.cwd(), {bigint:true});
    const free = stats.bsize * stats.bavail;
    return free >= 100n * 1024n * 1024n ? 'ok' : 'degraded';
  } catch {
    return 'unavailable';
  }
}

export function registerWorkspaceDiagnostics(app, db, migrations) {
  route(app, 'GET', '/v1/diagnostics', { tags, manager:true, summary:'Check service database, runtime and local filesystem',
    response: {200: object({ database:resultState, filesystem:resultState, nodeVersion:text(40),
      uptimeSeconds:integer(0,2147483647), memoryBytes:bytes, cpuMilliseconds:bytes })} }, async () => {
    const [database, filesystem] = await Promise.all([databaseHealth(db,migrations),storageHealth()]);
    const cpu = process.cpuUsage();
    return { database, filesystem, nodeVersion:process.versions.node, uptimeSeconds:Math.floor(process.uptime()),
      memoryBytes:String(process.memoryUsage.rss()), cpuMilliseconds:String(Math.floor((cpu.user+cpu.system)/1000)) };
  });

  route(app, 'GET', '/v1/diagnostics/queue', { tags, manager:true, summary:'Read current workspace queue depth and lease recovery indicators',
    response:{200:object({queued:count,runnable:count,running:count,expiredLeases:count,dueSchedules:count,
      oldestRunnableSeconds:{anyOf:[count,{type:'null'}]}})} }, request => row(db, `SELECT
        count(*) FILTER (WHERE state='queued')::integer AS queued,
        count(*) FILTER (WHERE state='queued' AND available_at<=now())::integer AS runnable,
        count(*) FILTER (WHERE state='running')::integer AS running,
        count(*) FILTER (WHERE state='running' AND lease_until<=now())::integer AS "expiredLeases",
        floor(extract(epoch FROM now()-(min(available_at) FILTER (WHERE state='queued' AND available_at<=now()))))::integer AS "oldestRunnableSeconds",
        (SELECT count(*)::integer FROM schedules WHERE workspace_id=$1 AND state='pending' AND run_at<=now()) AS "dueSchedules"
      FROM tasks WHERE workspace_id=$1 AND state IN ('queued','running')`, [request.context.workspaceId]));

  route(app, 'GET', feedback, { tags, summary:'List feedback submitted by this workspace member', querystring:page,
    response: {200: object({items:array(feedbackRecord,100)})} }, async request => ({
    items:await rows(db,`SELECT ${columns} FROM workspace_feedback WHERE workspace_id=$1 AND account_id=$2
      ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,[request.context.workspaceId,request.context.accountId,...paginate(request.query)]),
  }));

  route(app, 'POST', feedback, { tags, summary:'Record private feedback with a client-assigned request ID', body:object(feedbackFields),
    response:{200:feedbackRecord,201:feedbackRecord} }, async (request,reply) => {
    const { workspaceId, accountId } = request.context;
    const { id,category } = request.body;
    const message = request.body.message.trim();
    if (!message) throw invalid('Feedback cannot be blank');
    const key = [workspaceId, accountId,id];
    const inserted = await row(db,`INSERT INTO workspace_feedback(workspace_id,account_id,id,category,message)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING ${columns}`,[...key,category,message]);
    if (inserted) {
      reply.code(201);
      return inserted;
    }
    const existing = await row(db,`SELECT ${columns} FROM workspace_feedback WHERE workspace_id=$1 AND account_id=$2 AND id=$3`,key);
    if (existing.category !== category || existing.message !== message) {
      throw new ApiError(409,'FEEDBACK_CONFLICT','The feedback ID is already in use');
    }
    return existing;
  });
}
