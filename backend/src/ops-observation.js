import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { probe } from './ops-probe.js';

const minute=60000;
const required=7*24*60*minute;
// A failed sample, clock regression or missing heartbeat starts a fresh continuous window.
export function observationSummary(samples, asOf) {
  let start=null, last=null, failures=0, gaps=0, count=0;
  for (const {time,ok} of samples) {
    count++;
    if (last!==null && (time-last>2*minute || time<=last)) {gaps++;start=null;}
    if (!ok) {failures++;start=null;} else start??=time;
    last=time;
  }
  const continuousMs=start===null?0:last-start;
  const stale=last===null || (asOf!==undefined && (asOf-last>2*minute || asOf<last));
  return {samples:count,failures,gaps,lastObservedAt:last===null?null:new Date(last).toISOString(),
    continuousMs,stale,qualified:!stale && continuousMs>=required};
}

async function run() {
  const [mode,path,...extra]=process.argv.slice(2);
  const env=process.env, revision=env.FAI_RELEASE_REVISION;
  if (!['once','watch','report'].includes(mode) || !isAbsolute(path||'') || extra.length || !/^[a-f0-9]{40}$/.test(revision) ||
      !env.FAI_PROBE_ORIGIN) throw new Error();
  const key=createHash('sha256').update(JSON.stringify([revision,env.FAI_PROBE_ORIGIN,env.FAI_PROBE_WORKSPACE_ID || null])).digest('hex');
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS samples (seq INTEGER PRIMARY KEY, target TEXT NOT NULL, time INTEGER NOT NULL, ok INTEGER NOT NULL, issues TEXT NOT NULL); CREATE INDEX IF NOT EXISTS by_target ON samples(target,seq)');
    do {
      if (mode!=='report') {
        const sample=await probe(env);
        try {
          const response=await fetch(new URL('/version',env.FAI_PROBE_ORIGIN),{redirect:'error',signal:AbortSignal.timeout(5000)});
          if (!response.ok || (await response.json()).revision!==revision) sample.issues.push('RELEASE_MISMATCH');
        } catch {sample.issues.push('RELEASE_UNVERIFIED');}
        db.prepare('INSERT INTO samples(target,time,ok,issues) VALUES(?,?,?,?)').run(key,Date.now(),Number(!sample.issues.length),JSON.stringify(sample.issues));
      }
      const summary=observationSummary(db.prepare('SELECT time,ok FROM samples WHERE target=? ORDER BY seq').iterate(key),Date.now());
      console.log(JSON.stringify({revision,...summary}));
      if (mode!=='watch' || summary.qualified) break;
      await delay(minute);
    } while (true);
  } finally {db.close();}
}
if(import.meta.main) {
  try {await run();} catch {console.error('Observation failed. Check candidate identity, probe configuration and evidence path.');process.exitCode=1;}
}
