import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { catalog } from '../src/catalog.js';
import { migrate, postgres } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';
import { createExaSearch } from '../src/web-search.js';
import { ProviderError } from '../src/model-http.js';
import { probe } from '../src/ops-probe.js';
import { bindPluginV1 } from '../sdk/workspace-v1.mjs';
import { manifest,overview } from '../sdk/examples/asset-inbox.mjs';
import { exportTaskLogs } from '../src/task-log-export.js';
import { observationSummary } from '../src/ops-observation.js';
import { mkdtemp,readFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
const providers = createProviders();
const shops = new Map();
const received = [];
const searches = [];
const webSearch = createExaSearch('fixture-search-key',async (url,options) => {
  searches.push({url,options});
  if (options.body.query === 'fail') throw new ProviderError('PROVIDER_UNREACHABLE',true);
  return { results: [
    {title:'Source',url:'https://example.test/a',highlights:['First','second']},
    {title:'Unsafe link',url:'javascript:void(0)'},
    {title:'Duplicate',url:'https://example.test/a'},
  ] };
});
providers.set('model:qa-text', {
  info: { id:'qa-text', model:'fixture', protocol:'chat-completions', kind:'text' },
  supports: capability => capability.id === 'model.chat',
  async run(task, payload) {
    received.push(payload);
    return {type:'text',text:'QA output'};
  },
});

let app, owner, visitor, member;
async function request(method, url, status, session, payload) {
  const headers = session ? { authorization:'Bearer ' + session.token, 'x-workspace-id':session.workspace } : {};
  const result = await app.inject({method,url,payload,headers});
  assert.equal(result.statusCode,status,result.body);
  return result.statusCode === 204 ? undefined : result.json();
}

before(async () => {
  await migrate(db);
  app = await buildApp({db,providers,shops,webSearch});
  await app.ready();
  async function signup(email, type) {
    const account = await request('POST','/v1/auth/register',201,undefined,await registrationPayload(app, {
      email,password:'test-workspace-tools-42',displayName:email,type,
      ...(type === 'enterprise' ? {workspaceName:'Workspace tools QA'} : {}),
    }));
    return {...account,workspace:account.workspaces[0].id};
  }
  owner = await signup('workspace-tools-owner@example.test','enterprise');
  visitor = await signup('workspace-tools-other@example.test','personal');
  const invite = await request('POST','/v1/invitations',201,owner,{email:visitor.account.email,role:'member'});
  await request('POST','/v1/invitations/accept',200,visitor,{token:invite.token});
  member = {...visitor,workspace:owner.workspace};
});

after(async () => {
  await app?.close();
  await db.close();
});

test('confirmed memory evolution is versioned, reversible and scoped to each member or enterprise', async () => {
  for (const scope of ['personal','enterprise']) {
    const item=await request('POST','/v1/memory',201,owner,{scope,content:'Original QA'});
    const path='/v1/memory/'+item.id+'/changes', event=path+'/'+randomUUID();
    const update={action:'update',revision:item.revision,content:'Revised QA'};
    assert.equal(item.revision,0);
    await request('GET',path,404,visitor);
    await request('PUT',event,scope==='personal'?404:403,member,update);
    const results=await Promise.all([request('PUT',event,200,owner,update),request('PUT',event,200,owner,update)]);
    assert.deepEqual(results[0],results[1]);
    const recall='/v1/memory?scope='+scope+'&q=Revised';
    assert.ok((await request('GET',recall,200,owner)).items.some(i=>i.id===item.id));
    assert.equal((await request('GET',recall,200,member)).items.some(i=>i.id===item.id),scope==='enterprise');
    await request('PUT',path+'/'+randomUUID(),409,owner,update);
    const undo=await request('PUT',path+'/'+randomUUID(),200,owner,{action:'undo',revision:1});
    assert.equal(undo.revision,2);
    assert.equal((await request('GET','/v1/memory?scope='+scope,200,owner)).items.find(i=>i.id===item.id).content,'Original QA');
    await request('PUT',event,200,owner,update);
    await request('PUT',event,409,owner,{...update,content:'Conflict'});
    const history=await request('GET',path,200,scope==='enterprise'?member:owner);
    assert.deepEqual(history.items.map(i=>i.action),['undo','update']);
    assert.ok(!JSON.stringify(history).includes('Original QA'));
    await request('DELETE','/v1/memory/'+item.id,204,owner);
    assert.equal((await db.query('SELECT count(*) AS n FROM memory_changes WHERE item_id=$1',[item.id])).rows[0].n.toString(),'0');
  }
});

test('workspace image templates require manager grants, keep immutable revisions and isolate batch rendering',async()=>{
  const root='/v1/media/images/platform-templates', target=root+'/taobao';
  const initial={revision:0,width:240,height:320,fit:'contain',format:'png'};
  await request('PUT',target,403,member,initial);
  const first=await request('PUT',target,200,owner,initial);
  assert.equal(first.revision,1);
  assert.deepEqual(await request('PUT',target,200,owner,initial),first);
  await request('PUT',target,409,owner,{...initial,width:300});
  assert.deepEqual((await request('GET',root,200,member)).items,[first]);
  assert.deepEqual((await request('GET',root,200,visitor)).items,[]);
  const revisions=await Promise.all([360,480].map((width,index)=>app.inject({method:'PUT',url:target,
    headers:{authorization:'Bearer '+owner.token,'x-workspace-id':index?owner.workspace.toUpperCase():owner.workspace},payload:{...initial,width,revision:1}})));
  assert.deepEqual(revisions.map(r=>r.statusCode).sort(),[200,409]);
  const input={id:randomUUID(),items:[{key:'preview',assetIds:[randomUUID()],platformTemplate:{platform:'taobao',revision:1}}]};
  const batch='/v1/media/images/batches';
  await request('POST',batch,404,visitor,input);
  await request('POST',batch,400,owner,{...input,items:[{...input.items[0],width:800,height:800}]});
  assert.equal((await request('POST',batch,201,owner,input)).items[0].error,'SOURCE_UNAVAILABLE');
  await request('PUT','/v1/plugins/image/state',200,owner,{enabled:false});
  try {await request('PUT',target,409,owner,{...initial,revision:2});}
  finally {await request('PUT','/v1/plugins/image/state',200,owner,{enabled:true});}
});

test('versioned sample plugin uses authenticated asset and notification routes and honors revocation', async () => {
  let allowed=true;
  const transport=async (method,url,input)=>request(method,url,method==='POST'?201:200,owner,input);
  const writer=bindPluginV1(transport,{sdkVersion:1,permissions:['assets.write']},()=>true);
  const asset=await writer.uploadAsset({name:'Plugin QA',mediaType:'image/png',source:'fixture',purpose:'SDK',
    dataBase64:Buffer.from('89504e470d0a1a0a','hex').toString('base64')});
  const reader=bindPluginV1(transport,manifest,()=>allowed);
  assert.ok((await overview(reader)).recentAssets.some(a=>a.id===asset.id));
  assert.equal((await reader.asset(asset.id)).name,'Plugin QA');
  assert.equal(reader.uploadAsset,undefined);
  allowed=false;
  assert.throws(()=>reader.asset(asset.id),/DENIED/);
  assert.throws(()=>bindPluginV1(transport,{...manifest,sdkVersion:2},()=>true),/manifest/);
  assert.throws(()=>bindPluginV1(transport,{...manifest,permissions:['everything']},()=>true),/permission/);
  await request('GET','/v1/assets/'+asset.id,404,member);
});

test('committed task logs rotate by UTC date, expire, and exclude business content',async t=>{
  const root=await mkdtemp(join(tmpdir(),'fai-task-logs-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await provisionCredits(db,owner.workspace,owner.account.id,1,'event-export-qa');
  const task=await request('POST','/v1/tasks',202,owner,{capabilityId:'copywriting.detect-terms',mode:'workflow',
    parameters:{content:'DO-NOT-LOG-QA-SENTINEL'},idempotencyKey:randomUUID()});
  await request('POST','/v1/tasks/'+task.id+'/cancel',200,owner);
  const query='/v1/diagnostics/task-events?taskId='+task.id+'&level=info&from=2020-01-01T00:00:00Z';
  assert.deepEqual((await request('GET',query,200,owner)).items.map(e=>e.event),['cancelled','queued']);
  await request('GET',query,403,member);
  assert.deepEqual((await request('GET',query,200,visitor)).items,[]);
  const now=Date.now(), today=new Date(now).toISOString().slice(0,10);
  await exportTaskLogs(db,owner.workspace,root,2,now);
  const directory=join(root,owner.workspace);
  const file=join(directory,'tasks-'+today+'.jsonl');
  const yesterday=new Date(now-86400000).toISOString().slice(0,10);
  await db.query("UPDATE task_events SET created_at=$2 WHERE task_id=$1 AND event='cancelled'",[task.id,yesterday+'T12:00:00Z']);
  await exportTaskLogs(db,owner.workspace,root,2,now);
  assert.ok((await readFile(join(directory,'tasks-'+yesterday+'.jsonl'),'utf8')).includes(task.id));
  const content=await readFile(file,'utf8');
  assert.ok(!content.includes('DO-NOT-LOG') && !content.includes(owner.token));
  assert.equal(content.trim().split('\n').map(JSON.parse).filter(r=>r.taskId===task.id && r.level==='info' && r.event==='queued').length,1);
  await exportTaskLogs(db,owner.workspace,root,2,now);
  assert.equal(await readFile(file,'utf8'),content);
  await exportTaskLogs(db,visitor.workspace,root,2,now);
  for (const name of await readdir(join(root,visitor.workspace))) assert.ok(!(await readFile(join(root,visitor.workspace,name),'utf8')).includes(task.id));
  await exportTaskLogs(db,owner.workspace,root,2,now+2*86400000);
  assert.ok(!(await readdir(directory)).includes('tasks-'+today+'.jsonl'));
});

test('continuous observation earns seven days only with a full uninterrupted candidate window',()=>{
  const samples=Array.from({length:7*24*60+1},(_,i)=>({ok:true,time:i*60000}));
  assert.equal(observationSummary(samples.slice(1)).qualified,false);
  assert.equal(observationSummary(samples).qualified,true);
  assert.equal(observationSummary(samples,samples.at(-1).time+180000).qualified,false);
  samples[200].ok=false;
  assert.equal(observationSummary(samples).qualified,false);
  samples.splice(400,5);
  assert.equal(observationSummary(samples).gaps,1);
});

test('workspace skills and experts are scoped and support chat, state and revisions', async () => {
  const root = '/v1/library';
  const catalogEntries = (await request('GET',root,200,member)).items;
  assert.equal(catalogEntries.filter(r=>r.kind==='skill').length,3);
  assert.equal(catalogEntries.filter(r=>r.kind==='expert').length,3);
  assert.equal(catalogEntries.filter(r=>r.kind==='team').length,1);
  const body = { kind:'skill',name:'QA spec audit',description:'Classifies submitted specs.',instructions:'Review supplied fields.',relatedIds:[] };
  await request('POST',root,403,member,body);
  const skill = await request('POST',root,201,owner,body);
  const id = root + '/' + skill.id;
  await request('GET',id,404,visitor);
  assert.equal((await request('GET',root+'?kind=skill&q=spec%20audit',200,member)).items[0].id,skill.id);
  const {kind,...draft} = body;
  const skillEdit = await request('PUT',id,200,owner,{...draft,instructions:'Use fixture instructions.',revision:skill.revision});
  await request('PUT',id,409,owner,{...draft,revision:skill.revision});
  const expert = await request('POST',root,201,owner,{
    kind:'expert',name:'QA specialist',description:'',instructions:'Output QA notes.',relatedIds:[skill.id],
  });
  await request('DELETE',id,409,owner);
  const team = await request('POST',root,201,owner,{
    kind:'team',name:'QA group',description:'',instructions:'Report prioritized findings.',relatedIds:[expert.id],
  });
  const key = randomUUID();
  const capabilityId = 'model.chat';
  await provisionCredits(db,member.workspace,member.account.id,50,'workspace-guidance');
  const chat = { capabilityId,modelId:'qa-text',mode:'chat',idempotencyKey:key,
    parameters:{ guidanceIds:[team.id],messages:[{role:'system',content:'Use a table.'},{role:'user',content:'Spec A'}] } };
  const submitted = await request('POST','/v1/tasks',202,member,chat);
  assert.equal((await request('POST','/v1/tasks',200,member,chat)).id,submitted.id);
  assert.equal(await workOnce({db,providers,shops}),true);
  const taskUrl = '/v1/tasks/' + submitted.id;
  assert.equal((await request('GET',taskUrl,200,member)).state,'succeeded');
  const events = (await request('GET',taskUrl+'/events',200,member)).items;
  assert.deepEqual(events.map(event=>event.event),['succeeded','running','queued']);
  assert.ok(!JSON.stringify(events).includes(chat.parameters.messages[1].content));
  assert.deepEqual((await request('GET',taskUrl+'/events?level=error',200,member)).items,[]);
  await request('GET',taskUrl+'/events',404,owner);
  await request('GET',taskUrl+'/events',404,visitor);
  const [outbound] = received;
  assert.equal(Object.hasOwn(outbound.parameters,'guidanceIds'),false);
  assert.match(outbound.parameters.messages[0].content,/QA group:[\s\S]*QA specialist:[\s\S]*Use fixture instructions\.[\s\S]*Use a table\./);
  assert.deepEqual(outbound.parameters.messages[1],chat.parameters.messages[1]);
  assert.equal(skillEdit.revision,skill.revision+1);
  await request('PUT',id+'/state',200,owner,{enabled:false});
  const blocked = await request('POST','/v1/tasks',409,member,{...chat,idempotencyKey:randomUUID()});
  assert.equal(blocked.error.code,'LIBRARY_DISABLED');
  const builtin = catalogEntries[0];
  await request('PUT',root+'/'+builtin.id+'/state',200,owner,{enabled:false});
  assert.equal((await request('GET',root+'/'+builtin.id,200,visitor)).enabled,true);
  await request('DELETE',root+'/'+team.id,204,owner);
  await request('DELETE',root+'/'+expert.id,204,owner);
  await request('DELETE',id,204,owner);
});

test('enterprise task limits count reservations and settled credits and preserve replay', async () => {
  const cap = 'copywriting.detect-terms';
  const cost = catalog.get(cap).cost;
  const self = '/v1/credits/limit';
  const limitPath = '/v1/credits/members/' + member.account.id + '/limit';
  const settled = (await request('GET',self,200,member)).spent;
  const limit = Number(settled) + 2*cost;
  await request('PUT',limitPath,403,member,{limit});
  await request('PUT','/v1/credits/members/'+owner.account.id+'/limit',403,owner,{limit});
  await request('PUT',limitPath,200,owner,{limit});
  const make = () => ({capabilityId:cap,mode:'workflow',parameters:{content:'QA text'},idempotencyKey:randomUUID()});
  const first = make();
  const task = await request('POST','/v1/tasks',202,member,first);
  await request('POST','/v1/tasks',202,member,make());
  const error = await request('POST','/v1/tasks',409,member,make());
  assert.equal(error.error.code,'CREDIT_LIMIT_EXCEEDED');
  assert.equal((await request('POST','/v1/tasks',200,member,first)).id,task.id);
  assert.deepEqual(await request('GET',self,200,member),{limit,spent:settled,reserved:2*cost});
  await request('POST','/v1/tasks/'+task.id+'/cancel',200,member);
  await request('POST','/v1/tasks',202,member,make());
  assert.equal(await workOnce({db,providers,shops}),true);
  assert.equal(await workOnce({db,providers,shops}),true);
  assert.deepEqual(await request('GET',self,200,member),{limit,spent:String(limit),reserved:0});
  assert.equal((await request('POST','/v1/tasks',409,member,make())).error.code,'CREDIT_LIMIT_EXCEEDED');
  assert.equal((await request('PUT',limitPath,200,owner,{limit:null})).limit,null);
  await request('POST','/v1/tasks',202,member,make());
});

test('feedback replay, onboarding progress and diagnostics keep their access boundaries', async () => {
  const input={id:randomUUID(),category:'suggestion',message:'Test feedback'};
  const first = await request('POST','/v1/feedback',201,member,input);
  assert.deepEqual(await request('POST','/v1/feedback',200,member,input),first);
  await request('POST','/v1/feedback',409,member,{...input,message:'Other text'});
  assert.deepEqual((await request('GET','/v1/feedback',200,member)).items,[first]);
  assert.deepEqual((await request('GET','/v1/feedback',200,visitor)).items,[]);
  assert.deepEqual((await request('GET','/v1/feedback',200,owner)).items,[]);
  await request('PATCH','/v1/settings',200,member,{onboardingStep:3});
  assert.equal((await request('GET','/v1/settings',200,member)).preferences.onboardingStep,3);
  assert.equal((await request('GET','/v1/settings',200,visitor)).preferences.onboardingStep,undefined);
  await request('PATCH','/v1/settings',400,member,{onboardingStep:7});
  await request('GET','/v1/diagnostics',403,member);
  const diagnosis = await request('GET','/v1/diagnostics',200,owner);
  assert.equal(diagnosis.database,'ok');
  assert.match(diagnosis.nodeVersion,/^\d+\./);
  assert.ok(BigInt(diagnosis.memoryBytes)>0n);
});

test('queue diagnostics separate runnable, delayed and expired work and require workspace management', async () => {
  const endpoint='/v1/diagnostics/queue';
  await request('GET',endpoint,401,{workspace:owner.workspace});
  await request('GET',endpoint,403,member);
  const user=await request('POST','/v1/auth/register',201,undefined,await registrationPayload(app, {
    email:'queue-health-owner@example.test',password:'test-workspace-tools-42',displayName:'Queue QA',type:'personal',
  }));
  const account={...user,workspace:user.workspaces[0].id};
  const empty={queued:0,runnable:0,running:0,expiredLeases:0,dueSchedules:0,oldestRunnableSeconds:null};
  assert.deepEqual(await request('GET',endpoint,200,account),empty);
  await provisionCredits(db,account.workspace,account.account.id,10,'queue-health-seed');
  const submission=()=>({capabilityId:'copywriting.detect-terms',mode:'workflow',
    parameters:{content:'Queue diagnostic sample'},idempotencyKey:randomUUID()});
  const [ready,delayed,expired,active]=await Promise.all(Array.from({length:4},()=>request('POST','/v1/tasks',202,account,submission())));
  await db.query("UPDATE tasks SET available_at=now()-interval '2 minutes' WHERE id=$1",[ready.id]);
  await db.query("UPDATE tasks SET available_at=now()+interval '1 hour' WHERE id=$1",[delayed.id]);
  for (const [task,minutes] of [[expired,-1],[active,1]]) {
    await db.query("UPDATE tasks SET state='running',lease_id=$2,lease_until=now()+($3::integer * interval '1 minute') WHERE id=$1",
      [task.id,randomUUID(),minutes]);
  }
  const runAt=new Date(Date.now()+3600000).toISOString();
  const due=await request('POST','/v1/schedules',201,account,{...submission(),runAt});
  await request('POST','/v1/schedules',201,account,{...submission(),runAt});
  await db.query("UPDATE schedules SET run_at=now()-interval '3 minutes' WHERE id=$1",[due.id]);
  const {oldestRunnableSeconds,...counts}=await request('GET',endpoint,200,account);
  assert.deepEqual(counts,{queued:2,runnable:1,running:2,expiredLeases:1,dueSchedules:1});
  assert.ok(oldestRunnableSeconds>=120 && oldestRunnableSeconds<180);
  assert.deepEqual(await request('GET',endpoint,200,visitor),empty);
  await db.query("UPDATE tasks SET provider_job_id='fixture-poll',lease_id=NULL,lease_until=now()-interval '1 second' WHERE id=$1",[expired.id]);
  assert.equal((await request('GET',endpoint,200,account)).expiredLeases,0);
  const alerts='/v1/diagnostics/alerts';
  await request('GET',alerts,403,member);
  assert.deepEqual((await request('GET',alerts,200,account)).alerts,['QUEUE_DELAY','SCHEDULE_DELAY']);
  await db.query("UPDATE tasks SET lease_until=now()-interval '5 minutes' WHERE id=$1",[expired.id]);
  const url=await app.listen({host:'127.0.0.1',port:0});
  assert.equal((await probe({FAI_PROBE_ORIGIN:url})).ok,true);
  const sample=await probe({FAI_PROBE_ORIGIN:url,FAI_PROBE_WORKSPACE_ID:account.workspace,FAI_PROBE_SESSION:account.token});
  assert.deepEqual(sample.issues,['QUEUE_DELAY','PROVIDER_POLL_DELAY','SCHEDULE_DELAY']);
  assert.equal(sample.ok,false);
  assert.deepEqual((await request('GET',alerts,200,visitor)).alerts,[]);
  assert.deepEqual((await probe({FAI_PROBE_ORIGIN:url,FAI_PROBE_WORKSPACE_ID:account.workspace,FAI_PROBE_SESSION:'expired'})).issues,['WORKSPACE_PROBE_FAILED']);
  await assert.rejects(probe({FAI_PROBE_ORIGIN:'http://example.test'}));
  for (let i=0;i<6;i++) {
    await db.query(`INSERT INTO tasks(id,workspace_id,account_id,capability_id,provider_id,plugin_id,input,
      request_hash,idempotency_key,state,cost,updated_at) VALUES($1,$2,$3,'copywriting.detect-terms','local','copywriting','{}',
      'fixture',$4,$5,1,now()-($6::integer * interval '1 hour'))`,
      [randomUUID(),account.workspace,account.account.id,randomUUID(),i<4?'succeeded':'failed',i===5?2:0]);
  }
  const degraded=await request('GET',alerts,200,account);
  assert.equal(degraded.finished,5);
  assert.equal(degraded.failed,1);
  assert.ok(degraded.alerts.includes('TASK_FAILURE_RATE'));
});

test('member notifications track actual role transitions and respect their own preference', async () => {
  const inbox='/v1/notifications';
  const role='/v1/members/'+member.account.id;
  const events = async () => (await request('GET',inbox,200,member)).items.filter(event=>event.type.startsWith('member.'));
  assert.deepEqual((await events()).map(event=>event.type),['member.joined']);
  await request('PATCH',role,200,owner,{role:'admin'});
  await request('PATCH',role,200,owner,{role:'admin'});
  const before = await events();
  assert.deepEqual(before.map(event=>event.type),['member.role-changed','member.joined']);
  assert.deepEqual(before[0].data,{previousRole:'member',role:'admin'});
  await request('PATCH','/v1/settings',200,member,{memberNotifications:false,taskNotifications:true});
  await request('PATCH',role,200,owner,{role:'member'});
  assert.deepEqual(await events(),before);
  assert.deepEqual((await request('GET',inbox,200,visitor)).items,[]);
});

test('web search sends only the explicit query and normalizes provider results and errors', async () => {
  const url='/v1/search/web';
  assert.deepEqual(await request('GET',url,200,member),{available:true});
  await request('POST',url,401,{workspace:owner.workspace},{query:'QA'});
  await request('POST',url,400,member,{query:'   '});
  const result=await request('POST',url,200,member,{query:' package dimensions ',limit:2});
  assert.deepEqual(result,{items:[{title:'Source',url:'https://example.test/a',excerpt:'First second'}]});
  const [call]=searches;
  assert.equal(call.url.href,'https://api.exa.ai/search');
  assert.deepEqual(call.options.body,{query:'package dimensions',numResults:2,type:'auto',contents:{highlights:true}});
  assert.deepEqual(call.options.headers,{'x-api-key':'fixture-search-key'});
  const failure=await request('POST',url,503,member,{query:'fail'});
  assert.equal(failure.error.code,'SEARCH_PROVIDER_ERROR');
  const disabled=await buildApp({db});
  try {
    const headers = {authorization:'Bearer '+owner.token,'x-workspace-id':owner.workspace};
    const availability = await disabled.inject({method:'GET',url,headers});
    assert.deepEqual(availability.json(),{available:false});
    const unavailable = await disabled.inject({method:'POST',url,headers,payload:{query:'QA'}});
    assert.equal(unavailable.statusCode,503);
    assert.equal(unavailable.json().error.code,'SEARCH_NOT_CONFIGURED');
  } finally { await disabled.close(); }
});
