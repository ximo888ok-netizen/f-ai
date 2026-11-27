import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash,createHmac,randomUUID } from 'node:crypto';
import { mkdtemp,readdir,rmdir,unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { migrate,postgres,row } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { dispatchSms } from '../src/sms-channel.js';
import { createSmsBindings } from '../src/tencent-sms.js';
import { startWorker } from '../src/worker.js';

const wallClock=process.env.FAI_TEST_SMS_REAL_BACKOFF==='1';

async function listen(t,handler) {
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}
async function read(req) {
  const chunks=[];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
function reply(res,body,status=200) {
  res.writeHead(status,{'content-type':'application/json'});
  res.end(JSON.stringify(body));
}

// Independently reconstruct the signature from the bytes and signed headers received by the gateway.
function verifySms(req,raw) {
  const h=req.headers;
  const auth=/^TC3-HMAC-SHA256 Credential=fixture-id\/(\d{4}-\d\d-\d\d)\/sms\/tc3_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(h.authorization);
  if (!auth || h['x-tc-action']!=='SendSms' || h['x-tc-region']!=='ap-guangzhou' || h['x-tc-version']!=='2021-01-11') return false;
  const names=auth[2].split(';');
  const actual={...h,host:'sms.tencentcloudapi.com'};
  const digest=s=>createHash('sha256').update(s).digest('hex');
  const canonical=[req.method,'/','',names.map(n=>n+':'+actual[n].trim().toLowerCase()+'\n').join(''),auth[2],digest(raw)].join('\n');
  const sign=(key,data)=>createHmac('sha256',key).update(data).digest();
  const key=[auth[1],'sms','tc3_request'].reduce(sign,'TC3fixture-key');
  return auth[1]===new Date(Number(h['x-tc-timestamp'])*1000).toISOString().slice(0,10) &&
    sign(key,['TC3-HMAC-SHA256',h['x-tc-timestamp'],auth[1]+'/sms/tc3_request',digest(canonical)].join('\n')).toString('hex')===auth[3];
}

async function smsFixture(t) {
  const db=process.env.FAI_TEST_DATABASE_URL?postgres(process.env.FAI_TEST_DATABASE_URL):new PGlite();
  await migrate(db);
  const sms=new Map(), calls=[];
  let behavior='ok';
  const url=await listen(t,async (req,res)=>{
    const raw=await read(req);
    const body=JSON.parse(raw);
    calls.push({body,valid:verifySms(req,raw),at:Date.now()});
    if (behavior==='disconnect') return req.socket.destroy();
    if (behavior==='throttle') {res.setHeader('retry-after','65');return reply(res,{},429);}
    const code=behavior==='reject'?'FailedOperation.TemplateIncorrectOrUnapproved':'Ok';
    return reply(res,{Response:{SendStatusSet:[{Code:code,SerialNo:'fixture:1234',PhoneNumber:body.PhoneNumberSet[0],SessionContext:body.SessionContext}]}});
  });
  const app=await buildApp({db,sms});
  t.after(async()=>{await app.close();await db.close();});
  const api=async (headers,method,url,payload,status=200)=>{
    const r=await app.inject({headers,method,url,payload});
    assert.equal(r.statusCode,status,r.body);
    return r.json();
  };
  const register=async ()=>{
    const email=randomUUID()+'@example.test';
    const account=await api({},'POST','/v1/auth/register',await registrationPayload(app, {email,password:'sms-notification-fixture',displayName:'SMS QA',type:'enterprise',workspaceName:'Fixture'}),201);
    return {workspace:account.workspaces[0].id,email,id:account.account.id,headers:{'x-workspace-id':account.workspaces[0].id,authorization:'Bearer '+account.token}};
  };
  const owner=await register();
  const config={workspaceId:owner.workspace,appId:'1400000000',signName:'测试签名',secretIdEnv:'FIXTURE_ID',secretKeyEnv:'FIXTURE_KEY',
    templates:[{alias:'order-update',id:'1001',params:1}]};
  const bindings=createSmsBindings({FIXTURE_ID:'fixture-id',FIXTURE_KEY:'fixture-key',SMS_BINDINGS_JSON:JSON.stringify([config])},(endpoint,init)=>{
    assert.equal(endpoint,'https://sms.tencentcloudapi.com/');
    return fetch(url,init);
  });
  sms.set(owner.workspace,bindings.get(owner.workspace));
  const payload={recipient:'+12025550123',template:'order-update',values:['sample-order']};
  const root='/v1/channels/sms/messages';
  const put=(id,status=202,data=payload)=>api(owner.headers,'PUT',root+'/'+id,data,status);
  const get=id=>api(owner.headers,'GET',root+'/'+id);
  const next=()=>dispatchSms({db,sms});
  const due=id=>db.query('UPDATE sms_messages SET available_at=now() WHERE workspace_id=$1 AND id=$2',[owner.workspace,id]);
  return {app,db,sms,owner,register,calls,api,put,get,due,next,payload,root,setBehavior:value=>{behavior=value;}};
}

test('template SMS is signed, accepted once after throttling, masked and restricted by workspace',async t=>{
  const f=await smsFixture(t);
  const other=await f.register();
  const id=randomUUID();
  const options='/v1/channels/sms/options';
  assert.deepEqual((await f.api(f.owner.headers,'GET',options)).templates,[{alias:'order-update',params:1}]);
  assert.deepEqual((await f.api(other.headers,'GET',options)).templates,[]);
  const invite=await f.api(f.owner.headers,'POST','/v1/invitations',{email:other.email,role:'member'},201);
  await f.api(other.headers,'POST','/v1/invitations/accept',{token:invite.token});
  await f.api({...other.headers,'x-workspace-id':f.owner.workspace},'PUT',f.root+'/'+id,f.payload,403);
  await f.put(id,400,{...f.payload,values:[]});
  await f.put(id,422,{...f.payload,template:'missing'});
  const duplicates=await Promise.all([1,2].map(()=>f.app.inject({headers:f.owner.headers,method:'PUT',url:f.root+'/'+id,payload:f.payload})));
  assert.deepEqual(duplicates.map(r=>r.statusCode).sort(),[200,202]);
  const first=duplicates[0].json();
  assert.equal(first.maskedRecipient,'***0123');
  await f.put(id,200);
  await f.put(id,409,{...f.payload,values:['different']});
  await f.api(other.headers,'GET',f.root+'/'+id,undefined,404);
  f.setBehavior('throttle');
  await Promise.all([f.next(),f.next()]);
  assert.equal(f.calls.length,1);
  const wait=await f.get(id);
  assert.deepEqual([wait.state,wait.attempts,wait.errorCode],['queued',1,'SMS_RATE_LIMITED']);
  assert.equal(await f.next(),false);
  assert.ok((await row(f.db,"SELECT available_at>=now()+interval '60 seconds' AS waiting FROM sms_messages WHERE id=$1",[id])).waiting);
  if (!wallClock) await f.due(id);
  f.setBehavior('ok');
  const stop=startWorker({db:f.db,sms:f.sms,providers:createProviders(),shops:new Map()},{error:()=>{}});
  try {
    const deadline=Date.now()+(wallClock?80000:7000);
    while (Date.now()<deadline && (await f.get(id)).state!=='accepted') await sleep(wallClock?500:50);
    const accepted=await f.put(id,200);
    assert.deepEqual([accepted.state,accepted.attempts,accepted.providerReference],['accepted',2,'fixture:1234']);
    const list=await f.api(f.owner.headers,'GET',f.root);
    assert.doesNotMatch(JSON.stringify(list),/12025550123|sample-order|fixture-key/);
    assert.equal((await row(f.db,'SELECT payload FROM sms_messages WHERE id=$1',[id])).payload,null);
    assert.equal(f.calls.length,2);
    assert.ok(f.calls.every(c=>c.valid));
    assert.deepEqual(f.calls[0].body,{SmsSdkAppId:'1400000000',SignName:'测试签名',TemplateId:'1001',
      PhoneNumberSet:[f.payload.recipient],TemplateParamSet:f.payload.values,SessionContext:id});
    assert.deepEqual(f.calls[0].body,f.calls[1].body);
    if (wallClock) {
      const elapsed=f.calls[1].at-f.calls[0].at;
      assert.ok(elapsed>=65000);
      t.diagnostic('SMS accepted on attempt 2 after '+(elapsed/1000).toFixed(1)+' seconds of worker backoff');
    }
  } finally {await stop();}
});

test('SMS stops on rejection, uncertain transport, expired lease, revoked binding and exhausted retry budget',async t=>{
  const f=await smsFixture(t);
  for (const [mode,state] of [['reject','failed'],['disconnect','uncertain'],['throttle','failed']]) {
    const id=randomUUID();
    f.setBehavior(mode);
    await f.put(id);
    const attempts=mode==='throttle'?3:1;
    for (let i=0;i<attempts;i++) {await f.due(id);await f.next();}
    assert.deepEqual([(await f.get(id)).state,(await f.get(id)).attempts],[state,attempts]);
    assert.equal(await f.next(),false);
  }
  const count=f.calls.length;
  const abandoned=randomUUID();
  await f.put(abandoned);
  await f.db.query("UPDATE sms_messages SET state='sending',attempts=1,lease_until=now(),lease_id=$2 WHERE id=$1",[abandoned,randomUUID()]);
  await f.next();
  assert.equal((await f.get(abandoned)).state,'uncertain');
  const revoked=randomUUID();
  await f.put(revoked);
  await f.db.query("UPDATE memberships SET role='member' WHERE workspace_id=$1 AND account_id=$2",[f.owner.workspace,f.owner.id]);
  await f.next();
  await f.db.query("UPDATE memberships SET role='owner' WHERE workspace_id=$1 AND account_id=$2",[f.owner.workspace,f.owner.id]);
  assert.equal((await f.get(revoked)).errorCode,'SMS_PERMISSION_CHANGED');
  const changed=randomUUID();
  await f.put(changed);
  f.sms.clear();
  await f.next();
  assert.equal((await f.get(changed)).errorCode,'SMS_BINDING_CHANGED');
  assert.equal(f.calls.length,count);
  const sink=await alertFixture(t);
  const origin=await f.app.listen({host:'127.0.0.1',port:0});
  const monitored={...sink.env,FAI_PROBE_ORIGIN:origin,FAI_PROBE_WORKSPACE_ID:f.owner.workspace,
    FAI_PROBE_SESSION:f.owner.headers.authorization.slice(7)};
  const observed=await runCli(monitored);
  assert.equal(observed.status,1);
  assert.deepEqual(sink.received[0].body.issues,['SMS_SEND_FAILED']);
  assert.doesNotMatch(JSON.stringify(sink.received[0].body),/12025550123|sample-order|fixture-key/);
});

const probeFile=fileURLToPath(new URL('../src/ops-probe.js',import.meta.url));
async function runCli(env) {
  const local={...process.env};
  for (const key of Object.keys(local)) if (key.startsWith('FAI_PROBE_') || key.startsWith('FAI_ALERT_')) delete local[key];
  try {
    const result=await promisify(execFile)(process.execPath,[probeFile],{env:{...local,...env},windowsHide:true});
    return {status:0,sample:JSON.parse(result.stdout)};
  } catch (error) {
    if (!error.stdout) throw error;
    return {status:error.code,sample:JSON.parse(error.stdout)};
  }
}

async function alertFixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'fai-test-alerts-'));
  t.after(async()=>{
    for (const file of await readdir(directory)) await unlink(join(directory,file));
    await rmdir(directory);
  });
  let ready=true, live=true, accept=true, drop=false;
  const received=[];
  const origin=await listen(t,(req,res)=>{
    if (drop) return req.socket.destroy();
    if (req.url==='/ready') return reply(res,{status:ready?'ready':'error'},ready?200:503);
    return reply(res,{status:live?'ok':'error'},live?200:503);
  });
  const receiver=await listen(t,async (req,res)=>{
    const body=JSON.parse(await read(req));
    received.push({body,headers:req.headers});
    if (req.url==='/bot') return reply(res,{code:accept?0:19021});
    reply(res,{},accept?200:503);
  });
  const file=join(directory,'monitor.sqlite');
  const env={FAI_PROBE_ORIGIN:origin,FAI_ALERT_WEBHOOK_URL:receiver+'/events',FAI_ALERT_STATE_FILE:file,FAI_ALERT_SERVICE:'fixture-studio'};
  const due=()=>{
    const db=new DatabaseSync(file);
    try {db.exec('UPDATE outbox SET available_at=0');} finally {db.close();}
  };
  return {env,due,received,receiver,ready:v=>{ready=v;},live:v=>{live=v;},accept:v=>{accept=v;},drop:v=>{drop=v;}};
}

test('probe CLI persists webhook retries across processes and emits ordered fault, change and recovery events',async t=>{
  const f=await alertFixture(t);
  let webhook=f.env.FAI_ALERT_WEBHOOK_URL;
  const run=()=>runCli({...f.env,FAI_ALERT_WEBHOOK_URL:webhook,FAI_ALERT_TOKEN:'fixture-monitor-token'});
  assert.equal((await run()).status,0);
  assert.equal(f.received.length,0);
  f.drop(true);f.accept(false);
  const down=await run();
  assert.equal(down.status,1);
  assert.deepEqual(down.sample.notification,{sent:0,pending:1});
  assert.deepEqual(f.received[0].body.issues,['DATABASE_NOT_READY','PROCESS_UNAVAILABLE']);
  assert.equal(f.received[0].body.type,'firing');
  await run();
  assert.equal(f.received.length,1);
  f.drop(false);f.ready(false);
  assert.equal((await run()).sample.notification.pending,2);
  f.ready(true);
  assert.equal((await run()).sample.notification.pending,3);
  webhook=f.receiver+'/rotated';
  if (wallClock) await sleep(15100);
  else f.due();
  f.accept(true);
  const concurrent=await Promise.all([run(),run()]);
  assert.equal(concurrent.reduce((sum,r)=>sum+r.sample.notification.sent,0),3);
  assert.equal((await run()).status,0);
  assert.deepEqual(f.received.map(r=>r.body.type),['firing','firing','updated','resolved']);
  assert.equal(f.received[0].body.id,f.received[1].body.id);
  assert.ok(f.received.every(r=>r.headers['idempotency-key']===r.body.id && r.headers.authorization==='Bearer fixture-monitor-token'));
  assert.equal(new Set(f.received.map(r=>r.body.incident)).size,1);
  assert.deepEqual(f.received.at(-1).body.previousIssues,['DATABASE_NOT_READY']);
  assert.ok(f.received.every(r=>!JSON.stringify(r.body).includes('127.0.0.1')));
  f.live(false);
  await run();
  assert.notEqual(f.received.at(-1).body.incident,f.received[0].body.incident);
});

test('signed Feishu alert waits for a successful application acknowledgment and sends recovery',async t=>{
  const f=await alertFixture(t);
  const run=()=>runCli({...f.env,FAI_ALERT_WEBHOOK_URL:f.receiver+'/bot',FAI_ALERT_FORMAT:'feishu',FAI_ALERT_SIGNING_SECRET:'fixture-signing'});
  f.ready(false);f.accept(false);
  assert.equal((await run()).sample.notification.pending,1);
  f.due();f.accept(true);
  assert.equal((await run()).sample.notification.sent,1);
  f.ready(true);
  assert.equal((await run()).status,0);
  assert.match(f.received[1].body.content.text,/发生告警[\s\S]*DATABASE_NOT_READY/);
  assert.match(f.received[2].body.content.text,/恢复正常/);
  for (const {body} of f.received) {
    assert.equal(body.msg_type,'text');
    assert.equal(body.sign,createHmac('sha256',body.timestamp+'\nfixture-signing').update('').digest('base64'));
  }
});
