import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { readShopToken } from '../src/shop-authorization.js';
import { activeHandoffs, pauseNativeReplies } from '../src/customer-agent-store.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('shared shop directory, scoped chats and one-use merchant authorization',async t=>{
  const db=new PGlite();await migrate(db);
  const auth={appKey:'test-app',secret:'test-secret',key:Buffer.alloc(32,1),redirect:'https://studio.example/'};
  let calls=0;
  const app=await buildApp({db,shopAuth:auth,shopTokenExchange:async()=>{
    calls++;return {taobao_user_id:'1000000000000000001',access_token:'unit-only-token',expires_in:3600};
  },integrations:{commerce:{shops:new Map()}},integrationRunner:async(_,kind,action,b)=>{
    if(action==='probe')return {taobao:['get_order_list']};
    assert.equal(b.credentials.access_token,'unit-only-token');return {items:[]};
  }});
  t.after(async()=>{await app.close();await db.close();});
  async function api(status,method,url,a,payload){
    const headers=a?{authorization:'Bearer '+a.token,'x-workspace-id':a.workspaces[0].id}:{};
    const res=await app.inject({method,url,headers,payload});
    assert.equal(res.statusCode,status,res.body);return res.json();
  }
  const register=email=>api(201,'POST','/v1/auth/register',null,{email,password:'tenant-test-pass',displayName:'test',type:'enterprise',workspaceName:'test'});
  const a=await register('a@shops.invalid'),b=await register('b@shops.invalid'),base='/v1/desk-shops';
  const s=await api(201,'POST',base,a,{name:'测试门店',platform:'taobao'});
  assert.equal((await api(200,'GET',base,a)).items[0].commerce,false);
  assert.deepEqual((await api(200,'GET',base,b)).items,[]);
  const convo={subject:'测试咨询',shopId:s.id};
  await api(404,'POST','/v1/customer-service/conversations',b,convo);
  const products='/v1/studio/products', conversations='/v1/customer-service/conversations';
  const product=await api(201,'POST',products,a,{sku:'SHOP-1',name:'测试商品',description:'商品描述'});
  const conversation=await api(201,'POST',conversations,a,{...convo,productId:product.id});
  assert.equal(conversation.shopId,s.id);
  assert.equal(conversation.productId,product.id);
  assert.equal(conversation.productReference,product.sku);
  const {conversation: persisted}=await api(200,'GET',conversations+'/'+conversation.id+'/messages',a);
  assert.equal(persisted.shopId,s.id);
  assert.equal(persisted.productId,product.id);
  const query={shopId:s.id,operation:'get_order_list',params:{}};
  await api(409,'POST','/v1/integrations/mcp-cn-commerce/query',a,query);
  const start=await api(200,'POST',base+'/'+s.id+'/authorize',a);
  const uri=new URL(start.url);assert.equal(uri.origin,'https://oauth.taobao.com');
  const body={state:uri.searchParams.get('state'),code:'test-code'};
  await api(409,'POST',base+'/authorization/complete',b,body);
  await api(200,'POST',base+'/authorization/complete',a,body);
  await api(409,'POST',base+'/authorization/complete',a,body);
  assert.equal(calls,1);
  const listed=await api(200,'GET',base,a);
  assert.equal(listed.items[0].commerce,true);assert.ok(!JSON.stringify(listed).includes('unit-only-token'));
  const cipher=(await db.query('SELECT grant_cipher FROM desk_shops')).rows[0].grant_cipher;
  assert.ok(!cipher.includes('unit-only-token'));
  assert.throws(()=>readShopToken(auth,'other-scope',cipher));
  await api(200,'POST','/v1/integrations/mcp-cn-commerce/query',a,query);
  await api(409,'PATCH',base+'/'+s.id,a,{revision:0,enabled:false,name:s.name});
  await api(200,'PATCH',base+'/'+s.id,a,{revision:listed.items[0].revision,enabled:false,name:s.name});
  assert.equal((await db.query('SELECT grant_cipher FROM desk_shops')).rows[0].grant_cipher,null);
  await api(409,'POST','/v1/integrations/mcp-cn-commerce/query',a,query);
});

test('native handoff uses a real scoped history and preserves a live marker',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'desk-handoff-'));t.after(()=>rm(dir,{force:true,recursive:true}));
  const database=join(dir,'store.db'),binding={database,historyDatabase:database,accountId:'op',platform:'douyin',shopId:'s1',allowHandoff:true};
  const db=new DatabaseSync(database);
  db.exec("CREATE TABLE channels(id,channel_name); CREATE TABLE shops(id,channel_id,shop_id); INSERT INTO channels VALUES(1,'douyin'); INSERT INTO shops VALUES(1,1,'s1'); CREATE TABLE handoff_markers(session_key TEXT PRIMARY KEY,expiry INTEGER); CREATE TABLE agent_messages(id,session_id,role,content,timestamp);");
  const key='conversation_'+createHash('sha256').update('douyin|s1|op|customer|buyer').digest('hex');
  db.prepare("INSERT INTO agent_messages VALUES(1,?,'user','hello','now')").run(key);db.close();
  assert.throws(()=>pauseNativeReplies({...binding,allowHandoff:false},'buyer'),{code:'HANDOFF_UNAVAILABLE'});
  assert.throws(()=>pauseNativeReplies(binding,'other'),{code:'NOT_FOUND'});
  const first=pauseNativeReplies(binding,'buyer');assert.ok(first.expiry>Date.now()/1000);
  assert.equal(pauseNativeReplies(binding,'buyer').expiry,first.expiry);
  assert.deepEqual(activeHandoffs(binding).items.map(s=>s.buyerId),['buyer']);
  assert.deepEqual(activeHandoffs({...binding,shopId:'s'}).items,[]);
});
