import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { migrate, postgres, row } from '../src/db.js';
import { createRealtimeBindings, isVoiceSdp } from '../src/realtime-provider.js';
import { maintainRealtimeVoice } from '../src/realtime-voice.js';
import { provisionCredits } from '../src/wallet.js';
import { startWorker } from '../src/worker.js';

const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
const bindings = new Map(), scenarios = new Map(), calls = new Map();
const sessions = '/v1/voice/realtime/sessions/';
const options = '/v1/voice/realtime/options';
const offer = ['v=0','o=- 1 1 IN IP4 127.0.0.1','s=fixture','t=0 0','m=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2','a=sendrecv','a=ice-ufrag:fixture','a=ice-pwd:local-fixture-password',
  'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'),''].join('\r\n');
const answer = offer.replace('s=fixture','s=fixture-answer');
let app, server, baseUrl;

before(async () => {
  await migrate(db);
  app = await buildApp({db,realtimeVoice:bindings});
  server = createServer(async (req,res) => {
    if (req.method === 'POST' && req.url === '/v1/realtime/calls') {
      const form = await new Response(req,{headers:req.headers}).formData();
      const session = JSON.parse(form.get('session'));
      const mock = scenarios.get(session.model);
      mock.sent.push({session,offer:form.get('sdp'),headers:req.headers});
      mock.started.resolve();
      await mock.gate;
      const id = 'rtc_' + randomUUID();
      calls.set(id,mock);
      res.writeHead(mock.status,{location:mock.location ?? '/v1/realtime/calls/'+id,'content-type':'application/sdp'});
      return res.end(mock.answer);
    }
    const match = /^\/v1\/realtime\/calls\/(rtc_[\w-]+)\/hangup$/.exec(req.url);
    if (req.method === 'POST' && match && calls.has(match[1])) {
      const mock = calls.get(match[1]);
      mock.hangups++;
      mock.hungUp?.resolve();
      res.writeHead(mock.hangupStatus); return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
});
after(async () => { await app?.close(); if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });

async function api(method,url,status,headers={},payload) {
  const response = await app.inject({method,url,headers,payload});
  assert.equal(response.statusCode,status,response.body);
  return response.json();
}
async function account() {
  const user = await api('POST','/v1/auth/register',201,{}, await registrationPayload(app, {type:'enterprise',workspaceName:'Voice tests',displayName:'Test member',
    email:randomUUID()+'@example.test',password:'local-fixture-password'}));
  const workspace = user.workspaces[0].id;
  return {user,workspace,headers:{authorization:'Bearer '+user.token,'x-workspace-id':workspace}};
}
async function fixture(t) {
  const owner = await account();
  const {workspace,user,headers} = owner;
  const model = 'fixture-' + randomUUID();
  const definition = {workspaceId:workspace,model,voice:'marin',credits:3,durationSeconds:90,baseUrl,keyEnv:'TEST_VOICE_KEY'};
  const binding = createRealtimeBindings({REALTIME_VOICE_BINDINGS_JSON:JSON.stringify([definition]),TEST_VOICE_KEY:'fixture-key'}).get(workspace);
  bindings.set(workspace,binding);
  const mock = {started:Promise.withResolvers(),sent:[],status:201,answer,hangupStatus:200,hangups:0};
  scenarios.set(model,mock);
  t.after(() => mock.release?.());
  await provisionCredits(db,workspace,user.account.id,20,'realtime-test');
  const id = randomUUID(), url = sessions + id, key = [workspace,user.account.id,id];
  const put = (status,payload={offerSdp:offer}) => api('PUT',url,status,headers,payload);
  const wallet = () => api('GET','/v1/credits/wallet',200,headers);
  const record = () => row(db,'SELECT * FROM realtime_voice_sessions WHERE workspace_id=$1 AND account_id=$2 AND id=$3',key);
  const due = () => db.query('UPDATE realtime_voice_sessions SET next_action_at=now() WHERE workspace_id=$1 AND account_id=$2 AND id=$3',key);
  return {...owner,id,key,url,put,wallet,record,due,mock,binding};
}

test('WebRTC negotiation is private, idempotent, priced and scoped to the exact member', async t => {
  const f=await fixture(t), foreign=await account();
  assert.equal((await api('GET',options,200,f.headers)).credits,3);
  assert.deepEqual(await api('GET',options,200,foreign.headers),{available:false});
  await api('PUT',sessions+randomUUID(),422,foreign.headers,{offerSdp:offer});
  const invite = await api('POST','/v1/invitations',201,f.headers,{email:foreign.user.account.email,role:'member'});
  await api('POST','/v1/invitations/accept',200,foreign.headers,{token:invite.token});
  const member = {...foreign.headers,'x-workspace-id':f.workspace};
  await api('PUT',sessions+randomUUID(),409,member,{offerSdp:offer});
  await api('GET',options,401,{'x-workspace-id':f.workspace});
  await f.put(400,{offerSdp:offer.replace('a=sendrecv','a=recvonly')});
  assert.equal(f.mock.sent.length,0);
  const gate=Promise.withResolvers(); f.mock.gate=gate.promise; f.mock.release=gate.resolve;
  const first=f.put(201);
  await f.mock.started.promise;
  assert.equal((await f.put(202)).state,'opening');
  assert.equal((await f.wallet()).reserved,3);
  assert.equal((await api('PUT',sessions+randomUUID(),409,f.headers,{offerSdp:offer})).error.code,'VOICE_SESSION_BUSY');
  gate.resolve();
  const active=await first;
  assert.equal(active.answerSdp,answer); assert.equal(active.state,'active');
  assert.deepEqual(await f.put(200),active); assert.equal(f.mock.sent.length,1);
  assert.equal(f.mock.sent[0].offer,offer);
  assert.equal(f.mock.sent[0].session.audio.input.turn_detection.interrupt_response,true);
  assert.equal(f.mock.sent[0].headers.authorization,'Bearer fixture-key');
  assert.match(f.mock.sent[0].headers['openai-safety-identifier'],/^[a-f0-9]{64}$/);
  assert.ok(!(await api('GET',f.url,200,f.headers)).answerSdp);
  assert.equal((await api('GET',sessions+'current',200,f.headers)).session.id,f.id);
  assert.equal((await f.put(409,{offerSdp:offer.replace('s=fixture','s=another')})).error.code,'VOICE_OFFER_CHANGED');
  assert.equal((await api('GET',sessions+'current',200,member)).session,null);
  await api('GET',f.url,404,member); await api('DELETE',f.url,404,foreign.headers);
  assert.equal((await api('DELETE',f.url,200,f.headers)).state,'closed');
  assert.equal((await api('DELETE',f.url,200,f.headers)).state,'closed');
  assert.equal((await f.put(200)).state,'closed');
  assert.equal(f.mock.hangups,1); assert.equal((await f.record()).answer_sdp,null);
  assert.deepEqual(await f.wallet(),{available:17,balance:17,reserved:0});
});

test('disabling model tools refuses new paid calls, allows recovery and preserves hangup',async t=>{
  const f=await fixture(t);
  await f.put(201);
  await api('PUT','/v1/plugins/models/state',200,f.headers,{enabled:false});
  assert.deepEqual(await api('GET',options,200,f.headers),{available:false});
  assert.equal((await f.put(200)).state,'active');
  await api('DELETE',f.url,200,f.headers);
  const refused=await api('PUT',sessions+randomUUID(),409,f.headers,{offerSdp:offer});
  assert.equal(refused.error.code,'PLUGIN_DISABLED');
  assert.equal(f.mock.sent.length,1);
  assert.equal((await f.wallet()).reserved,0);
});

test('hanging up during negotiation releases the reservation and closes the late upstream call', async t => {
  const f=await fixture(t);
  const gate=Promise.withResolvers(); f.mock.gate=gate.promise; f.mock.release=gate.resolve;
  const creation=f.put(200);
  await f.mock.started.promise;
  assert.equal((await api('DELETE',f.url,202,f.headers)).state,'closing');
  gate.resolve();
  assert.equal((await creation).state,'closed');
  assert.equal(f.mock.hangups,1); assert.equal(f.mock.sent.length,1);
  assert.deepEqual(await f.wallet(),{available:20,balance:20,reserved:0});
});

test('rejected or incomplete answers release credits without resubmission or following a foreign location', async t => {
  for (const variant of ['rejection','unknown','bad-answer','foreign-location']) {
    const f=await fixture(t);
    if (variant==='rejection') f.mock.status=429;
    if (variant==='unknown') f.mock.status=503;
    if (variant==='bad-answer') f.mock.answer='not SDP';
    if (variant==='foreign-location') f.mock.location='https://elsewhere.invalid/v1/realtime/calls/rtc_elsewhere';
    const failed=await f.put(200);
    assert.equal(failed.errorCode,({rejection:'PROVIDER_REJECTED',unknown:'PROVIDER_OUTCOME_UNKNOWN','bad-answer':'INVALID_PROVIDER_RESULT','foreign-location':'PROVIDER_OUTCOME_UNKNOWN'})[variant]);
    assert.equal(failed.state,variant==='bad-answer'?'closed':'failed');
    assert.equal(f.mock.hangups,variant==='bad-answer'?1:0);
    assert.equal((await f.put(200)).errorCode,failed.errorCode);
    assert.equal(f.mock.sent.length,1);
    assert.deepEqual(await f.wallet(),{available:20,balance:20,reserved:0});
  }
});

test('worker expires active calls and resumes failed hangups against the original binding', async t => {
  const f=await fixture(t);
  await f.put(201);
  f.mock.hangupStatus=503; await f.due();
  await Promise.all([maintainRealtimeVoice(db,bindings),maintainRealtimeVoice(db,bindings)]);
  assert.equal(f.mock.hangups,1); assert.equal((await f.record()).answer_sdp,null);
  assert.equal((await api('GET',f.url,200,f.headers)).state,'closing');
  const otherBinding={...f.binding,fingerprint:'new origin',hangup:()=>assert.fail('Wrong provider')};
  await f.due(); await maintainRealtimeVoice(db,new Map([[f.workspace,otherBinding]]),f.key);
  assert.equal(f.mock.hangups,1);
  f.mock.hangupStatus=404; await f.due(); await maintainRealtimeVoice(db,bindings,f.key);
  assert.equal((await api('GET',f.url,200,f.headers)).state,'closed');
  assert.equal((await f.wallet()).balance,17);
});

test('restart recovery releases an abandoned opening; a late answer gets hung up and never billed', async t => {
  const f=await fixture(t), gate=Promise.withResolvers();
  f.mock.gate=gate.promise; f.mock.release=gate.resolve;
  const pending=f.put(200);
  await f.mock.started.promise;
  await f.due(); await maintainRealtimeVoice(db,bindings,f.key);
  assert.equal((await f.record()).error_code,'PROVIDER_OUTCOME_UNKNOWN');
  assert.deepEqual(await f.wallet(),{available:20,balance:20,reserved:0});
  assert.equal((await f.put(200)).state,'failed');
  gate.resolve(); assert.equal((await pending).state,'closed');
  assert.equal(f.mock.hangups,1); assert.equal(f.mock.sent.length,1); assert.equal((await f.wallet()).balance,20);
});

test('lost database commit acknowledgment replays persistence without another provider call or debit', async t => {
  const f=await fixture(t);
  let injected=false;
  const flaky = {query:(...args)=>db.query(...args),async transaction(run) {
    let activating=false;
    const result=await db.transaction(tx=>run({query:(sql,args)=>{
      if (sql.includes('SET state=$4,provider_call_id') && args[3]==='active') activating=true;
      return tx.query(sql,args);
    }}));
    if (activating && !injected) { injected=true; throw new Error('Simulated lost commit reply'); }
    return result;
  }};
  const instance=await buildApp({db:flaky,realtimeVoice:bindings});
  t.after(()=>instance.close());
  const result=await instance.inject({method:'PUT',url:f.url,headers:f.headers,payload:{offerSdp:offer}});
  assert.equal(result.statusCode,201,result.body);
  assert.equal(result.json().answerSdp,answer); assert.ok(injected);
  assert.equal(f.mock.sent.length,1); assert.equal((await f.wallet()).balance,17);
  await api('DELETE',f.url,200,f.headers);
});

test('a blocked task worker does not postpone deadline hangups', async t => {
  const f=await fixture(t), gate=Promise.withResolvers();
  f.mock.hungUp=Promise.withResolvers();
  await f.put(201); await f.due();
  let resolutions=0;
  const stop=startWorker({db,realtimeVoice:bindings,providers:new Map(),shops:new Map(),
    resolveDatabase:()=>++resolutions===1 ? gate.promise : db}, {error:()=>{}});
  let timer;
  try {
    const timeout=new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Expiration waited for the task worker')),5000);});
    await Promise.race([f.mock.hungUp.promise,timeout]);
    assert.equal(f.mock.hangups,1);
  } finally {
    clearTimeout(timer); gate.resolve(null); await stop();
  }
  assert.equal((await f.record()).state,'closed');
});

test('binding validation keeps external credentials on the server and signaling audio-only', () => {
  const entry={workspaceId:randomUUID(),model:'test',voice:'marin',durationSeconds:15,credits:2};
  const configure=(entries,env={})=>createRealtimeBindings({REALTIME_VOICE_BINDINGS_JSON:JSON.stringify(entries),...env});
  assert.equal(createRealtimeBindings({}).size,0);
  assert.throws(()=>configure([entry]),/credential/);
  assert.throws(()=>configure([{...entry,baseUrl:'http://example.test/v1'}]),/baseUrl/);
  assert.throws(()=>configure([{...entry,keyEnv:'BAD-KEY'}]),/environment/);
  assert.throws(()=>configure([{...entry,credits:0}]),/Invalid/);
  assert.throws(()=>configure([entry,entry].map(e=>({...e,baseUrl}))),/Duplicate/);
  assert.ok(!isVoiceSdp(offer+'m=video 9 UDP/TLS/RTP/SAVPF 111\r\n'));
  assert.ok(!isVoiceSdp(offer.replace('a=ice-ufrag:fixture','')));
});
