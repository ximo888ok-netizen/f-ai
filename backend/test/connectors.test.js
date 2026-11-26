import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';
import { createWebdavBindings } from '../src/webdav.js';
import { createFeishuBindings } from '../src/feishu.js';
import { createWechatBindings } from '../src/wechat-channel.js';
import { dispatchFeishuReply } from '../src/feishu-channel.js';
import { ProviderError } from '../src/model-http.js';

const newDatabase=()=>process.env.FAI_TEST_DATABASE_URL?postgres(process.env.FAI_TEST_DATABASE_URL):new PGlite();
const publicKey='fixture-event-encryption-key';
const verification='fixture-verification-token';

test('WeChat official account and WeCom application verify callbacks, deduplicate text and deliver encrypted replies',async()=>{
  const db=newDatabase(), wechat=new Map();
  const app=await buildApp({db,wechat});
  try {
    await migrate(db);
    const owner=await register(app,'wx-owner@example.test'), other=await register(app,'wx-other@example.test');
    const token=randomBytes(12).toString('hex'), key=randomBytes(32);
    for (const channel of ['wechat','wecom']) {
      const receiver=channel==='wechat'?'wxFixtureApp':'wwFixtureCorp', recipient=channel==='wechat'?'gh_qa':receiver;
      const settings={channel,id:'test',workspaceId:owner.workspaceId,receiver,recipient,agentId:'1001',
        tokenEnv:'TEST_TOKEN',keyEnv:'TEST_KEY',replyText:'收到 & 已记录'};
      const config=createWechatBindings({WECHAT_BINDINGS_JSON:JSON.stringify([settings]),TEST_TOKEN:token,TEST_KEY:key.toString('base64').slice(0,-1)});
      for (const [name,binding] of config) wechat.set(name,binding);
      const seal=plain=>{
        const bytes=Buffer.from(plain), size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);
        const raw=Buffer.concat([randomBytes(16),size,bytes,Buffer.from(receiver)]), pad=32-raw.length%32;
        const cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16)).setAutoPadding(false);
        return Buffer.concat([cipher.update(Buffer.concat([raw,Buffer.alloc(pad,pad)])),cipher.final()]).toString('base64');
      };
      const path='/v1/channels/'+channel+'/test/callback', ts=String(Math.floor(Date.now()/1000)),nonce='n123';
      const hash=(...parts)=>createHash('sha1').update(parts.sort().join('')).digest('hex');
      const echo=channel==='wechat'?'12345':seal('12345');
      const getQuery=channel==='wechat'?{signature:hash(token,ts,nonce)}:{msg_signature:hash(token,ts,nonce,echo)};
      assert.equal((await app.inject(path+'?'+new URLSearchParams({...getQuery,timestamp:ts,nonce,echostr:echo}))).body,'12345');
      const payload=seal('<xml><ToUserName>'+recipient+'</ToUserName><FromUserName>qa-user</FromUserName><MsgType>text</MsgType>'+
        '<MsgId>998877</MsgId><AgentID>1001</AgentID><Content><![CDATA[两种规格 & 库存]]></Content></xml>');
      const send=sig=>app.inject({method:'POST',url:path+'?'+new URLSearchParams({msg_signature:sig,nonce,timestamp:ts}),
        headers:{'content-type':'application/xml'},payload:'<xml><Encrypt><![CDATA['+payload+']]></Encrypt></xml>'});
      assert.equal((await send('0'.repeat(40))).statusCode,401);
      for (const reply of await Promise.all([send(hash(token,ts,nonce,payload)),send(hash(token,ts,nonce,payload))])) {
        assert.equal(reply.statusCode,200);
        const tag=name=>new RegExp('<'+name+'>([^<]+)</'+name+'>').exec(reply.body)[1];
        assert.equal(tag('MsgSignature'),hash(token,tag('TimeStamp'),tag('Nonce'),tag('Encrypt')));
        const decipher=createDecipheriv('aes-256-cbc',key,key.subarray(0,16)).setAutoPadding(false);
        const raw=Buffer.concat([decipher.update(Buffer.from(tag('Encrypt'),'base64')),decipher.final()]);
        assert.ok(raw.subarray(20,20+raw.readUInt32BE(16)).toString().includes('收到 &amp; 已记录'));
        assert.equal(raw.subarray(20+raw.readUInt32BE(16),raw.length-raw.at(-1)).toString(),receiver);
      }
      const inbox='/v1/channels/'+channel+'/inbox';
      const entries=json(await call(app,owner,'GET',inbox),200);
      assert.equal(entries.available,true);
      assert.deepEqual(entries.items.map(i=>i.content),['两种规格 & 库存']);
      assert.deepEqual(json(await call(app,other,'GET',inbox),200),{available:false,items:[]});
    }
  } finally {await app.close();await db.close();}
});

async function register(app,email) {
  const result=await app.inject({method:'POST',url:'/v1/auth/register',payload:{
    email,password:'connector-fixture-password',displayName:'Connector QA',type:'enterprise',workspaceName:'Connector QA',
  }});
  assert.equal(result.statusCode,201,result.body);
  const account=result.json();
  return {...account,workspaceId:account.workspaces[0].id};
}

const call=(app,account,method,url,payload)=>app.inject({method,url,payload,headers:{
  authorization:'Bearer '+account.token,'x-workspace-id':account.workspaceId,
}});
function json(result,status) {
  assert.equal(result.statusCode,status,result.body);
  return status===204?undefined:result.json();
}

test('WebDAV copies require confirmation, recover pending writes, check bytes and restore ownership',async ()=>{
  const db=newDatabase();
  const cloudAssets=new Map();
  const app=await buildApp({db,cloudAssets});
  try {
    await migrate(db);
    const owner=await register(app,'connector-assets@example.test');
    const other=await register(app,'connector-assets-other@example.test');
    const root='/v1/cloud-assets';
    assert.deepEqual(json(await call(app,owner,'GET',root+'/status'),200),{available:false});
    const storage=new Map();
    const outbound=[];
    let loseAcknowledgement=true;
    const bindings=createWebdavBindings({
      WEBDAV_BINDINGS_JSON:JSON.stringify([owner,other].map(account=>({
        workspaceId:account.workspaceId,baseUrl:'https://files.example.test/collection/',authorizationEnv:'QA_WEBDAV',
      }))),
      QA_WEBDAV:'Basic ZmFrZTprZXk=',
    },async (url,options)=>{
      outbound.push(options.method);
      assert.equal(url.origin,'https://files.example.test');
      assert.match(url.pathname,/^\/collection\/fai-[a-f0-9-]{110}$/);
      assert.equal(options.headers.authorization,'Basic ZmFrZTprZXk=');
      assert.equal(options.redirect,'error');
      if (options.method==='PUT') {
        assert.equal(options.headers['if-none-match'],'*');
        if (storage.has(url.pathname)) return new Response(null,{status:412});
        storage.set(url.pathname,Buffer.from(options.body));
        if (loseAcknowledgement) { loseAcknowledgement=false; throw new Error('Simulated interrupted response'); }
        return new Response(null,{status:201});
      }
      return storage.has(url.pathname)?new Response(storage.get(url.pathname)):new Response(null,{status:404});
    });
    for (const [id,binding] of bindings) cloudAssets.set(id,binding);
    assert.deepEqual(json(await call(app,owner,'GET',root+'/status'),200),{available:true});
    const bytes=Buffer.from('89504e470d0a1a0a','hex');
    const upload={name:'fixture.png',mediaType:'image/png',source:'synthetic',purpose:'test',
      dataBase64:bytes.toString('base64')};
    const asset=json(await call(app,owner,'POST','/v1/assets',upload),201);
    const url=root+'/'+asset.id;
    json(await call(app,owner,'PUT',url,{confirmed:false}),400);
    assert.equal(outbound.length,0);
    json(await call(app,owner,'PUT',url,{confirmed:true}),502);
    assert.equal(json(await call(app,owner,'GET',root),200).items[0].state,'pending');
    const [storageKey]=storage.keys();
    assert.ok(storageKey.includes(owner.workspaceId));
    assert.ok(!storageKey.includes(upload.name));
    const backup=json(await call(app,owner,'PUT',url,{confirmed:true}),200);
    assert.equal(backup.state,'ready');
    assert.deepEqual(outbound,['PUT','PUT','GET']);
    json(await call(app,other,'GET',url+'/content'),404);
    json(await call(app,owner,'DELETE','/v1/assets/'+asset.id),204);
    storage.set(storageKey,Buffer.alloc(bytes.length));
    assert.equal(json(await call(app,owner,'POST',url+'/restore',{confirmed:true}),409).error.code,'CLOUD_COPY_MISMATCH');
    json(await call(app,owner,'GET','/v1/assets/'+asset.id),404);
    storage.set(storageKey,bytes);
    assert.deepEqual(json(await call(app,owner,'POST',url+'/restore',{confirmed:true}),200),backup);
    const download=await call(app,owner,'GET','/v1/assets/'+asset.id+'/content');
    assert.deepEqual(download.rawPayload,bytes);
    assert.equal(download.headers['x-content-sha256'],backup.sha256);
    cloudAssets.delete(owner.workspaceId);
    json(await call(app,owner,'GET',url+'/content'),503);
    assert.equal(json(await call(app,owner,'GET',root),200).items.length,1);
  } finally {await app.close();await db.close();}
});

function encrypt(event) {
  const iv=Buffer.alloc(16,7);
  const key=createHash('sha256').update(publicKey).digest();
  const cipher=createCipheriv('aes-256-cbc',key,iv);
  const payload=Buffer.concat([iv,cipher.update(JSON.stringify(event)),cipher.final()]);
  return JSON.stringify({encrypt:payload.toString('base64')});
}

function signature(payload,seconds=Math.floor(Date.now()/1000)) {
  const time=String(seconds);
  const nonce='qa-nonce';
  return {'content-type':'application/json','x-lark-request-timestamp':time,'x-lark-request-nonce':nonce,
    'x-lark-signature':createHash('sha256').update(time+nonce+publicKey+payload).digest('hex')};
}

test('Feishu signed events are deduplicated, isolated and delivered only after confirmation using a stable UUID',async ()=>{
  const db=newDatabase();
  const feishu=new Map();
  const app=await buildApp({db,feishu});
  try {
    await migrate(db);
    const owner=await register(app,'connector-feishu@example.test');
    const other=await register(app,'connector-feishu-other@example.test');
    const sent=[];
    let attempts=0;
    const bindings=createFeishuBindings({
      FEISHU_BINDINGS_JSON:JSON.stringify([{
        id:'qa-bot',workspaceId:owner.workspaceId,appId:'cli_fixture',tenantKey:'fixtureTenant',
        appSecretEnv:'QA_BOT_SECRET',encryptKeyEnv:'QA_BOT_ENCRYPT',verificationTokenEnv:'QA_BOT_VERIFY',
      }]),
      QA_BOT_SECRET:'fixture-secret',QA_BOT_ENCRYPT:publicKey,QA_BOT_VERIFY:verification,
    },async (url,options)=>{
      assert.equal(url.origin,'https://open.feishu.cn');
      if (url.pathname.endsWith('/tenant_access_token/internal')) {
        assert.deepEqual(options.body,{app_id:'cli_fixture',app_secret:'fixture-secret'});
        return {code:0,tenant_access_token:'t-fixture-token',expire:7200};
      }
      assert.equal(url.searchParams.get('receive_id_type'),'chat_id');
      assert.equal(options.headers.authorization,'Bearer t-fixture-token');
      sent.push(options.body);
      if (++attempts===1) throw new ProviderError('PROVIDER_UNREACHABLE',true);
      return {code:0,data:{message_id:'om_fixture_reply'}};
    });
    feishu.set('qa-bot',bindings.get('qa-bot'));
    const root='/v1/channels/feishu';
    const callback=(payload,headers)=>app.inject({method:'POST',url:root+'/qa-bot/events',payload,headers});
    const challenge=encrypt({type:'url_verification',token:verification,challenge:'fixture-challenge'});
    assert.deepEqual(json(await callback(challenge,{'content-type':'application/json'}),200),{challenge:'fixture-challenge'});
    const event={schema:'2.0',header:{event_id:'event-qa',event_type:'im.message.receive_v1',token:verification,
      app_id:'cli_fixture',tenant_key:'fixtureTenant'},event:{
      sender:{sender_type:'user'},message:{chat_type:'p2p',chat_id:'oc_fixture',message_id:'om_fixture',
        message_type:'text',content:JSON.stringify({text:'Can you confirm availability?'})},
    }};
    const valid=encrypt(event);
    json(await callback(valid,{'content-type':'application/json'}),401);
    json(await callback(valid,signature(valid,Math.floor(Date.now()/1000)-360)),401);
    const wrong=encrypt({...event,header:{...event.header,tenant_key:'otherTenant'}});
    json(await callback(wrong,signature(wrong)),401);
    json(await callback(valid,signature(valid)),200);
    json(await callback(valid,signature(valid)),200);
    const repeated=encrypt({...event,header:{...event.header,event_id:'event-different'}});
    json(await callback(repeated,signature(repeated)),200);
    assert.equal(json(await call(app,owner,'GET',root),200).items.length,1);
    assert.deepEqual(json(await call(app,other,'GET',root),200),{available:false,items:[]});
    const inbound=root+'/qa-bot/inbox/event-qa';
    json(await call(app,other,'GET',inbound),404);
    const id=randomUUID();
    const reply=inbound+'/replies/'+id;
    json(await call(app,owner,'PUT',reply,{content:'We will check it.',confirmed:false}),400);
    assert.equal(await dispatchFeishuReply({db,feishu}),false);
    const input={content:'We will check it.',confirmed:true};
    const queued=json(await call(app,owner,'PUT',reply,input),200);
    assert.equal(queued.state,'queued');
    assert.deepEqual(json(await call(app,owner,'PUT',reply,input),200),queued);
    assert.equal(await dispatchFeishuReply({db,feishu}),true);
    assert.equal(json(await call(app,owner,'GET',inbound),200).items[0].state,'queued');
    await db.query('UPDATE feishu_replies SET available_at=now() WHERE id=$1',[id]);
    assert.equal(await dispatchFeishuReply({db,feishu}),true);
    const delivered=json(await call(app,owner,'GET',inbound),200).items[0];
    assert.equal(delivered.state,'sent');
    assert.equal(delivered.remoteMessageId,'om_fixture_reply');
    assert.deepEqual(sent,[1,2].map(()=>({receive_id:'oc_fixture',msg_type:'text',content:JSON.stringify({text:input.content}),uuid:id})));
    assert.equal(await dispatchFeishuReply({db,feishu}),false);
  } finally {await app.close();await db.close();}
});
