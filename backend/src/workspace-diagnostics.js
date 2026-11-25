import { registerFeedback } from './feedback.js';
import { statfs } from 'node:fs/promises';
import { diagnosticAlerts } from './diagnostic-alerts.js';
import { checkDirectories } from './directory-diagnostics.js';
import { checkMigrations, row } from './db.js';
import { array, choice, integer, object, route, text } from './http.js';

const tags = ['Workspace support'];
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
      uptimeSeconds:integer(0,2147483647), memoryBytes:bytes, cpuMilliseconds:bytes,
      directories:array(object({id:text(30),read:text(24),write:text(24)}),5) })} }, async () => {
    const [database, filesystem, directories] = await Promise.all([databaseHealth(db,migrations),storageHealth(),checkDirectories()]);
    const cpu = process.cpuUsage();
    return { database, filesystem, directories, nodeVersion:process.versions.node, uptimeSeconds:Math.floor(process.uptime()),
      memoryBytes:String(process.memoryUsage.rss()), cpuMilliseconds:String(Math.floor((cpu.user+cpu.system)/1000)) };
  });

  route(app, 'GET', '/v1/diagnostics/queue', { tags, manager:true, summary:'Read current workspace queue depth and lease recovery indicators',
    response:{200:object({queued:count,runnable:count,running:count,expiredLeases:count,dueSchedules:count,
      oldestRunnableSeconds:{anyOf:[count,{type:'null'}]}})} }, request => row(db, `SELECT
        count(*) FILTER (WHERE state='queued')::integer AS queued,
        count(*) FILTER (WHERE state='queued' AND available_at<=now())::integer AS runnable,
        count(*) FILTER (WHERE state='running')::integer AS running,
        count(*) FILTER (WHERE state='running' AND lease_id IS NOT NULL AND lease_until<=now())::integer AS "expiredLeases",
        floor(extract(epoch FROM now()-(min(available_at) FILTER (WHERE state='queued' AND available_at<=now()))))::integer AS "oldestRunnableSeconds",
        (SELECT count(*)::integer FROM schedules WHERE workspace_id=$1 AND state='pending' AND run_at<=now()) AS "dueSchedules"
      FROM tasks WHERE workspace_id=$1 AND state IN ('queued','running')`, [request.context.workspaceId]));

  route(app,'GET','/v1/diagnostics/alerts',{tags,manager:true,summary:'Evaluate workspace queue, polling and final failure thresholds',
    response:{200:object({observedAt:{type:'string',format:'date-time'},windowMinutes:{const:60},finished:count,failed:count,
      alerts:array(choice(...diagnosticAlerts),diagnosticAlerts.length)})}},
    async request=>{
      const sample=await row(db,`SELECT now() AS "observedAt",
        count(*) FILTER (WHERE state IN ('succeeded','failed'))::integer AS finished,
        count(*) FILTER (WHERE state='failed')::integer AS failed,
        coalesce(bool_or(state='queued' AND available_at<=now()-interval '2 minutes'),false) AS backlog,
        coalesce(bool_or(state='running' AND lease_id IS NOT NULL AND lease_until<=now()),false) AS expired,
        coalesce(bool_or(state='running' AND provider_job_id IS NOT NULL AND lease_id IS NULL AND lease_until<=now()-interval '2 minutes'),false) AS poll,
        EXISTS(SELECT 1 FROM schedules WHERE workspace_id=$1 AND state='pending' AND run_at<=now()-interval '2 minutes') AS scheduled,
        EXISTS(SELECT 1 FROM sms_messages WHERE workspace_id=$1 AND ((state='queued' AND available_at<=now()-interval '2 minutes')
          OR (state='sending' AND lease_until<=now()))) AS sms_delayed,
        EXISTS(SELECT 1 FROM sms_messages WHERE workspace_id=$1 AND state IN ('failed','uncertain') AND updated_at>=now()-interval '1 hour') AS sms_failed
        FROM tasks WHERE workspace_id=$1 AND (state IN ('queued','running') OR
          (state IN ('succeeded','failed') AND updated_at>=now()-interval '1 hour'))`,[request.context.workspaceId]);
      const {observedAt,finished,failed}=sample;
      const alerts=[];
      if (sample.backlog) alerts.push('QUEUE_DELAY');
      if (sample.expired) alerts.push('LEASE_EXPIRED');
      if (sample.poll) alerts.push('PROVIDER_POLL_DELAY');
      if (sample.scheduled) alerts.push('SCHEDULE_DELAY');
      if (finished>=5 && failed/finished>=0.2) alerts.push('TASK_FAILURE_RATE');
      if (sample.sms_delayed) alerts.push('SMS_QUEUE_DELAY');
      if (sample.sms_failed) alerts.push('SMS_SEND_FAILED');
      return {observedAt,windowMinutes:60,finished,failed,alerts};
    });

  registerFeedback(app,db);
}
