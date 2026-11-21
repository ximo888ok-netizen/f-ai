import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createCanvas,loadImage } from '@napi-rs/canvas';
import { PGlite } from '@electric-sql/pglite';
import { imageSize } from 'image-size';
import { buildApp } from '../src/app.js';
import { migrate,postgres } from '../src/db.js';
import { createVideoDelivery } from '../src/video-delivery.js';

const ffmpeg=process.env.FAI_TEST_FFMPEG_PATH;
const ffprobe=process.env.FAI_TEST_FFPROBE_PATH;
const encoder=process.env.FAI_TEST_VIDEO_ENCODER ?? 'libx264';
const cli=promisify(execFile);
const run=(tool,args)=>cli(tool,args,{windowsHide:true,encoding:'buffer',timeout:30000,maxBuffer:1024*1024});

function picture(color,width=120,height=96) {
  const canvas=createCanvas(width,height);
  const ctx=canvas.getContext('2d');
  ctx.fillStyle=color;
  ctx.fillRect(0,0,width,height);
  return canvas.toBuffer('image/png');
}
function format(bytes,dimensions) {
  const {width,height,type}=imageSize(bytes);
  assert.deepEqual([width,height,type],dimensions);
}

async function fixture(t,render) {
  const db=process.env.FAI_TEST_DATABASE_URL?postgres(process.env.FAI_TEST_DATABASE_URL):new PGlite();
  const app=await buildApp({db,videoDelivery:render});
  t.after(async()=>{await app.close();await db.close();});
  await migrate(db);
  async function user(handle) {
    const response=await app.inject({method:'POST',url:'/v1/auth/register',payload:{
      email:handle+'@example.test',password:'media-integration-fixture',displayName:handle,type:'personal',
    }});
    assert.equal(response.statusCode,201,response.body);
    const {token,account,workspaces}=response.json();
    const workspace=workspaces[0].id;
    const request=async (method,url,status,payload,binary=false)=>{
      const response=await app.inject({method,url,payload,headers:{authorization:'Bearer '+token,'x-workspace-id':workspace}});
      assert.equal(response.statusCode,status,response.statusCode===status?'':response.body);
      return binary?response.rawPayload:status===204?undefined:response.json();
    };
    const upload=(bytes,mediaType='image/png')=>request('POST','/v1/assets',201,{
      name:'fixture',mediaType,source:'Synthetic fixture',purpose:'QA',dataBase64:bytes.toString('base64'),
    });
    return {request,upload,workspace,account:account.id};
  }
  return {db,user};
}

async function gen(db,owner,assetId) {
  await db.query(`INSERT INTO tasks(id,workspace_id,account_id,capability_id,provider_id,plugin_id,input,
    request_hash,idempotency_key,state,cost,result) VALUES($1,$2,$3,'image.main-image','model:fixture','image',
    '{}','fixture',$4,'succeeded',1,$5)`,[randomUUID(),owner.workspace,owner.account,randomUUID(),JSON.stringify({assetId})]);
}

test('image batches persist valid SKU results, render six stacked panels and keep provenance',async t=>{
  const {db,user}=await fixture(t);
  const owner=await user('image-batch-owner');
  const other=await user('image-batch-outsider');
  const red=await owner.upload(picture('red'));
  const blue=await owner.upload(picture('blue'));
  const unavailable=await other.upload(picture('yellow'));
  const invalid=await owner.upload(Buffer.from('89504e470d0a1a0a','hex'));
  await gen(db,owner,blue.id);
  const endpoint='/v1/media/images/batches';
  const input={id:randomUUID(),items:[
    {key:'square-a',assetIds:[red.id],profile:'square',background:'#305030',format:'jpeg'},
    {key:'detail-b',assetIds:[red.id,blue.id,red.id,blue.id,red.id,blue.id],width:200,height:1200},
    {key:'cross-tenant',assetIds:[unavailable.id],profile:'square'},
    {key:'bad-image',assetIds:[invalid.id],profile:'square'},
  ]};
  const result=await owner.request('POST',endpoint,201,input);
  assert.deepEqual(await owner.request('GET',endpoint+'/'+input.id,200),result);
  await other.request('GET',endpoint+'/'+input.id,404);
  const again=await owner.request('POST',endpoint,200,input);
  assert.deepEqual(again,result);
  await owner.request('POST',endpoint,409,{...input,items:input.items.slice(0,1)});
  assert.deepEqual(result.items.map(item=>item.state),['succeeded','succeeded','failed','failed']);
  assert.deepEqual(result.items.slice(2).map(item=>item.error),['SOURCE_UNAVAILABLE','SOURCE_INVALID']);
  const single=result.items[0];
  const jpg=await owner.request('GET','/v1/assets/'+single.assetId+'/content',200,undefined,true);
  format(jpg,[800,800,'jpg']);
  assert.equal(single.aiGenerated,false);
  const strip=result.items[1];
  const png=await owner.request('GET','/v1/assets/'+strip.assetId+'/content',200,undefined,true);
  format(png,[200,1200,'png']);
  assert.ok(png.includes('AI-generated content'));
  const canvas=createCanvas(200,1200);
  const ctx=canvas.getContext('2d');
  ctx.drawImage(await loadImage(png),0,0);
  assert.deepEqual(Array.from(ctx.getImageData(100,100,1,1).data),[255,0,0,255]);
  assert.deepEqual(Array.from(ctx.getImageData(100,300,1,1).data),[0,0,255,255]);
  await other.request('GET','/v1/assets/'+strip.assetId+'/content',404);
});

test('image masks operate only on selected pixels and local enlargement honors the factor',async t=>{
  const {user}=await fixture(t);
  const owner=await user('image-mask-owner');
  const original=await owner.upload(picture('red',96,96));
  const replace=await owner.upload(picture('blue',96,96));
  const canvas=createCanvas(96,96);
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='white';
  ctx.fillRect(0,0,48,96);
  const mask=await owner.upload(canvas.toBuffer('image/png'));
  const endpoint='/v1/media/images/batches';
  const result=await owner.request('POST',endpoint,201,{id:randomUUID(),items:[
    {key:'patch',assetIds:[original.id],width:96,height:96,
      edit:{method:'replace-region',maskAssetId:mask.id,replacementAssetId:replace.id}},
    {key:'cutout',assetIds:[original.id],scale:2,edit:{method:'cutout',maskAssetId:mask.id}},
  ]});
  assert.deepEqual(result.items.map(item=>[item.state,item.width,item.height]),[
    ['succeeded',96,96],['succeeded',192,192],
  ]);
  for (const [index,item] of result.items.entries()) {
    const bytes=await owner.request('GET','/v1/assets/'+item.assetId+'/content',200,undefined,true);
    const image=await loadImage(bytes);
    const output=createCanvas(image.width,image.height).getContext('2d');
    output.drawImage(image,0,0);
    const sample=x=>Array.from(output.getImageData(x,30,1,1).data);
    assert.deepEqual(sample(20),index?[255,0,0,255]:[0,0,255,255]);
    assert.deepEqual(sample(image.width-20),index?[0,0,0,0]:[255,0,0,255]);
  }
});

test('video studio produces reframed MP4, marked stills, MP3 and a revised storyboard movie',{
  skip:!(ffmpeg && ffprobe),
},async t=>{
  const {db,user}=await fixture(t,createVideoDelivery({ffmpeg,ffprobe,encoder}));
  const owner=await user('storyboard-owner');
  const other=await user('storyboard-outsider');
  const temp=await mkdtemp(join(tmpdir(),'fai-media-qa-'));
  const files=['source.mp4','reframed.mp4','sound.mp3','storyboard.mp4'].map(name=>join(temp,name));
  const [source,reframed,sound,story]=files;
  t.after(async()=>{
    for (const file of files) await unlink(file).catch(error=>{if (error.code!=='ENOENT') throw error;});
    await rmdir(temp);
  });
  await run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=red:s=320x240:r=24','-f','lavfi','-i','sine=frequency=350',
    '-t','2','-c:v',encoder,'-c:a','aac',source]);
  const video=await owner.upload(await readFile(source),'video/mp4');
  const path='/v1/media/videos/'+video.id+'/export';
  const mp4=await owner.request('POST',path,200,{format:'mp4',ratio:'9:16',keepAudio:false,aiGenerated:true},true);
  await writeFile(reframed,mp4);
  const probe=async path=>JSON.parse((await run(ffprobe,['-v','error','-show_entries',
    'stream=codec_type,width,height,codec_name:format=duration:format_tags','-of','json',path])).stdout);
  const exported=await probe(reframed);
  assert.deepEqual(exported.streams,[{codec_name:'h264',codec_type:'video',width:720,height:1280}]);
  assert.equal(exported.format.tags.fai_ai_generated,'true');
  const png=await owner.request('POST',path,200,{format:'png',ratio:'1:1',frameMs:500,aiGenerated:true},true);
  format(png,[720,720,'png']);
  assert.ok(png.includes('AI-generated content'));
  const jpg=await owner.request('POST',path,200,{format:'jpg',frameMs:500},true);
  format(jpg,[320,240,'jpg']);
  await owner.request('POST',path,422,{format:'png',frameMs:3000});
  await other.request('POST',path,404,{format:'mp4'});
  const audio=await owner.request('POST',path,200,{format:'mp3',aiGenerated:true},true);
  await writeFile(sound,audio);
  const audioProbe=await probe(sound);
  assert.equal(audioProbe.streams[0].codec_name,'mp3');
  assert.match(audioProbe.format.tags.comment,/AI-generated video/);

  const red=await owner.upload(picture('red'));
  const green=await owner.upload(picture('green'));
  const audioAsset=await owner.upload(audio,'audio/mpeg');
  await gen(db,owner,red.id);
  const storyboard='/v1/media/storyboards/'+randomUUID();
  const body={revision:0,title:'Synthetic storyboard',template:'feature-details',ratio:'1:1',audioAssetId:audioAsset.id,
    shots:[{assetId:red.id,durationMs:1000,caption:'Product intro'},{assetId:green.id,durationMs:1000,prompt:'Second reference'}]};
  const created=await owner.request('PUT',storyboard,200,body);
  assert.equal(created.revision,1);
  await other.request('GET',storyboard,404);
  assert.equal((await owner.request('GET',storyboard+'/prompts',200)).items[1].prompt,'Second reference');
  const edited=await owner.request('PUT',storyboard,200,{...body,revision:1,shots:[...body.shots].reverse()});
  assert.equal(edited.revision,2);
  await owner.request('POST',storyboard+'/export',409,{revision:1});
  const movie=await owner.request('POST',storyboard+'/export',200,{revision:2},true);
  await writeFile(story,movie);
  const summary=await probe(story);
  assert.deepEqual(summary.streams.map(stream=>stream.codec_name),['h264','aac']);
  assert.equal(summary.format.tags.fai_ai_generated,'true');
  assert.equal(Number(summary.format.duration),2);
  const color=async time=>{
    const {stdout}=await run(ffmpeg,['-v','error','-ss',time,'-i',story,'-vf','crop=2:2:300:300','-frames:v','1',
      '-pix_fmt','rgb24','-threads','1','-f','rawvideo','-']);
    return [...stdout.subarray(0,3)];
  };
  const [r1,g1]=await color('0.25');
  const [r2,g2]=await color('1.5');
  assert.ok(g1>95 && r1<40);
  assert.ok(r2>170 && g2<40);
});
