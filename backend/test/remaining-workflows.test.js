import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { createCustomerAnswer } from '../src/customer-answer.js';
import { migrate, postgres } from '../src/db.js';
import { installModels } from '../src/models.js';
import { createProviders } from '../src/providers.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';
import { workspaceV1 } from '../sdk/workspace-v1.mjs';

const newDb=()=>process.env.FAI_TEST_DATABASE_URL?postgres(process.env.FAI_TEST_DATABASE_URL):new PGlite();
const base='/v1/customer-service/conversations';
const rights='/v1/rights/notices';

async function call(app,member,method,url,status,payload) {
  const response=await app.inject({method,url,payload,headers:member?{
    authorization:'Bearer '+member.token,'x-workspace-id':member.workspace,
  }:{}});
  assert.equal(response.statusCode,status,response.body);
  return status===204?undefined:response.json();
}

async function member(app,email,enterprise=false) {
  const session=await call(app,null,'POST','/v1/auth/register',201,{
    email:email+'@example.test',password:'synthetic-workflow-fixture',displayName:email,
    type:enterprise?'enterprise':'personal',...(enterprise?{workspaceName:'Fixture company'}:{}),
  });
  return {...session,workspace:session.workspaces[0].id};
}

async function join(app,owner,participant) {
  const {token}=await call(app,owner,'POST','/v1/invitations',201,{email:participant.account.email,role:'member'});
  await call(app,participant,'POST','/v1/invitations/accept',200,{token});
  return {...participant,workspace:owner.workspace};
}

async function upload(app,account) {
  const png=createCanvas(96,96).toBuffer('image/png');
  return call(app,account,'POST','/v1/assets',201,{name:'synthetic.png',mediaType:'image/png',
    source:'Local synthetic sample',purpose:'Fixture',dataBase64:png.toString('base64')});
}

async function fixture(t,{withModel=false}={}) {
  const db=newDb();
  const providers=createProviders();
  const shops=new Map();
  const seen=[];
  let signalWaiting;
  let release;
  const started=new Promise(resolve=>{signalWaiting=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  if (withModel) {
    const server=createServer(async (req,res)=>{
      const chunks=[];
      for await (const chunk of req) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));
      seen.push(body);
      if (body.messages.at(-1).content.includes('等待')) {
        signalWaiting();
        await wait;
      }
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{content:'根据已知资料，请保留原包装并交人工核实。'}}]}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{release();await new Promise(resolve=>server.close(resolve));});
    installModels(providers,[{id:'scenario',protocol:'chat-completions',model:'test',capabilities:['model.chat','copywriting.selling-points'],
      baseUrl:'http://127.0.0.1:'+server.address().port}]);
  }
  const app=await buildApp({db,providers,shops,customerAnswer:createCustomerAnswer(providers,withModel?'scenario':undefined)});
  t.after(async()=>{await app.close();await db.close();});
  await migrate(db);
  return {app,db,providers,shops,seen,started,release};
}

test('same-name products isolate answers, citations, follow-ups and replays by stable catalog identity',async t=>{
  const {app}=await fixture(t);
  const owner=await member(app,'product-scope-owner',true);
  const other=await member(app,'product-scope-other',true);
  const req=(method,path,status,body)=>call(app,owner,method,path,status,body);
  const make=(user,sku)=>call(app,user,'POST','/v1/studio/products',201,{name:'测试保温杯',sku});
  const small=await make(owner,'QA-CUP-350'),large=await make(owner,'QA-CUP-750'),foreign=await make(other,'QA-CUP-350');
  const library=await req('POST','/v1/knowledge/bases',201,{name:'保温杯客服'});
  const docs='/v1/knowledge/bases/'+library.id+'/documents';
  const add=(content,customerScope)=>req('POST',docs,201,{name:'测试保温杯',content,customerScope});
  const a=await add('测试保温杯容量为350毫升。',{productId:small.id});
  const b=await add('测试保温杯容量为750毫升。',{productId:large.id});
  const faq=await add('通用清洁步骤：用清水清洗。',{general:true});
  const legacy=await add('测试保温杯容量为未知，旧资料尚未分类。');
  assert.equal(legacy.customerScope,null);
  await req('POST',docs,404,{name:'foreign',content:'private',customerScope:{productId:foreign.id}});
  const start=(selection,status=201)=>req('POST',base,status,{subject:'测试保温杯',knowledgeBaseIds:[library.id],...selection});
  await start({productId:foreign.id},404);
  await start({productId:small.id,productReference:large.sku},400);
  const first=await start({productId:small.id}),second=await start({productReference:large.sku});
  assert.equal(second.productId,large.id);
  const ask=(session,body,status=201)=>req('POST',base+'/'+session.id+'/messages',status,body);
  const question={content:'测试保温杯的容量是多少？',clientId:randomUUID()};
  for (const [session,doc,answer] of [[first,a,'350'],[second,b,'750']]) {
    for (const body of [question,{content:'再说一次？'}]) {
      const turn=await ask(session,body);
      assert.equal(turn.assistant.content,'测试保温杯容量为'+answer+'毫升。');
      assert.deepEqual(turn.assistant.sources.map(item=>item.documentId),[doc.id]);
      assert.equal(turn.assistant.sources[0].customerScope.productId,session.productId);
    }
    assert.deepEqual((await ask(session,{content:'清洁步骤'})).assistant.sources.map(s=>s.documentId),[faq.id]);
  }
  for (const selection of [{},{productReference:'UNKNOWN'}]) {
    const general=await start(selection);
    assert.equal((await ask(general,question)).assistant,null);
    assert.equal((await ask(general,{content:'清洁步骤'})).assistant.sources[0].documentId,faq.id);
  }
  assert.equal((await ask(first,question,200)).assistant.sources[0].documentId,a.id);
  await req('PATCH',docs+'/'+a.id,200,{customerScope:null});
  assert.equal((await ask(first,question,200)).assistant,null);
  assert.equal((await ask(first,{content:'容量',search:'容量'})).assistant,null);
  await req('PATCH',docs+'/'+a.id,200,{customerScope:{productId:small.id}});
  await req('PUT','/v1/studio/products/'+large.id,200,{sku:'QA-CUP-750-R2',name:'测试保温杯'});
  await make(owner,large.sku);
  const reused=await start({productReference:large.sku});
  assert.notEqual(reused.productId,second.productId);
  assert.equal((await ask(reused,question)).assistant,null);
  assert.equal((await ask(second,{content:'容量'})).assistant.sources[0].documentId,b.id);
});

test('model context and in-flight replies honor changes to document product scope',async t=>{
  const {app,seen,started,release}=await fixture(t,{withModel:true});
  const owner=await member(app,'model-product-scope',true);
  const api=(method,path,status,body)=>call(app,owner,method,path,status,body);
  const products=[];
  for (const sku of ['MODEL-S','MODEL-L']) products.push(await api('POST','/v1/studio/products',201,{sku,name:'Model fixture'}));
  const library=await api('POST','/v1/knowledge/bases',201,{name:'Service'});
  const docs='/v1/knowledge/bases/'+library.id+'/documents';
  const add=(content,scope)=>api('POST',docs,201,{name:'容量',content,customerScope:scope});
  const small=await add('容量=SMALL_ONLY',{productId:products[0].id});
  await add('容量=LARGE_ONLY',{productId:products[1].id});
  await add('CARE_GUIDE',{general:true});
  const session=await api('POST',base,201,{subject:'咨询',knowledgeBaseIds:[library.id],productId:products[0].id});
  const messages=base+'/'+session.id+'/messages';
  await api('POST',messages,201,{content:'OLD_QUESTION_MARKER',search:'容量'});
  assert.match(JSON.stringify(seen.at(-1).messages),/SMALL_ONLY/);
  assert.doesNotMatch(JSON.stringify(seen.at(-1).messages),/LARGE_ONLY/);
  const pending=api('POST',messages,201,{content:'等待资料核对',search:'容量'});
  try {
    await Promise.race([started,pending.then(()=>{throw new Error('Expected a pending model request');})]);
    await api('PATCH',docs+'/'+small.id,200,{customerScope:{productId:products[1].id}});
  } finally {release();}
  assert.equal((await pending).assistant,null);
  await api('POST',messages,201,{content:'CARE_GUIDE'});
  assert.doesNotMatch(JSON.stringify(seen.at(-1).messages),/SMALL_ONLY|LARGE_ONLY|OLD_QUESTION_MARKER/);
});

test('customer conversation uses scoped multi-turn knowledge, redacts references and stops during handoff',async t=>{
  const {app,seen,started,release}=await fixture(t,{withModel:true});
  const owner=await member(app,'customer-context-owner',true);
  const customer=await join(app,owner,await member(app,'customer-context-buyer'));
  const outsider=await member(app,'customer-context-outsider');
  const {id:knowledgeId}=await call(app,owner,'POST','/v1/knowledge/bases',201,{name:'Return fixtures'});
  const knowledge='/v1/knowledge/bases/'+knowledgeId;
  await call(app,owner,'PUT',knowledge+'/grants/'+customer.account.id,204);
  await call(app,owner,'POST',knowledge+'/documents',201,{
    name:'Fixture return policy',customerScope:{general:true},content:'退货规则：测试商品需要保留原包装。联系 private-contact@example.test 也可以转人工。',
  });
  const state=await call(app,customer,'POST',base,201,{subject:'退货',knowledgeBaseIds:[knowledgeId],
    productReference:'PRODUCT-FIXTURE',orderReference:'ORDER-FIXTURE'});
  assert.equal(state.orderReference,'ORDER-FIXTURE');
  const messages=base+'/'+state.id+'/messages';
  const first={clientId:randomUUID(),content:'PRODUCT-FIXTURE 的退货规则是什么？订单 ORDER-FIXTURE。',search:'退货规则'};
  const saved=await call(app,customer,'POST',messages,201,first);
  assert.equal(saved.assistant.sources[0].baseId,knowledgeId);
  assert.equal(saved.assistant.replyTo,saved.message.id);
  assert.equal((await call(app,customer,'POST',messages,200,first)).assistant.id,saved.assistant.id);
  assert.equal(seen.length,1);
  await call(app,customer,'POST',messages,409,{...first,content:'不同的内容'});
  for (const question of ['那应该如何处理？','这也适用吗？','还需要留什么？','那再确认一下？','这些都需要吗？','我明白了，还需要注意什么？']) {
    const response=await call(app,customer,'POST',messages,201,{content:question});
    assert.equal(response.assistant.sources[0].baseId,knowledgeId);
  }
  assert.ok(seen.at(-1).messages.some(message=>message.role==='assistant'));
  assert.doesNotMatch(JSON.stringify(seen),/ORDER-FIXTURE|PRODUCT-FIXTURE|private-contact@example\.test/);
  await call(app,outsider,'GET',messages,404);
  const pending=call(app,customer,'POST',messages,201,{content:'等待接管',search:'退货规则'});
  assert.equal(await Promise.race([started.then(()=>true),pending.then(()=>false)]),true);
  try {
    assert.equal((await call(app,owner,'POST',base+'/'+state.id+'/handoff',200)).state,'human');
  } finally {release();}
  assert.equal((await pending).assistant,null);
  assert.equal((await call(app,customer,'GET',messages,200)).items.at(-1).sender,'customer');
});

test('skills run real SKU and copy checks or use the paid, deduplicated model task',async t=>{
  const {app,db,providers,shops,seen}=await fixture(t,{withModel:true});
  const owner=await member(app,'skill-run-owner');
  const outsider=await member(app,'skill-run-outsider');
  const entries=(await call(app,owner,'GET','/v1/library?kind=skill',200)).items;
  const url=action=>'/v1/library/'+entries.find(skill=>skill.skillAction===action).id+'/runs';
  const checked=await call(app,owner,'POST',url('copy-review'),200,{revision:1,content:'商品是第一，保证100%'});
  assert.deepEqual(checked.result.matches.map(match=>match.term),['第一','100%']);
  assert.doesNotMatch(checked.result.preview,/第一|100%/);
  const asset=await upload(app,owner);
  const draftId=randomUUID();
  await call(app,owner,'PUT','/v1/studio/pinduoduo-drafts/'+draftId,200,{
    revision:0,title:'Synthetic item',specification:'A',sku:'FIX-A',stock:0,priceMinor:123,
    images:[{role:'main',assetId:asset.id}],variants:[{specification:'B'}],
  });
  const review=await call(app,owner,'POST',url('sku-review'),200,{revision:1,draftId});
  assert.equal(review.result.ready,false);
  assert.deepEqual(review.result.variants.map(variant=>variant.missing.length),[0,3]);
  await call(app,outsider,'POST',url('sku-review'),404,{revision:1,draftId});
  await provisionCredits(db,owner.workspace,owner.account.id,10,'fixture-skill-credits');
  const input={revision:1,content:'测试售后规则',idempotencyKey:randomUUID(),modelId:'scenario'};
  const run=await call(app,owner,'POST',url('model-chat'),202,input);
  assert.equal((await call(app,owner,'POST',url('model-chat'),200,input)).task.id,run.task.id);
  assert.equal(await workOnce({db,providers,shops}),true);
  assert.equal((await call(app,owner,'GET','/v1/tasks/'+run.task.id,200)).state,'succeeded');
  assert.match(seen[0].messages[0].content,/售后问题梳理/);
  await call(app,owner,'PUT',url('copy-review').replace('/runs','/state'),200,{enabled:false});
  await call(app,owner,'POST',url('copy-review'),409,{revision:1,content:'第一'});
});

test('copywriting checks each platform with versioned rules isolated by workspace',async t=>{
  const {app}=await fixture(t);
  const owner=await member(app,'copy-rules-owner',true);
  const writer=await join(app,owner,await member(app,'copy-rules-writer'));
  const outsider=await member(app,'copy-rules-outsider');
  const rules='/v1/copywriting/rules/pinduoduo';
  const input={revision:0,titleLimit:6,sellingPointLimit:12,forbiddenPhrases:['fixture only']};
  await call(app,writer,'PUT',rules,403,input);
  const created=await call(app,owner,'PUT',rules,200,input);
  await call(app,outsider,'GET',rules,404);
  await call(app,owner,'GET','/v1/copywriting/rules/taobao',404);
  const draft={platform:'pinduoduo',revision:created.revision,title:'第一款超长测试样品',sellingPoints:['FIXTURE ONLY']};
  const review=await call(app,writer,'POST','/v1/copywriting/review',200,draft);
  assert.equal(review.passed,false);
  assert.deepEqual(review.issues.map(issue=>issue.code),['TOO_LONG','REVIEW_TERM','FORBIDDEN_PHRASE']);
  await call(app,owner,'PUT',rules,200,{...input,revision:created.revision,titleLimit:20,forbiddenPhrases:[]});
  await call(app,writer,'POST','/v1/copywriting/review',409,draft);
});

test('SDK submits and revises copy, saves only owned results and exports the exact reviewed revision',async t=>{
  const {app,db,providers,shops,seen}=await fixture(t,{withModel:true});
  const owner=await member(app,'copy-pipeline-owner',true);
  const colleague=await join(app,owner,await member(app,'copy-pipeline-colleague'));
  const headers={authorization:'Bearer '+owner.token,'x-workspace-id':owner.workspace};
  const sdk=workspaceV1(async (method,url,payload)=>{
    const response=await app.inject({method,url,payload,headers});
    assert.ok(response.statusCode<300,response.body);
    return response.json();
  });
  await provisionCredits(db,owner.workspace,owner.account.id,20,'copy-pipeline');
  const parameters={product:'Fixture 250 g',inputLanguage:'en',language:'zh',competitorFacts:'Fixture B 200 g',sections:['selling-points','comparison']};
  const task=await sdk.submit({mode:'workflow',capabilityId:'copywriting.selling-points',modelId:'scenario',parameters,idempotencyKey:randomUUID()});
  await workOnce({db,providers,shops});
  const newInput={idempotencyKey:randomUUID(),instructions:'按重量比较'};
  const next=await sdk.regenerate(task.id,newInput);
  assert.equal(next.parentId,task.id);
  assert.equal(next.templateVersion,2);
  assert.match(seen[0].messages[0].content,/三条商品卖点/);
  assert.equal((await sdk.regenerate(task.id,newInput)).id,next.id);
  await workOnce({db,providers,shops});
  assert.match(seen.at(-1).messages[0].content,/按重量比较/);
  assert.match(seen.at(-1).messages[0].content,/Fixture B 200 g/);
  assert.equal((await sdk.events(next.id)).items[0].event,'succeeded');
  const root='/v1/copywriting/drafts';
  const draft=root+'/'+randomUUID();
  const create={title:'Sample',revision:0,sourceTaskId:next.id};
  await call(app,colleague,'PUT',draft,404,create);
  const original=await call(app,owner,'PUT',draft,200,create);
  assert.equal(original.content,(await sdk.task(next.id)).result.text);
  assert.equal((await call(app,owner,'PUT',draft,200,create)).revision,1);
  await call(app,colleague,'GET',draft,404);
  await call(app,colleague,'GET',draft+'/export?revision=1',404);
  const input={revision:1,title:'Sample',content:'🧪 第一款，100%合成样稿'};
  const revised=await call(app,owner,'PUT',draft,200,input);
  assert.equal((await call(app,owner,'PUT',draft,200,input)).revision,2);
  assert.equal(revised.sourceTaskId,next.id);
  await call(app,owner,'PUT',draft,409,{...input,content:'Stale'});
  await call(app,owner,'GET',draft+'/export?revision=1',409);
  const exported=await app.inject({method:'GET',url:draft+'/export?revision=2',headers});
  assert.equal(exported.body,input.content);
  assert.match(exported.headers['content-disposition'],/-r2\.txt/);
  assert.equal((await call(app,owner,'GET',root,200)).items.length,1);
  await call(app,owner,'PUT','/v1/copywriting/rules/pinduoduo',200,{revision:0,titleLimit:30,sellingPointLimit:20,forbiddenPhrases:['A.B']});
  const reviewed=await call(app,owner,'POST','/v1/copywriting/review',200,{
    platform:'pinduoduo',revision:1,title:' 🧪 第一款',sellingPoints:['100% a.B'],previewReplacements:true});
  assert.deepEqual(reviewed.issues.map(({start,end})=>[start,end]),[[4,6],[0,4],[5,8]]);
  assert.equal(reviewed.preview.title,' 🧪 表现突出款');
  assert.deepEqual(reviewed.preview.issues.map(issue=>issue.code),['FORBIDDEN_PHRASE']);
  await call(app,owner,'PUT','/v1/plugins/copywriting/state',200,{enabled:false});
  assert.ok((await sdk.plugins()).items.find(p=>p.id==='copywriting').capabilities.every(c=>!c.available));
  await call(app,owner,'PUT',draft,409,{...input,revision:2});
  await call(app,owner,'GET',draft,200);
  await call(app,owner,'POST','/v1/schedules',409,{mode:'chat',capabilityId:'copywriting.detect-terms',parameters:{content:'sample'},
    idempotencyKey:randomUUID(),runAt:new Date(Date.now()+60000).toISOString()});
});

test('enterprise agency book applies historic rates, exact partial reversals, two tiers and private monthly exports',async t=>{
  const {app,db}=await fixture(t);
  const owner=await member(app,'agency-ledger-owner',true);
  const parent=await join(app,owner,await member(app,'agency-parent'));
  const agentSession=await call(app,null,'POST','/v1/auth/register',201,{
    type:'agent',email:'agency-direct@example.test',displayName:'Direct QA agent',password:'synthetic-agency-password'});
  const personal={...agentSession,workspace:agentSession.workspaces[0].id};
  const login=await call(app,null,'POST','/v1/auth/login',200,{email:agentSession.account.email,password:'synthetic-agency-password'});
  assert.equal(login.account.type,'agent');
  const agent=await join(app,owner,personal);
  const third=await join(app,owner,await member(app,'agency-third'));
  const base='/v1/agency';
  const rates=base+'/rates';
  const receipt=base+'/receipts/RECEIVED-001';
  const statements=base+'/statements?month=';
  await call(app,personal,'GET',statements+'2026-02',403);
  await call(app,third,'GET',statements+'2026-02',403);
  const enroll=async (member,parentId,status=200)=>call(app,owner,'PUT',base+'/partners/'+member.account.id,status,{parentId});
  await enroll(parent,null);
  await enroll(agent,parent.account.id);
  assert.equal((await call(app,agent,'GET',base+'/me',200)).partner.tier,2);
  await enroll(third,agent.account.id,409);
  await assert.rejects(db.transaction(tx=>tx.query('INSERT INTO agency_partners(workspace_id,account_id,parent_id,tier) VALUES($1,$2,$3,2)',
    [owner.workspace,third.account.id,agent.account.id])),e=>e.code==='23503');
  await call(app,agent,'PUT',rates,403,{revision:0,directBps:1500,managementBps:500});
  await call(app,owner,'PUT',rates,400,{revision:0,directBps:9000,managementBps:2000});
  await call(app,owner,'PUT',rates,200,{revision:0,directBps:1500,managementBps:500});
  const paid={agentId:agent.account.id,bookedOn:'2026-01-31',paidMinor:101,rateRevision:1};
  await call(app,agent,'PUT',receipt,403,paid);
  await Promise.all([1,2].map(()=>call(app,owner,'PUT',receipt,200,paid)));
  await call(app,owner,'PUT',receipt,409,{...paid,paidMinor:100});
  await call(app,owner,'PUT',rates,200,{revision:1,directBps:900,managementBps:100});
  assert.equal((await call(app,owner,'PUT',receipt,200,paid)).directBps,1500);
  const items=async (who,month)=>(await call(app,who,'GET',statements+month,200)).items;
  const january=await items(owner,'2026-01');
  assert.equal(january.length,2);
  assert.equal(january.find(i=>i.accountId===agent.account.id).directMinor,'15');
  assert.equal(january.find(i=>i.accountId===parent.account.id).managementMinor,'5');
  const adjust=(id,amountMinor,reason,status=200)=>call(app,owner,'PUT',receipt+'/reversals/'+id,status,{reason,bookedOn:'2026-02-01',amountMinor});
  await Promise.all([1,2].map(()=>adjust('refund',11,'refund')));
  await adjust('refund',12,'refund',409);
  await adjust('return',30,'return');
  await adjust('chargeback',60,'chargeback');
  await adjust('extra',1,'refund',409);
  assert.equal((await call(app,owner,'GET',receipt,200)).reversedMinor,101);
  assert.equal((await call(app,owner,'GET',receipt+'/reversals',200)).items.length,3);
  assert.equal((await call(app,owner,'GET',base+'/receipts',200)).items[0].reference,'RECEIVED-001');
  assert.equal((await items(agent,'2026-02'))[0].netMinor,'-15');
  assert.deepEqual((await items(parent,'2026-02')).map(i=>i.netMinor),['-5']);
  const csv=await app.inject({method:'GET',url:base+'/statements/export?month=2026-02',
    headers:{authorization:'Bearer '+agent.token,'x-workspace-id':agent.workspace}});
  assert.equal(csv.statusCode,200);
  assert.ok(csv.body.includes(agent.account.id+',0,0,-15,-15'));
  assert.ok(!csv.body.includes(parent.account.id));
  const other=await member(app,'agency-second-company',true);
  await call(app,other,'GET',receipt,404);
  await call(app,other,'PUT',base+'/partners/'+agent.account.id,404,{parentId:null});
});

test('rights notices relay privately, restrict actual downloads, and restore only when all holds end',async t=>{
  const {app}=await fixture(t);
  const manager=await member(app,'rights-owner',true);
  const reporter=await join(app,manager,await member(app,'rights-reporter'));
  const affected=await join(app,manager,await member(app,'rights-affected'));
  const outsider=await member(app,'rights-outsider');
  const asset=await upload(app,affected);
  const data={id:randomUUID(),assetId:asset.id,statement:'Synthetic rights claim',evidenceReference:'evidence-fixture-01'};
  const path=rights+'/'+data.id;
  await call(app,outsider,'POST',rights,404,data);
  const submitted=await call(app,reporter,'POST',rights,201,data);
  await call(app,reporter,'POST',rights,200,data);
  assert.equal(submitted.state,'submitted');
  assert.equal(submitted.affectedId,undefined);
  await call(app,affected,'GET',path,404);
  const act=(user,action,revision,status=200,pathToAct=path,eventId=randomUUID())=>
    call(app,user,'POST',pathToAct+'/actions',status,{action,revision,eventId,explanation:action+' fixture'});
  await act(reporter,'restrict',1,403);
  await act(manager,'restrict',1,409);
  const eventId=randomUUID();
  assert.equal((await act(manager,'forward',1,200,path,eventId)).state,'forwarded');
  await act(manager,'forward',1,200,path,eventId);
  assert.equal((await call(app,affected,'GET',path,200)).notice.affectsMyAsset,true);
  const second=await call(app,reporter,'POST',rights,201,{...data,id:randomUUID()});
  const secondPath=rights+'/'+second.id;
  await call(app,affected,'PATCH','/v1/settings',200,{rightsNotifications:false});
  await act(manager,'forward',1,200,secondPath);
  assert.equal((await call(app,affected,'GET',secondPath,200)).notice.state,'forwarded');
  const forwards=(await call(app,affected,'GET','/v1/notifications',200)).items.filter(item=>item.type==='rights.forward');
  assert.deepEqual(forwards.map(item=>item.data.noticeId),[data.id]);
  await call(app,affected,'PATCH','/v1/settings',200,{rightsNotifications:true});
  await act(manager,'restrict',2,200,secondPath);
  assert.equal((await act(manager,'restrict',2)).state,'restricted');
  await call(app,affected,'GET','/v1/assets/'+asset.id+'/content',404);
  await call(app,affected,'DELETE','/v1/assets/'+asset.id,404);
  assert.equal((await call(app,affected,'GET','/v1/assets',200)).items.length,0);
  const derived=await call(app,affected,'POST','/v1/media/images/batches',201,{
    id:randomUUID(),items:[{key:'blocked',assetIds:[asset.id],width:120,height:120}],
  });
  assert.equal(derived.items[0].error,'SOURCE_UNAVAILABLE');
  await act(reporter,'counter',3,403);
  await act(affected,'counter',3);
  assert.ok(!(await call(app,reporter,'GET',path,200)).events.some(event=>event.action==='counter'));
  await act(manager,'forward-counter',4);
  assert.equal((await call(app,reporter,'GET',path,200)).events.find(event=>event.action==='counter').explanation,'counter fixture');
  await act(manager,'restore',5);
  await call(app,affected,'GET','/v1/assets/'+asset.id+'/content',404);
  await act(manager,'restore',3,200,secondPath);
  const restored=await app.inject({url:'/v1/assets/'+asset.id+'/content',headers:{
    authorization:'Bearer '+affected.token,'x-workspace-id':affected.workspace,
  }});
  assert.equal(restored.statusCode,200);
  assert.deepEqual((await call(app,reporter,'GET',path,200)).events.map(event=>event.action),
    ['forward','restrict','counter','forward-counter','restore']);
  const inbox=(await call(app,affected,'GET','/v1/notifications',200)).items;
  assert.equal(inbox[0].type,'rights.restore');
});
