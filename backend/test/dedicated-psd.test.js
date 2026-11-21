import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeCanvas, readPsd } from 'ag-psd';
import { createCanvas } from '@napi-rs/canvas';
import { imageSize } from 'image-size';
import { buildApp } from '../src/app.js';
import { migrate, postgres, row } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { config } from '../src/config.js';
import { workOnce } from '../src/worker.js';
import { cutoverWorkspace } from '../src/workspace-cutover.js';
import { provisionCredits } from '../src/wallet.js';

initializeCanvas(() => { throw new Error('Tests use raw pixels'); },
  (width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));

const sharedUrl = process.env.FAI_TEST_DATABASE_URL;
const dedicatedUrl = process.env.FAI_TEST_DEDICATED_DATABASE_URL;
const cutoverControlUrl = process.env.FAI_TEST_CUTOVER_CONTROL_URL ?? sharedUrl;
const openControl = () => cutoverControlUrl && dedicatedUrl ? postgres(cutoverControlUrl) : new PGlite();
const openDedicated = () => cutoverControlUrl && dedicatedUrl ? postgres(dedicatedUrl) : new PGlite();

async function register(app, email, type = 'enterprise') {
  const response = await app.inject({method:'POST',url:'/v1/auth/register',payload:{
    email,password:'demo-testing-password',displayName:'Studio QA',type,...(type==='enterprise' && {workspaceName:'QA Business'}),
  }});
  assert.equal(response.statusCode,201,response.body);
  const result=response.json();
  return {...result,workspace:result.workspaces[0].id};
}

const send = (app,owner,method,url,payload) => app.inject({method,url,payload,headers:{
  authorization:'Bearer '+owner.token,'x-workspace-id':owner.workspace,
}});
async function json(app,owner,method,url,status,payload) {
  const response=await send(app,owner,method,url,payload);
  assert.equal(response.statusCode,status,response.body);
  return status===204 ? undefined : response.json();
}
async function logo(app,owner,format='png') {
  const canvas = createCanvas(20,16);
  const context = canvas.getContext('2d');
  context.fillStyle='#ec3914';
  context.fillRect(0,0,20,16);
  const mime='image/'+format;
  const original=canvas.toBuffer(mime);
  const image=await json(app,owner,'POST','/v1/assets',201,{
    name:'test.'+format,mediaType:mime,source:'QA fixture',purpose:'test',dataBase64:original.toString('base64'),
  });
  return [image.id,original];
}

const designLayout={width:160,height:120,backgroundColor:'#e6efdb',
  placement:{x:20,y:44,width:100,height:66},
  caption:{text:'Editable QA',font:'sans',x:7,y:25,size:19,color:'#102038'}};
const psdPath='/v1/studio/psd-documents';

test('PNG preview and PSD export keep editable text and separately movable layers', async () => {
  const db=sharedUrl ? postgres(sharedUrl) : new PGlite();
  const app=await buildApp({db});
  try {
    await migrate(db);
    const owner=await register(app,'psd-owner@example.test');
    const other=await register(app,'psd-other@example.test');
    const [assetId]=await logo(app,owner);
    const [foreign]=await logo(app,other);
    const [background]=await logo(app,owner,'jpeg');
    const input={revision:0,title:' Synthetic banner ',layout:designLayout,subjectAssetId:assetId,backgroundAssetId:null};
    const url=psdPath+'/'+randomUUID();
    await json(app,owner,'PUT',url,404,{...input,subjectAssetId:foreign});
    await json(app,owner,'PUT',url,400,{...input,layout:{...designLayout,caption:{...designLayout.caption,y:600}}});
    const initial=await json(app,owner,'PUT',url,200,input);
    assert.deepEqual(await json(app,owner,'PUT',url,200,input),initial);
    assert.equal(initial.title,'Synthetic banner');
    await json(app,other,'GET',url,404);
    await json(app,other,'GET',url+'/export',404);
    const revision=await json(app,owner,'PUT',url,200,{...input,revision:1,title:'Edited banner',backgroundAssetId:background});
    assert.equal(revision.revision,2);
    await json(app,owner,'PUT',url,409,{...input,revision:1,title:'Stale banner'});
    await json(app,owner,'DELETE','/v1/assets/'+assetId,409);
    await json(app,owner,'DELETE','/v1/assets/'+background,409);
    const preview=await send(app,owner,'GET',url+'/preview');
    assert.equal(preview.statusCode,200,preview.body.slice(0,200));
    assert.equal(imageSize(preview.rawPayload).width,160);
    const output=await send(app,owner,'GET',url+'/export');
    assert.equal(output.statusCode,200,output.body.slice(0,200));
    assert.match(output.headers['content-disposition'],/\.psd"/);
    const psd=readPsd(output.rawPayload,{useImageData:true,skipThumbnail:true});
    assert.deepEqual(psd.children.map(layer=>layer.name),['Background','Subject','Caption']);
    assert.equal(psd.children[0].imageData.width,160);
    assert.equal(psd.children[1].left,20);
    assert.equal(psd.children[1].top,44);
    assert.equal(psd.children[1].imageData.width,100);
    assert.equal(psd.children[2].text.text,'Editable QA');
    assert.deepEqual(psd.children[2].text.transform,[1,0,0,1,7,25]);
    assert.ok(psd.children[2].imageData.data.some((v,index)=>index%4===3 && v>0));
    assert.ok(psd.imageData);
    await json(app,owner,'DELETE',url,204);
    await json(app,owner,'DELETE','/v1/assets/'+assetId,204);
  } finally {
    await app.close();
    await db.close();
  }
});

test('enterprise cutover handles interruption, preserves business data and fails closed', async () => {
  const control=openControl(), target=openDedicated();
  const databases=new Map([['dedicated',target]]);
  const providers=createProviders(), shops=new Map();
  const app=await buildApp({db:control,dedicatedDatabases:databases,providers,shops});
  try {
    await migrate(control);
    await migrate(target);
    const enterprise=await register(app,'dedicated-owner@example.test');
    const member=await register(app,'dedicated-member@example.test','personal');
    const {workspace}=enterprise;
    const [assetId,bytes]=await logo(app,enterprise);
    const [sharedAsset]=await logo(app,member);
    const design=await json(app,enterprise,'PUT',psdPath+'/'+randomUUID(),200,{
      title:'Migration test',layout:designLayout,subjectAssetId:assetId,revision:0,
    });
    const project=await json(app,enterprise,'POST','/v1/projects',201,{name:'Migration project'});
    await provisionCredits(control,workspace,enterprise.account.id,15,'qa-dedicated');
    const original=await json(app,enterprise,'POST','/v1/tasks',202,{
      capabilityId:'copywriting.detect-terms',mode:'workflow',parameters:{content:'QA one'},idempotencyKey:'dedicated-test-one',
    });
    assert.equal(await workOnce({db:control,providers,shops}),true);
    const pending=await json(app,enterprise,'POST','/v1/tasks/'+original.id+'/regenerate',202,{idempotencyKey:'dedicated-test-again'});

    const interrupted={query:(...args)=>control.query(...args),transaction:run=>control.transaction(tx=>run({
      query:(sql,args)=>{
        if (sql.startsWith('WITH removed AS')) throw new Error('Simulated interruption after target commit');
        return tx.query(sql,args);
      },
    }))};
    await assert.rejects(cutoverWorkspace(interrupted,target,workspace,'dedicated'),/Simulated interruption/);
    assert.deepEqual(await json(app,enterprise,'GET','/v1/workspace/database',200),{mode:'dedicated',state:'preparing'});
    await json(app,enterprise,'POST','/v1/projects',503,{name:'Must not fall back'});
    const onSource=await row(control,'SELECT count(*)::int AS count FROM assets WHERE workspace_id=$1',[workspace]);
    assert.equal(onSource.count,1);
    const staged=await row(target,'SELECT count(*)::int AS count FROM assets WHERE workspace_id=$1',[workspace]);
    assert.equal(staged.count,1);
    assert.equal((await cutoverWorkspace(control,target,workspace,'dedicated')).state,'active');
    assert.equal((await cutoverWorkspace(control,target,workspace,'dedicated')).alreadyActive,true);
    assert.deepEqual(await json(app,enterprise,'GET','/v1/workspace/database',200),{mode:'dedicated',state:'ready'});
    assert.equal((await json(app,enterprise,'GET','/v1/projects/'+project.id,200)).name,project.name);
    assert.equal((await json(app,enterprise,'GET',psdPath+'/'+design.id,200)).subjectAssetId,assetId);
    const migrated=await send(app,enterprise,'GET','/v1/assets/'+assetId+'/content');
    assert.equal(migrated.statusCode,200);
    assert.deepEqual(migrated.rawPayload,bytes);
    await json(app,enterprise,'POST','/v1/studio/products',201,{sku:'DB-ONLY',name:'Routing sentinel'});
    assert.equal((await row(control,'SELECT count(*)::int AS count FROM assets WHERE workspace_id=$1',[workspace])).count,0);
    assert.equal((await row(control,'SELECT count(*)::int AS count FROM studio_products WHERE workspace_id=$1',[workspace])).count,0);
    assert.equal((await row(target,'SELECT sku FROM studio_products WHERE workspace_id=$1',[workspace])).sku,'DB-ONLY');
    assert.equal((await row(control,'SELECT count(*)::int AS count FROM wallets WHERE workspace_id=$1',[workspace])).count,0);
    assert.equal((await row(target,'SELECT count(*)::int AS count FROM sessions')).count,0);
    assert.equal((await row(target,'SELECT password_hash FROM accounts WHERE id=$1',[enterprise.account.id])).password_hash,'managed-by-control-database');
    assert.equal(await workOnce({db:control,providers,shops}),false);
    const routed=await app.workspaceDatabaseRouter.workerDatabase('dedicated');
    assert.equal(await workOnce({db:routed,identityDb:control,providers,shops}),true);
    assert.equal((await json(app,enterprise,'GET','/v1/tasks/'+pending.id,200)).state,'succeeded');
    const hosted=await send(app,member,'GET','/v1/assets/'+sharedAsset+'/content');
    assert.equal(hosted.statusCode,200);
    await json(app,member,'GET','/v1/assets/'+assetId+'/content',404);

    const invite=await json(app,enterprise,'POST','/v1/invitations',201,{email:member.account.email,role:'member'});
    await json(app,member,'POST','/v1/invitations/accept',200,{token:invite.token});
    const invited={...member,workspace};
    assert.equal((await json(app,invited,'GET','/v1/credits/wallet',200)).balance,0);
    assert.equal((await json(app,invited,'GET','/v1/notifications',200)).items[0].type,'member.joined');
    await json(app,enterprise,'PATCH','/v1/members/'+member.account.id,200,{role:'admin'});
    assert.equal((await json(app,invited,'GET','/v1/notifications',200)).items[0].type,'member.role-changed');
    assert.equal((await row(control,'SELECT count(*)::int AS count FROM wallets WHERE workspace_id=$1',[workspace])).count,0);

    databases.delete('dedicated');
    assert.deepEqual(await json(app,enterprise,'GET','/v1/workspace/database',200),{mode:'dedicated',state:'unavailable'});
    assert.equal((await json(app,enterprise,'POST','/v1/projects',503,{name:'Forbidden fallback'})).error.code,'WORKSPACE_DATABASE_UNAVAILABLE');
    assert.equal((await row(control,'SELECT count(*)::int AS count FROM projects WHERE workspace_id=$1',[workspace])).count,0);
    assert.equal((await send(app,member,'GET','/v1/assets/'+sharedAsset+'/content')).statusCode,200);
  } finally {
    await app.close();
    await Promise.all([control.close(),target.close()]);
  }
});

test('dedicated configuration rejects a role change or query option pointing to the same physical database', () => {
  const values = {
    DATABASE_URL:'postgresql://qa@localhost/control',
    DEDICATED_DATABASES_JSON:'{"team":"QA_WORKSPACE_DB"}',
    QA_WORKSPACE_DB:'postgresql://operator@localhost:5432/control?application_name=test',
  };
  assert.throws(()=>config(values),/distinct PostgreSQL/);
  const valid=config({...values,QA_WORKSPACE_DB:'postgresql://operator@localhost:5432/workspace'});
  assert.deepEqual([...valid.dedicatedDatabases.keys()],['team']);
});
