import { registerFeedback } from './feedback.js';
import { statfs } from 'node:fs/promises';
import { checkMigrations } from './db.js';
import { choice, integer, object, route, text } from './http.js';

const tags = ['Workspace support'];
const resultState = choice('ok','degraded','unavailable');
const bytes = {type:'string',pattern:'^[0-9]+$'};

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

  registerFeedback(app,db);
}
