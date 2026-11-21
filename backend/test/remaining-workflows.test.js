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
      if (body.messages.at(-1).content.includes('等待接管')) {
        signalWaiting();
        await wait;
      }
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{content:'根据已知资料，请保留原包装并交人工核实。'}}]}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{release();await new Promise(resolve=>server.close(resolve));});
    installModels(providers,[{id:'scenario',protocol:'chat-completions',model:'test',capabilities:['model.chat'],
      baseUrl:'http://127.0.0.1:'+server.address().port}]);
  }
  const app=await buildApp({db,providers,shops,customerAnswer:createCustomerAnswer(providers,withModel?'scenario':undefined)});
  t.after(async()=>{await app.close();await db.close();});
  await migrate(db);
  return {app,db,providers,shops,seen,started,release};
}

test('customer conversation uses scoped multi-turn knowledge, redacts references and stops during handoff',async t=>{
  const {app,seen,started,release}=await fixture(t,{withModel:true});
  const owner=await member(app,'customer-context-owner',true);
  const customer=await join(app,owner,await member(app,'customer-context-buyer'));
  const outsider=await member(app,'customer-context-outsider');
  const {id:knowledgeId}=await call(app,owner,'POST','/v1/knowledge/bases',201,{name:'Return fixtures'});
  const knowledge='/v1/knowledge/bases/'+knowledgeId;
  await call(app,owner,'PUT',knowledge+'/grants/'+customer.account.id,204);
  await call(app,owner,'POST',knowledge+'/documents',201,{
    name:'Fixture return policy',content:'退货规则：测试商品需要保留原包装。联系 private-contact@example.test 也可以转人工。',
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
  await act(manager,'forward',1,200,secondPath);
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
