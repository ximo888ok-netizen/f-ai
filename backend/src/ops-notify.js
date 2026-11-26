import { createHash, createHmac, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export function alertSettings(env) {
  const address=env.FAI_ALERT_WEBHOOK_URL, file=env.FAI_ALERT_STATE_FILE;
  const format=env.FAI_ALERT_FORMAT || 'webhook';
  if (!address && !file && !env.FAI_ALERT_SERVICE && !env.FAI_ALERT_FORMAT && !env.FAI_ALERT_TOKEN && !env.FAI_ALERT_SIGNING_SECRET) return null;
  const service=env.FAI_ALERT_SERVICE || 'f-ai';
  const url=new URL(address);
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const validTransport=url.protocol==='https:' || (loopback && url.protocol==='http:');
  if (!validTransport) throw new Error('Invalid alert endpoint protocol');
  if (!file || !isAbsolute(file) || url.username || url.password || url.hash || !['webhook','feishu'].includes(format) ||
      !/^[\w.-]{1,64}$/.test(service) || (format==='feishu' && env.FAI_ALERT_TOKEN) || (format==='webhook' && env.FAI_ALERT_SIGNING_SECRET)) {
    throw new Error('Invalid alert configuration');
  }
  // A deployment can rotate its webhook or credentials while an incident is pending.
  const key=createHash('sha256').update(JSON.stringify([service,env.FAI_PROBE_ORIGIN,env.FAI_PROBE_WORKSPACE_ID?.toLowerCase()])).digest('hex');
  return {key,service,url,file,format,token:env.FAI_ALERT_TOKEN,secret:env.FAI_ALERT_SIGNING_SECRET};
}

function transaction(db,action) {
  db.exec('BEGIN IMMEDIATE');
  try {const result=action();db.exec('COMMIT');return result;}
  catch (error) {db.exec('ROLLBACK');throw error;}
}

function observe(db,{key,service},sample,startedAt) {
  const issues=JSON.stringify([...new Set(sample.issues)].sort());
  transaction(db,()=>{
    const previous=db.prepare('SELECT * FROM observed WHERE target=?').get(key);
    if (previous && previous.started_at>startedAt) return;
    let incident=previous?.incident ?? null;
    if ((previous?.issues ?? '[]')!==issues) {
      const type=!sample.issues.length?'resolved':incident?'updated':'firing';
      incident ??= randomUUID();
      const event={id:randomUUID(),incident,type,service,scope:sample.scope,observedAt:sample.observedAt,
        issues:JSON.parse(issues),previousIssues:JSON.parse(previous?.issues ?? '[]')};
      db.prepare('INSERT INTO outbox(target,payload) VALUES(?,?)').run(key,JSON.stringify(event));
      if (type==='resolved') incident=null;
    }
    db.prepare(`INSERT INTO observed(target,started_at,issues,incident) VALUES(?,?,?,?) ON CONFLICT(target)
      DO UPDATE SET started_at=excluded.started_at,issues=excluded.issues,incident=excluded.incident`).run(key,startedAt,issues,incident);
  });
}

function claim(db,key) {
  return transaction(db,()=>{
    // Only the oldest unsent transition may be delivered, including after a restart.
    const next=db.prepare('SELECT * FROM outbox WHERE target=? ORDER BY seq LIMIT 1').get(key);
    const now=Date.now();
    if (!next || next.available_at>now) return null;
    const lease=randomUUID();
    db.prepare('UPDATE outbox SET lease=?,available_at=?,attempts=attempts+1 WHERE seq=?').run(lease,now+30000,next.seq);
    return {...next,lease};
  });
}

async function deliver(settings,event) {
  const headers={'content-type':'application/json','idempotency-key':event.id};
  let body=event;
  if (settings.token) headers.authorization='Bearer '+settings.token;
  if (settings.format==='feishu') {
    const labels={firing:'发生告警',updated:'告警变化',resolved:'恢复正常'};
    const codes=(event.type==='resolved'?event.previousIssues:event.issues).join(', ');
    body={msg_type:'text',content:{text:[settings.service+' '+labels[event.type],codes,event.observedAt,'事件 '+event.id].join('\n')}};
    if (settings.secret) {
      body.timestamp=Math.floor(Date.now()/1000).toString();
      body.sign=createHmac('sha256',body.timestamp+'\n'+settings.secret).digest('base64');
    }
  }
  try {
    const response=await fetch(settings.url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(5000)});
    if (response.ok && settings.format==='feishu') {
      const ack=await response.json();
      return (ack?.code ?? ack?.StatusCode)===0;
    }
    await response.body?.cancel();
    return response.ok;
  } catch {return false;}
}

export async function notifyProbe(settings,sample,startedAt) {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(settings.file);
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS observed(target TEXT PRIMARY KEY,started_at INTEGER NOT NULL,issues TEXT NOT NULL,incident TEXT);
      CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY,target TEXT NOT NULL,payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease TEXT);
      CREATE INDEX IF NOT EXISTS outbox_target ON outbox(target,seq)`);
    observe(db,settings,sample,startedAt);
    let sent=0;
    for (let i=0;i<5;i++) {
      const next=claim(db,settings.key);
      if (!next) break;
      if (!(await deliver(settings,JSON.parse(next.payload)))) {
        const delay=15000*2**Math.min(next.attempts,5);
        db.prepare('UPDATE outbox SET lease=NULL,available_at=? WHERE seq=? AND lease=?').run(Date.now()+delay,next.seq,next.lease);
        break;
      }
      sent+=db.prepare('DELETE FROM outbox WHERE seq=? AND lease=?').run(next.seq,next.lease).changes;
    }
    const {pending}=db.prepare('SELECT count(*) AS pending FROM outbox WHERE target=?').get(settings.key);
    return {sent,pending};
  } finally {db.close();}
}
