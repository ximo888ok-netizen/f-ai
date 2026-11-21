import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { backupDatabases } from '../src/database-archive.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, postgres } from '../src/db.js';
import { installModels } from '../src/models.js';
import { createProviders } from '../src/providers.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';

const tinyAudio=process.env.FAI_TEST_FFMPEG_PATH
  ? execFileSync(process.env.FAI_TEST_FFMPEG_PATH,['-v','error','-f','lavfi','-i','sine=frequency=440',
    '-t','0.25','-c:a','libmp3lame','-f','mp3','-'],{windowsHide:true,timeout:10000})
  : Buffer.from('49443304000000000000','hex');
const sse=data=>'data: '+JSON.stringify(data)+'\r\n\r\n';
const fixtureText=text=>({choices:[{index:0,delta:{content:text},finish_reason:null}]});
const stop=reason=>sse({choices:[{index:0,delta:{},finish_reason:reason}]});
const namedEvent=(type,data={})=>'event: '+type+'\r\n'+sse({type,...data});

async function fixture(t) {
  const db=process.env.FAI_TEST_DATABASE_URL?postgres(process.env.FAI_TEST_DATABASE_URL):new PGlite();
  const providers=createProviders(),shops=new Map(),requests=[];
  const {promise:releaseFirst,resolve:release}=Promise.withResolvers();
  const nativeResponses=new Map();
  let speechReject=false;
  let streamingReplies=0;
  const mock=createServer(async (request,response)=>{
    const parts=[];
    for await(const part of request) parts.push(part);
    const payload=Buffer.concat(parts);
    const body=request.url==='/v1/audio/transcriptions'?null:JSON.parse(payload.toString('utf8'));
    requests.push({path:request.url,body,payload});
    if (nativeResponses.has(body?.model)) {
      const {first,later,pause}=nativeResponses.get(body.model);
      response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});
      response.write(first);
      await pause;
      response.end(later);
      return;
    }
    if (body?.stream) {
      streamingReplies++;
      response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});
      const initial=Buffer.from(sse(fixtureText('第一段')));
      const split=initial.indexOf(Buffer.from('第'))+1;
      response.write(initial.subarray(0,split));
      await pause(8);
      response.write(initial.subarray(split));
      if (body.messages.at(-1).content==='reject-stream') {
        response.end(stop('length')+'data: [DONE]\r\n\r\n');
        return;
      }
      await releaseFirst;
      await pause(175);
      response.end(sse(fixtureText('第二段'))+stop('stop')+'data: [DONE]\r\n\r\n');
      return;
    }
    if (request.url==='/v1/audio/speech') {
      response.writeHead(speechReject?429:200,{'content-type':'audio/mpeg'});
      response.end(speechReject?null:tinyAudio);
      return;
    }
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify(request.url==='/v1/audio/transcriptions'
      ?{text:'Voice question'}:{choices:[{message:{content:'Voice answer'},finish_reason:'stop'}]}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const baseUrl='http://127.0.0.1:'+mock.address().port+'/v1';
  const definition=(id,protocol,extra={})=>({id,protocol,baseUrl,model:id,...extra});
  installModels(providers,[definition('live-chat','chat-completions',{streamText:true}),
    definition('plain-chat','chat-completions'),definition('transcript','openai-transcription'),
    definition('synth','openai-speech')]);
  const app=await buildApp({db,providers,shops});
  t.after(async()=>{
    release();
    for (const entry of nativeResponses.values()) entry.resume?.();
    await app.close();
    await new Promise(resolve=>mock.close(resolve));
    await db.close();
  });
  await migrate(db);
  const base=await app.listen({host:'127.0.0.1',port:0});
  async function call(method,path,status,headers={},payload) {
    const response=await app.inject({method,url:path,headers,payload});
    assert.equal(response.statusCode,status,response.body);
    return response.json();
  }
  async function register(name) {
    const user=await call('POST','/v1/auth/register',201,{},{
      email:name+'@example.test',password:'isolated-stream-voice-fixtures',displayName:name,type:'personal',
    });
    const workspace=user.workspaces[0].id;
    await provisionCredits(db,workspace,user.account.id,30,'initial-balance');
    return {authorization:'Bearer '+user.token,'x-workspace-id':workspace};
  }
  const worker=()=>workOnce({db,providers,shops});
  return {db,base,call,register,worker,requests,release,rejectSpeech:()=>{speechReject=true;},
    streamRequests:()=>streamingReplies,providers,definition,nativeResponses};
}

const responsesDelta=(output_index,content_index,delta)=>namedEvent('response.output_text.delta',{output_index,content_index,delta});
const completedResponses=(...text)=>namedEvent('response.completed',{response:{status:'completed',output:[
  {type:'reasoning',summary:[{type:'summary_text',text:'内部推理'}]},
  {type:'message',role:'assistant',content:text.map(part=>({type:'output_text',text:part}))},
]}});
const claudeStart=namedEvent('message_start',{message:{role:'assistant'}});
const claudeBlock=(index,type,text='')=>namedEvent('content_block_start',{index,content_block:{type,text}});
const claudeText=(index,text)=>namedEvent('content_block_delta',{index,delta:{type:'text_delta',text}});
const claudeClose=index=>namedEvent('content_block_stop',{index});
const claudeEnd=stop_reason=>namedEvent('message_delta',{delta:{stop_reason}})+namedEvent('message_stop');

test('native stream adapters deliver visible text, resume the same task, and settle successful work once',async t=>{
  const {base,call,register,worker,requests,providers,definition,nativeResponses}=await fixture(t);
  const owner=await register('native-stream-owner');
  const system={role:'system',content:'Only use product facts.'};
  const user={role:'user',content:'Show the description.'};
  const cases=[
    {
      id:'responses-qa',protocol:'responses',path:'/v1/responses',
      first:namedEvent('response.reasoning_summary_text.delta',{delta:'内部推理'})+responsesDelta(1,0,'首段'),
      later:responsesDelta(1,1,'续段')+completedResponses('首段','续段'),
      expected:{input:[system,user],store:false},
    },
    {
      id:'claude-qa',protocol:'anthropic-messages',path:'/v1/messages',
      first:claudeStart+claudeBlock(0,'thinking')+namedEvent('content_block_delta',{index:0,delta:{type:'thinking_delta',thinking:'内部推理'}})
        +claudeClose(0)+claudeBlock(1,'text')+namedEvent('ping')+claudeText(1,'首段'),
      later:claudeClose(1)+claudeBlock(2,'text')+claudeText(2,'续段')+claudeClose(2)+claudeEnd('end_turn'),
      expected:{messages:[user],system:system.content,max_tokens:2048},
    },
  ];
  installModels(providers,cases.map(({id,protocol})=>definition(id,protocol,{streamText:true})));
  const directory=await call('GET','/v1/models?capabilityId=model.chat',200,owner);
  assert.deepEqual(directory.items.filter(model=>cases.some(entry=>entry.id===model.id)).map(model=>model.streamText),[true,true]);
  for (const entry of cases) {
    await t.test(entry.protocol,async()=>{
      const {promise:pause,resolve:resume}=Promise.withResolvers();
      nativeResponses.set(entry.id,{first:entry.first,later:entry.later,pause,resume});
      const submitted=await call('POST','/v1/tasks',202,owner,{capabilityId:'model.chat',mode:'chat',modelId:entry.id,
        parameters:{messages:[system,user],stream:true},idempotencyKey:randomUUID()});
      const taskPath='/v1/tasks/'+submitted.id;
      const initial=await fetch(base+taskPath+'/stream',{headers:owner,signal:AbortSignal.timeout(10000)});
      const execution=worker();
      try {
        const reader=initial.body.getReader();
        const decoder=new TextDecoder();
        let wire='';
        while (!wire.includes('首段')) {
          const next=await reader.read();
          assert.equal(next.done,false);
          wire+=decoder.decode(next.value,{stream:true});
        }
        assert.match(wire,/id: 1\nevent: delta/);
        assert.doesNotMatch(wire,/event: done|内部推理/);
        assert.equal((await call('GET',taskPath,200,owner)).state,'running');
        await reader.cancel();
      } finally {resume();}
      assert.equal(await execution,true);
      const replay=await fetch(base+taskPath+'/stream?after=1',{headers:owner});
      const wire=await replay.text();
      assert.doesNotMatch(wire.split('event: done')[0],/首段|内部推理/);
      assert.match(wire,/id: 2\nevent: delta/);
      assert.match(wire,/event: done/);
      assert.equal((await call('GET',taskPath,200,owner)).result.text,'首段\n续段');
      const providerCalls=requests.filter(request=>request.path===entry.path && request.body?.model===entry.id);
      assert.equal(providerCalls.length,1);
      assert.deepEqual(providerCalls[0].body,{model:entry.id,...entry.expected,stream:true});
    });
  }
  const wallet=await call('GET','/v1/credits/wallet',200,owner);
  assert.equal(wallet.balance,26);
  assert.equal(wallet.reserved,0);
});

test('native streams reject missing or conflicting final events and refund without leaking staged text',async t=>{
  const {base,call,register,worker,requests,providers,definition,nativeResponses}=await fixture(t);
  const owner=await register('native-stream-failures');
  installModels(providers,[definition('responses-qa','responses',{streamText:true}),
    definition('claude-qa','anthropic-messages',{streamText:true})]);
  const cases=[
    ['responses-qa',completedResponses('不一致结果'),'MODEL_RESPONSE_INCOMPLETE'],
    ['responses-qa',namedEvent('response.refusal.delta',{delta:'拒绝解释'}),'MODEL_CONTENT_BLOCKED'],
    ['claude-qa',claudeClose(0)+namedEvent('message_delta',{delta:{stop_reason:'end_turn'}}),'MODEL_RESPONSE_INCOMPLETE'],
    ['claude-qa',claudeClose(0)+claudeEnd('max_tokens'),'MODEL_RESPONSE_INCOMPLETE'],
    ['claude-qa',namedEvent('error',{error:{type:'overloaded_error',message:'未公开错误详情'}}),'MODEL_STREAM_INTERRUPTED'],
  ];
  for (const [modelId,later,errorCode] of cases) {
    const first=modelId==='responses-qa'?responsesDelta(0,0,'未完成片段'):claudeStart+claudeBlock(0,'text')+claudeText(0,'未完成片段');
    nativeResponses.set(modelId,{first,later});
    const submitted=await call('POST','/v1/tasks',202,owner,{capabilityId:'model.chat',mode:'chat',modelId,
      parameters:{messages:[{role:'user',content:'Exercise a model failure.'}],stream:true},idempotencyKey:randomUUID()});
    await worker();
    const taskPath='/v1/tasks/'+submitted.id;
    const result=await call('GET',taskPath,200,owner);
    assert.equal(result.state,'failed');
    assert.equal(result.errorCode,errorCode);
    assert.equal(result.attempts,1);
    const replay=await fetch(base+taskPath+'/stream',{headers:owner});
    assert.doesNotMatch(await replay.text(),/event: delta|未完成片段|未公开错误详情|拒绝解释/);
  }
  assert.equal(await worker(),false);
  assert.equal(requests.length,cases.length);
  const wallet=await call('GET','/v1/credits/wallet',200,owner);
  assert.equal(wallet.balance,30);
  assert.equal(wallet.reserved,0);
});

test('archive configuration errors omit connection credentials',async ()=>{
  const settings={databaseUrl:'postgresql://qa:fixture-private-value@invalid host/database',dedicatedDatabases:new Map()};
  await assert.rejects(backupDatabases(settings,join(tmpdir(),randomUUID()),tmpdir()),error=>{
    assert.match(error.message,/Use a PostgreSQL connection URL/);
    assert.doesNotMatch(JSON.stringify(error),/fixture-private-value/);
    assert.equal(error.input,undefined);
    return true;
  });
});

test('text streams deliver tokens before completion and resume through an owned cursor',async t=>{
  const {base,call,register,worker,release,streamRequests}=await fixture(t);
  const owner=await register('stream-owner');
  const other=await register('stream-other');
  const directory=await call('GET','/v1/models?capabilityId=model.chat',200,owner);
  assert.deepEqual(directory.items.map(({id,streamText})=>[id,streamText]),[['live-chat',true],['plain-chat',false]]);
  const body={capabilityId:'model.chat',mode:'chat',modelId:'live-chat',
    parameters:{stream:true,messages:[{role:'user',content:'Stream test'}]},idempotencyKey:randomUUID()};
  await call('POST','/v1/tasks',422,owner,{...body,modelId:'plain-chat'});
  const task=await call('POST','/v1/tasks',202,owner,body);
  assert.equal(task.streamed,true);
  assert.equal((await call('POST','/v1/tasks',200,owner,body)).id,task.id);
  const path='/v1/tasks/'+task.id;
  await call('GET',path+'/stream',404,other);
  const res=await fetch(base+path+'/stream',{headers:owner,signal:AbortSignal.timeout(10000)});
  assert.match(res.headers.get('content-type'),/^text\/event-stream/);
  const work=worker();
  try {
    const reader=res.body.getReader();
    let output='';
    const decoder=new TextDecoder();
    while (!output.includes('第一段')) {
      const token=await reader.read();
      assert.equal(token.done,false);
      output+=decoder.decode(token.value,{stream:true});
    }
    assert.match(output,/id: 1\nevent: delta/);
    assert.doesNotMatch(output,/event: done/);
    await reader.cancel();
  } finally {release();}
  assert.equal(await work,true);
  const replay=await fetch(base+path+'/stream',{headers:{...owner,'Last-Event-ID':'1'}});
  const text=await replay.text();
  assert.doesNotMatch(text.split('event: done')[0],/第一段/);
  assert.match(text,/id: 2\nevent: delta/);
  assert.match(text,/event: done/);
  assert.equal((await call('GET',path,200,owner)).result.text,'第一段第二段');
  assert.equal(streamRequests(),1);
  const ledger=await call('GET','/v1/credits/wallet',200,owner);
  assert.equal(ledger.balance,28);
  assert.equal(ledger.reserved,0);

  const bad=await call('POST','/v1/tasks',202,owner,{...body,idempotencyKey:randomUUID(),
    parameters:{stream:true,messages:[{role:'user',content:'reject-stream'}]}});
  assert.equal(await worker(),true);
  const result=await call('GET','/v1/tasks/'+bad.id,200,owner);
  assert.equal(result.state,'failed');
  assert.equal(result.errorCode,'MODEL_RESPONSE_INCOMPLETE');
  const failed=await fetch(base+'/v1/tasks/'+bad.id+'/stream',{headers:owner});
  assert.doesNotMatch(await failed.text(),/event: delta/);
  assert.equal((await call('GET','/v1/credits/wallet',200,owner)).balance,28);
});

test('voice turns persist the returned audio and never replay an earlier successful provider stage',async t=>{
  const {call,register,worker,requests,base,rejectSpeech}=await fixture(t);
  const owner=await register('voice-owner');
  const other=await register('voice-other');
  const directory=await call('GET','/v1/plugins',200,owner);
  assert.equal(directory.models.capabilities.find(item=>item.id==='model.voice-turn').available,true);
  const uploaded=await call('POST','/v1/assets',201,owner,{
    name:'sample.mp3',mediaType:'audio/mpeg',source:'Synthetic bytes',purpose:'Voice API test',dataBase64:tinyAudio.toString('base64'),
  });
  const body={capabilityId:'model.voice-turn',mode:'chat',parameters:{assetIds:[uploaded.id],
    transcriptionModelId:'transcript',chatModelId:'plain-chat',speechModelId:'synth',language:'en',voice:'test'},
    idempotencyKey:randomUUID()};
  await call('POST','/v1/tasks',404,other,body);
  const submitted=await call('POST','/v1/tasks',202,owner,body);
  assert.equal((await call('POST','/v1/tasks',200,owner,body)).id,submitted.id);
  await worker();
  const status=await call('GET','/v1/tasks/'+submitted.id,200,owner);
  assert.equal(status.state,'succeeded');
  assert.equal(status.streamed,false);
  assert.equal(status.result.transcript,'Voice question');
  assert.equal(status.result.answer,'Voice answer');
  assert.deepEqual(requests.map(item=>item.path),['/v1/audio/transcriptions','/v1/chat/completions','/v1/audio/speech']);
  assert.equal(requests[2].body.input,'Voice answer');
  const download=await fetch(base+'/v1/assets/'+status.result.assetId+'/content',{headers:owner});
  assert.equal(download.status,200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),tinyAudio);
  rejectSpeech();
  const failed=await call('POST','/v1/tasks',202,owner,{...body,idempotencyKey:randomUUID()});
  await worker();
  const failure=await call('GET','/v1/tasks/'+failed.id,200,owner);
  assert.equal(failure.state,'failed');
  assert.equal(failure.attempts,1);
  assert.equal(await worker(),false);
  assert.equal(requests.length,6);
  const wallet=await call('GET','/v1/credits/wallet',200,owner);
  assert.equal(wallet.balance,24);
  assert.equal(wallet.reserved,0);
});
