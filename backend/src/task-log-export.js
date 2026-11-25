import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isUuid, config } from './config.js';
import { migrationFiles, postgres, rows } from './db.js';
import { assertControlDatabase, workspaceDatabaseRouter } from './workspace-database.js';

const day = 86400000;
const date = time => new Date(time).toISOString().slice(0,10);

// Rebuild from committed events so retries and late commits do not introduce gaps or duplicate lines.
export async function exportTaskLogs(db, workspace, root, retention=7, now=Date.now()) {
  if (!isUuid(workspace) || !isAbsolute(root) || !Number.isInteger(retention) || retention<1 || retention>90) throw new Error('Invalid log export settings');
  const dir=join(root,workspace.toLowerCase());
  await mkdir(dir,{recursive:true,mode:0o700});
  const first=date(now-(retention-1)*day);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),774123)',[workspace]);
    let events=0;
    for (let offset=retention-1;offset>=0;offset--) {
      const start=date(now-offset*day)+'T00:00:00Z', end=date(now-(offset-1)*day)+'T00:00:00Z';
      const target=join(dir,'tasks-'+start.slice(0,10)+'.jsonl');
      const temp=target+'.'+randomUUID()+'.tmp';
      let cursor='0', file;
      try {
        do {
          const batch=await rows(tx,'SELECT e.id::text AS id,e.created_at AS time,e.level,e.event,e.task_id AS "taskId",e.error_code AS "errorCode" '+
            'FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.workspace_id=$1 AND e.created_at >= $2 AND e.created_at < $3 '+
            'AND e.id > $4 ORDER BY e.id LIMIT 500',[workspace,start,end,cursor]);
          if (!batch.length) break;
          file ??= await open(temp,'wx',0o600);
          await file.writeFile(batch.map(event=>JSON.stringify(event)).join('\n')+'\n');
          events+=batch.length;
          cursor=batch.at(-1).id;
          if (batch.length<500) break;
        } while (true);
        if (file) {
          await file.close();
          file=undefined;
          await rename(temp,target);
        } else await rm(target,{force:true});
      } finally {await file?.close();await rm(temp,{force:true});}
    }
    for (const name of await readdir(dir)) {
      const match=/^tasks-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (match && match[1]<first) await rm(join(dir,name));
    }
    return {events,firstDay:first,lastDay:date(now)};
  });
}

if (import.meta.main) {
  const pools=[];
  try {
    try {process.loadEnvFile();} catch (error) {if(error.code!=='ENOENT') throw error;}
    const [workspace,root,watch,...extra]=process.argv.slice(2);
    if (!isUuid(workspace) || !isAbsolute(root || '') || (watch && watch!=='--watch') || extra.length) throw new Error();
    const cfg=config();
    const control=postgres(cfg.databaseUrl);
    pools.push(control);
    await assertControlDatabase(control);
    const dedicated=new Map();
    for (const [alias,url] of cfg.dedicatedDatabases) {const db=postgres(url);pools.push(db);dedicated.set(alias,db);}
    const router=workspaceDatabaseRouter(control,dedicated,await migrationFiles());
    do {
      const db=await router.forWorkspace(workspace);
      console.log(JSON.stringify(await exportTaskLogs(db,workspace,root,Number(process.env.FAI_LOG_KEEP_DAYS || 7))));
      if (watch) await delay(60000);
    } while (watch);
  } catch {console.error('Task log export failed. Verify workspace, database, directory and retention.');process.exitCode=1;}
  finally {await Promise.all(pools.map(db=>db.close()));}
}
