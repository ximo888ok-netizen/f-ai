import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/db.js';

import { createProviders } from '../src/providers.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';
import { shopEvidence, shopHistory } from '../src/customer-agent-store.js';

test('plugin tasks settle only complete generations and shop reads obey workspace and connection boundaries', async t => {
  const db=new PGlite();
  const settings=()=>({ model:{name:'test',key:'unit-only',baseUrl:'http://127.0.0.1'},shops:new Map() });
  const integrations={customer:settings(),content:settings(),commerce:settings()};
  const providers=createProviders(), shops=new Map();
  const calls=[];
  async function integrationRunner(_,kind,action,input) {
    if(action==='probe') return kind==='commerce'?{taobao:['get_order_list'],pinduoduo:[]}: {};
    calls.push({kind,action});
    if(action==='query') return {orders:[]};
    if(kind==='customer') return {text:'草稿'};
    return {platform:input.parameters.platform,optimized_title:'标题',selling_points:[],seo_keywords:['杯具'],description:'描述',social_copy:'文案'};
  }
  await migrate(db);
  const app=await buildApp({db,shops,providers,integrations,integrationRunner});
  t.after(async()=>{await app.close();await db.close();});
  async function request(status,method,url,a,payload) {
    const headers=a?{authorization:'Bearer '+a.token,'x-workspace-id':a.workspaces[0].id}:{};
    const response=await app.inject({url,method,headers,payload});
    assert.equal(response.statusCode,status,response.body);
    return response.json();
  }
  const register=async email=>request(201,'POST','/v1/auth/register',null,await registrationPayload(app, {email,password:'integration-test',type:'enterprise',workspaceName:'测试',displayName:'测试'}));
  const a=await register('first@example.invalid'), b=await register('second@example.invalid'), workspace=a.workspaces[0].id;
  const bound={id:'readonly',workspaceId:workspace,name:'测试店铺',platform:'taobao',credentials:{access_token:'unit-only'}};
  integrations.commerce.shops.set(workspace+'/readonly',bound);
  const api='/v1/integrations/mcp-cn-commerce';
  assert.equal((await request(200,'GET',api,a)).shops[0].authorized,true);
  assert.deepEqual((await request(200,'GET',api,b)).shops,[]);
  const query={shopId:'readonly',operation:'get_order_list',params:{}};
  await request(404,'POST',api+'/query',b,query);
  await request(422,'POST',api+'/query',a,{...query,operation:'publish'});
  assert.deepEqual((await request(200,'POST',api+'/query',a,query)).data,{orders:[]});
  bound.expiresAt='2020-01-01T00:00:00Z';
  assert.equal((await request(200,'GET',api,a)).shops[0].authorized,false);
  await request(409,'POST',api+'/query',a,query);
  assert.equal(calls.length,1);
  delete bound.expiresAt;
  await request(200,'PUT','/v1/merchant/connections/shop/readonly',a,{enabled:false,revision:0});
  assert.equal((await request(200,'GET',api,a)).shops[0].authorized,false);
  await request(409,'POST',api+'/query',a,query);
  await provisionCredits(db,workspace,a.account.id,12,'integration-test-fund');
  const draft={mode:'workflow',capabilityId:'customer-service.reply-draft',modelId:'customer-agent',parameters:{question:'容量？'},idempotencyKey:'integration-draft'};
  const task=await request(202,'POST','/v1/tasks',a,draft);
  assert.equal((await request(200,'POST','/v1/tasks',a,draft)).id,task.id);
  await workOnce({db,providers,shops});
  assert.equal((await request(200,'GET','/v1/tasks/'+task.id,a)).result.text,'草稿');
  const wallet=()=>request(200,'GET','/v1/credits/wallet',a);
  const settled=await wallet();
  assert.equal(settled.available,12-task.cost);
  const copy={mode:'workflow',capabilityId:'copywriting.content-package',modelId:'ecommerce-content-agent',idempotencyKey:'integration-copy',
    parameters:{title:'水杯',category:'杯具',facts:'容量 500 mL',platform:'taobao'}};
  await request(400,'POST','/v1/tasks',a,{...copy,parameters:{...copy.parameters,platform:'pinduoduo'}});
  const incomplete=await request(202,'POST','/v1/tasks',a,copy);
  await workOnce({db,providers,shops});
  const failed=await request(200,'GET','/v1/tasks/'+incomplete.id,a);
  assert.equal(failed.state,'failed');
  assert.equal(failed.errorCode,'INVALID_PROVIDER_RESULT');
  assert.deepEqual(await wallet(),settled);
  await request(200,'PUT','/v1/merchant/connections/model/customer-agent',a,{enabled:false,revision:0});
  assert.equal((await request(200,'GET','/v1/integrations/customer-agent',a)).state,'disabled');
  await request(422,'POST','/v1/tasks',a,{...draft,idempotencyKey:'integration-disabled'});
});

test('native Customer-Agent knowledge and buyer history are scoped to the bound shop, channel and account', async t=>{
  const folder=await mkdtemp(join(tmpdir(),'fai-customer-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const database=join(folder,'test.db');
  const binding={database,historyDatabase:database,shopId:'shop',accountId:'agent',platform:'pinduoduo'};
  const sql=new DatabaseSync(database);
  try {
    sql.exec(`CREATE TABLE channels(id,channel_name); CREATE TABLE shops(id,shop_id,channel_id);
      CREATE TABLE product_knowledge(id,shop_id,goods_name,goods_id,extracted_content,specifications,updated_at);
      CREATE TABLE customer_service_knowledge(id,shop_id,title,content,enabled,updated_at);
      CREATE TABLE agent_messages(id,session_id,role,content,timestamp);
      INSERT INTO channels VALUES(1,'pinduoduo'),(2,'douyin');
      INSERT INTO shops VALUES(1,'shop',1),(2,'shop',2);
      INSERT INTO customer_service_knowledge VALUES(1,1,'水杯','500 mL',1,1),(2,2,'水杯','其他店铺',1,2),(3,1,'水杯','已停用',0,3);`);
    const session='conversation_'+createHash('sha256').update('pinduoduo|shop|agent|customer|buyer').digest('hex');
    sql.prepare('INSERT INTO agent_messages VALUES(1,?,?,?,?)').run(session,'user',JSON.stringify({__multimodal__:{text:'查容量',images:['private']}}),'12:00');
  } finally { sql.close(); }
  assert.deepEqual(shopEvidence(binding,'水杯').items,[{kind:'客服知识',title:'水杯',content:'500 mL'}]);
  assert.equal(shopHistory(binding,'buyer').items[0].content,'查容量');
  assert.deepEqual(shopHistory({...binding,accountId:'someone-else'},'buyer').items,[]);
});
