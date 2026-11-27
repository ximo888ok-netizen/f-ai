import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';

import { migrate, postgres } from '../src/db.js';
import { createVideoDelivery } from '../src/video-delivery.js';

const ffmpeg=process.env.FAI_TEST_FFMPEG_PATH;
const ffprobe=process.env.FAI_TEST_FFPROBE_PATH;
const encoder=process.env.FAI_TEST_VIDEO_ENCODER ?? 'libx264';
const exec=promisify(execFile);
const run=(tool,args)=>exec(tool,args,{encoding:'buffer',windowsHide:true,maxBuffer:1024*1024,timeout:15000});
const status='/v1/video-export/status';
const confirmed={aiGenerated:true};
const placeholder=Buffer.from('000000106674797069736f6d00000000','hex');

async function register(app,name) {
  const result=await app.inject({method:'POST',url:'/v1/auth/register',payload:await registrationPayload(app, {
    email:name+'@example.test',password:'integration-test-password',displayName:'Video QA',type:'personal',
  })});
  assert.equal(result.statusCode,201,result.body);
  const {token,account,workspaces}=result.json();
  return {account:account.id,workspace:workspaces[0].id,headers:{authorization:'Bearer '+token,'x-workspace-id':workspaces[0].id}};
}

const call=(app,member,method,url,payload)=>app.inject({method,url,payload,headers:member.headers});
async function upload(app,member,bytes) {
  const response=await call(app,member,'POST','/v1/assets',{
    name:'fixture.mp4',mediaType:'video/mp4',source:'Synthetic test',purpose:'Video QA',dataBase64:bytes.toString('base64'),
  });
  assert.equal(response.statusCode,201,response.body);
  return '/v1/assets/'+response.json().id;
}

test('marked export routes require an owned asset and established or explicitly declared origin',async t=>{
  const db=process.env.FAI_TEST_DATABASE_URL?postgres(process.env.FAI_TEST_DATABASE_URL):new PGlite();
  let rendererCalls=0;
  const app=await buildApp({db,videoDelivery:async bytes=>{rendererCalls++;return bytes;}});
  t.after(async()=>{await app.close();await db.close();});
  await migrate(db);
  const owner=await register(app,'marked-export-owner');
  const other=await register(app,'marked-export-other');
  const asset=await upload(app,owner,placeholder);
  assert.deepEqual((await call(app,owner,'GET',status)).json(),{available:true});
  assert.equal((await app.inject({url:asset+'/delivery',headers:{'x-workspace-id':owner.workspace}})).statusCode,401);
  assert.equal((await call(app,other,'GET',asset+'/delivery')).statusCode,404);
  assert.equal((await call(app,other,'POST',asset+'/video-export',confirmed)).statusCode,404);
  assert.equal((await call(app,owner,'POST',asset+'/video-export',{aiGenerated:false})).statusCode,400);
  assert.equal((await call(app,owner,'GET',asset+'/delivery')).statusCode,422);
  assert.equal(rendererCalls,0);
  assert.equal((await call(app,owner,'POST',asset+'/video-export',confirmed)).statusCode,200);
  const generatedId=asset.split('/').at(-1);
  await db.query(`INSERT INTO tasks(id,workspace_id,account_id,capability_id,provider_id,plugin_id,input,
    request_hash,idempotency_key,state,cost,result) VALUES($1,$2,$3,'video.generate','model:fixture','video',
    '{}','fixture',$4,'succeeded',1,$5)`,[randomUUID(),owner.workspace,owner.account,randomUUID(),JSON.stringify({assetId:generatedId})]);
  const result=await call(app,owner,'GET',asset+'/delivery');
  assert.equal(result.statusCode,200);
  assert.equal(result.headers['content-type'],'video/mp4');
  assert.match(result.headers['content-disposition'],/attachment; filename="ai-delivery-.*\.mp4"/);
  assert.equal(rendererCalls,2);
});

test('an exported MP4 contains the AI badge throughout and preserves the original asset and audio', {
  skip:!(ffmpeg && ffprobe),
},async t=>{
  const db=process.env.FAI_TEST_DATABASE_URL?postgres(process.env.FAI_TEST_DATABASE_URL):new PGlite();
  const app=await buildApp({db,videoDelivery:createVideoDelivery({ffmpeg,ffprobe,encoder})});
  const temp=await mkdtemp(join(tmpdir(),'fai-video-test-'));
  const [source,delivered]=['source.mp4','delivered.mp4'].map(file=>join(temp,file));
  t.after(async()=>{
    await app.close();
    await db.close();
    for (const file of [source,delivered]) await unlink(file).catch(error=>{if (error.code!=='ENOENT') throw error;});
    await rmdir(temp);
  });
  await migrate(db);
  const member=await register(app,'video-file-export');
  const malformed=await upload(app,member,placeholder);
  assert.equal((await call(app,member,'POST',malformed+'/video-export',confirmed)).statusCode,422);
  await run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=0xB12332:s=320x240:r=24',
    '-f','lavfi','-i','sine=frequency=440','-t','2','-c:v',encoder,'-c:a','aac',source]);
  const original=await readFile(source);
  const asset=await upload(app,member,original);
  const response=await call(app,member,'POST',asset+'/video-export',confirmed);
  assert.equal(response.statusCode,200,response.statusCode===200?'':response.body);
  assert.notDeepEqual(response.rawPayload,original);
  assert.deepEqual((await call(app,member,'GET',asset+'/content')).rawPayload,original);
  await writeFile(delivered,response.rawPayload);
  const probe=async path=>JSON.parse((await run(ffprobe,['-v','error','-show_entries',
    'format=duration:format_tags:stream=codec_name,nb_frames,duration','-of','json',path])).stdout);
  const input=await probe(source);
  const inspection=await probe(delivered);
  assert.deepEqual(inspection.streams.map(stream=>stream.codec_name),['h264','aac']);
  assert.equal(Number(inspection.streams[0].nb_frames),48);
  assert.equal(Number(inspection.format.duration),Number(input.format.duration));
  assert.equal(Number(inspection.streams[1].duration),Number(input.streams[1].duration));
  const audioHash=async path=>(await run(ffmpeg,['-v','error','-i',path,'-map','0:a:0',
    '-c:a','copy','-f','hash','-hash','sha256','-'])).stdout.toString().trim();
  const originalAudio=await audioHash(source);
  assert.match(originalAudio,/^SHA256=[0-9a-f]{64}$/i);
  assert.equal(await audioHash(delivered),originalAudio);
  assert.equal(inspection.format.tags.fai_ai_generated,'true');
  assert.equal(inspection.format.tags.fai_software,'F-AI Studio');
  assert.equal(inspection.format.tags.description,'AI-generated content');

  for (const second of ['0','1','1.9']) {
    const {stdout:pixels}=await run(ffmpeg,['-v','error','-ss',second,'-i',delivered,'-frames:v','1',
      '-pix_fmt','rgb24','-threads','1','-f','rawvideo','-']);
    let white=0,dark=0;
    for (let y=215;y<238;y++) {
      for (let x=200;x<318;x++) {
        const [r,g,b]=pixels.subarray((320*y+x)*3,(320*y+x)*3+3);
        if (r>180 && g>180 && b>180) white++;
        if (r<50 && g<50 && b<70) dark++;
      }
    }
    assert.ok(white>20 && dark>400,'tracks the visible badge at '+second+' seconds');
    assert.ok(pixels[0]>120 && pixels[1]<90,'leaves source above the badge visible');
  }
});
