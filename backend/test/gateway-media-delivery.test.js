import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { migrate, postgres } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';

test('a video gateway without declared model settings preserves its original submission contract', () => {
  const gateway = createProviders({url:'https://gateway.example.test/generate', token:'test', capabilities:['video.compose']}).get('gateway');
  const validate = params => gateway.validate({id:'video.compose'}, params);
  assert.doesNotThrow(() => validate({prompt:'商品展示', ratio:'16:9', options:{durationSeconds:10}}));
  for (const params of [{options:{resolution:'720p'}}, {options:{generateAudio:false}}, {options:{durationSeconds:31}}, {ratio:'77:1'}]) {
    assert.throws(() => validate(params), {statusCode:400, code:'INVALID_INPUT'});
  }
});

test('gateway media jobs require deliverable results before charging the submitting account', async t => {
  const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
  t.after(() => db.close());
  await migrate(db);
  const providers = createProviders({ url:'https://gateway.example.test/generate', token:'test', capabilities:['image.main-image','video.compose'] });
  const shops = new Map();
  const app = await buildApp({db, providers, shops});
  t.after(() => app.close());
  const api = async (method,url,status,headers,payload) => {
    const result = await app.inject({method,url,headers,payload});
    assert.equal(result.statusCode,status,result.body);
    return result.json();
  };
  const signUp = async name => {
    const session = await api('POST','/v1/auth/register',201,{},await registrationPayload(app, {
      email:name+'@example.test', password:'regression-local', type:'personal', displayName:name,
    }));
    const workspace = session.workspaces[0].id;
    return {workspace,account:session.account.id,headers:{authorization:'Bearer '+session.token,'x-workspace-id':workspace}};
  };
  const user = await signUp('gateway-owner'), other = await signUp('gateway-other');
  const upload = who => api('POST','/v1/assets',201,who.headers,{name:'item.png',source:'fixture',purpose:'integration',
    mediaType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='});
  const ours = await upload(user), theirs = await upload(other);
  await provisionCredits(db,user.workspace,user.account,100,'gateway-verification');
  let reply;
  t.mock.method(globalThis,'fetch',async () => Response.json({result:reply}));
  const wallet = () => api('GET','/v1/credits/wallet',200,user.headers);
  for (const [capabilityId,output,success,errorCode='INVALID_PROVIDER_RESULT'] of [
    ['image.main-image',{},false], ['video.compose',{status:'done'},false],
    ['image.main-image',{assetId:theirs.id},false], ['video.compose',{assetId:ours.id},false],
    ['image.main-image',{dataBase64:'iVBORw0KGgoAAAAAAAAAAAAA',mediaType:'image/png'},false,'INVALID_PROVIDER_IMAGE'],
    ['image.main-image',{assetId:ours.id},true],
  ]) {
    const before = await wallet();
    reply = output;
    const task = await api('POST','/v1/tasks',202,user.headers,{capabilityId,mode:'workflow',
      idempotencyKey:randomUUID(),parameters:{prompt:'product'}});
    assert.equal(await workOnce({db,providers,shops}),true);
    const done = await api('GET','/v1/tasks/'+task.id,200,user.headers);
    assert.equal(done.state,success?'succeeded':'failed');
    const after = await wallet();
    assert.equal(after.reserved,0);
    if(success){
      assert.equal(done.result.assetId,ours.id);
      assert.equal(done.result.mediaType,'image/png');
      assert.equal(after.available,before.available-task.cost);
    }else{
      assert.equal(done.errorCode,errorCode);
      assert.equal(done.result,null);
      assert.equal(after.available,before.available);
    }
  }
});
