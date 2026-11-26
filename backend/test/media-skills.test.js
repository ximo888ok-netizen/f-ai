import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { installModels } from '../src/models.js';
import { catalog } from '../src/catalog.js';
import { mediaSkills, shopChannels } from '../src/media-skills.js';
import { mediaSettings } from '../src/media-skill-runtime.js';
import { startVideo } from '../src/model-video.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOutputs } from '../src/media-skill-files.js';
import { validateBinding } from '../src/media-skill-container.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mediaSources } from '../src/media-skill-sources.js';

test('media recipes have distinct task routes and explicit native input contracts',async()=>{
  assert.equal(mediaSkills.length,new Set(mediaSkills.map(s=>s.id)).size);
  assert.equal(mediaSkills.length,new Set(mediaSkills.map(s=>s.alias)).size);
  for(const s of mediaSkills){
    assert.ok(s.channels.every(v=>shopChannels.includes(v)));assert.equal(catalog.get(s.id).requiresConsent,s.consent);
  }
  const providers=installModels(createProviders(),[{id:'frames',model:'wan2.2-kf2v-flash',protocol:'wan-frames',baseUrl:'http://127.0.0.1:8000'}],{});
  const wan=catalog.get('video.skill-wan-generate'),p=providers.get('model:frames');
  assert.ok(p.supports(wan));assert.throws(()=>p.validate(wan,{prompt:'test',assetIds:['one']}));
  p.validate(wan,{prompt:'test',assetIds:['one','two']});
  const assets=['first','last'].map(dataBase64=>({mediaType:'image/png',dataBase64}));
  const calls=[];
  const call=(path,body,headers)=>{calls.push({path,body,headers});return {id:'task',output:{task_id:'task'}};};
  await startVideo({protocol:'wan-frames',model:'test'},{parameters:{prompt:'test'},assets},call);
  assert.match(calls[0].body.input.first_frame_url,/first$/);assert.match(calls[0].body.input.last_frame_url,/last$/);
  assert.equal(calls[0].headers['X-DashScope-Async'],'enable');
  await startVideo({protocol:'ark-video',model:'test'},{parameters:{prompt:'test',frameMode:'references'},assets},call);
  assert.deepEqual(calls[1].body.content.slice(1).map(c=>c.role),['reference_image','reference_image']);
});

test('incomplete output sets and unexpected provider environment fields fail closed',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'skill-output-test-'));t.after(()=>rm(dir,{force:true,recursive:true}));
  const spec=mediaSkills.find(s=>s.id==='image.skill-ecommerce-listing-suite');
  await writeFile(join(dir,'result.json'),JSON.stringify({status:'succeeded',text:'',files:['one.png']}));
  await assert.rejects(readOutputs(dir,spec),{code:'INVALID_SKILL_OUTPUT'});
  await writeFile(join(dir,'result.json'),JSON.stringify({status:'succeeded',text:'',files:['../one.png','two.png']}));
  await assert.rejects(readOutputs(dir,spec),{code:'INVALID_SKILL_OUTPUT'});
  const binding={workspaceId:'11111111-1111-4111-8111-111111111111',image:'sha256:'+'a'.repeat(64),network:'vendor-only',source:'kling'};
  assert.throws(()=>validateBinding({...binding,env:{NODE_OPTIONS:'TEST_KEY'}},{}));
  assert.throws(()=>validateBinding({...binding,network:'host'},{}));
});

test('A+ workflow sends real reference bytes to image edits and crops every selected module', {
  skip:!process.env.FAI_TEST_MEDIA_SKILLS_FILE,
}, async()=>{
  const config=mediaSettings({FAI_MEDIA_SKILLS_FILE:process.env.FAI_TEST_MEDIA_SKILLS_FILE});
  await promisify(execFile)(config.python,['-I','-B',fileURLToPath(new URL('./media-vendor-wire.py',import.meta.url)),
    join(config.sources,'commerce',mediaSources.commerce.revision)],{timeout:120000,windowsHide:true});
});

test('original local skill tasks produce owned assets, ordered slices and an editable storyboard', {
  skip:!process.env.FAI_TEST_MEDIA_SKILLS_FILE,
},async t=>{
  const config=mediaSettings({FAI_MEDIA_SKILLS_FILE:process.env.FAI_TEST_MEDIA_SKILLS_FILE});
  assert.equal(config.bindings.length,0,'this smoke test uses offline local scripts only');
  const db=new PGlite(),providers=createProviders(),shops=new Map();await migrate(db);
  const app=await buildApp({db,providers,shops,mediaRuntime:config});
  t.after(async()=>{await app.close();await db.close();});
  async function api(code,method,url,account,payload){
    const headers=account?{authorization:'Bearer '+account.token,'x-workspace-id':account.workspaces[0].id}:{};
    const r=await app.inject({method,url,headers,payload});assert.equal(r.statusCode,code,r.body.slice(0,600));return r.json();
  }
  const register=email=>api(201,'POST','/v1/auth/register',null,{email,password:'skill-test-only',displayName:'test',type:'personal'});
  const a=await register('media@demo.invalid'),b=await register('other@demo.invalid');
  await provisionCredits(db,a.workspaces[0].id,a.account.id,12,'media-regression');
  for(const kind of ['image','video']){
    const {items}=await api(200,'GET','/v1/media-skills/'+kind,a);
    assert.equal(items.length,mediaSkills.filter(s=>s.kind===kind).length);
    assert.ok(items.every(s=>s.native||s.installed));
    assert.ok(items.filter(s=>s.local).every(s=>s.state==='local_ready'));
    assert.ok(items.filter(s=>!s.local).every(s=>!s.models.length));
  }
  const upload=async color=>{
    const c=createCanvas(250,300),g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,250,300);g.fillStyle=color;g.fillRect(20,30,210,240);
    return api(201,'POST','/v1/assets',a,{name:color+'.png',mediaType:'image/png',source:'tests',purpose:'verify media',dataBase64:c.toBuffer('image/png').toString('base64')});
  };
  const one=await upload('red'),two=await upload('blue');
  for(const [id,ids] of [['image.skill-white-check',[one.id]],['image.skill-stitch',[two.id,one.id]],['video.skill-product-storyboard',[one.id]]]){
    const spec=mediaSkills.find(s=>s.id===id);
    const body={capabilityId:id,modelId:spec.alias,mode:'workflow',parameters:{prompt:'Cup verification',platform:spec.channels[0],assetIds:ids},idempotencyKey:spec.alias+'-test'};
    const t=await api(202,'POST','/v1/tasks',a,body);
    assert.equal((await api(200,'POST','/v1/tasks',a,body)).id,t.id);
    await workOnce({db,providers,shops});
    const result=await api(200,'GET','/v1/tasks/'+t.id,a);
    assert.equal(result.state,'succeeded',result.errorCode);
    if(spec.output==='text'){assert.match(result.result.text,/Cup verification/);continue;}
    assert.ok(result.result.files.length>=(spec.local==='stitch'?2:1));
    for(const f of result.result.files){
      const asset=await api(200,'GET','/v1/assets/'+f.assetId,a);
      assert.ok(asset.sizeBytes>32);await api(404,'GET','/v1/assets/'+f.assetId,b);
    }
  }
});
