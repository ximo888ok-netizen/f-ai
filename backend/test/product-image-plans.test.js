import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres, row } from '../src/db.js';
import { installModels } from '../src/models.js';
import { createProviders } from '../src/providers.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';
import { workspaceV1 } from '../sdk/workspace-v1.mjs';

const root = '/v1/media/images/product-plans';
const taskUrl = id => '/v1/tasks/'+id;

function assertPlanOpenApi(paths) {
  const detail = root+'/{id}';
  const statuses = [
    [root,'get',['200']], [root,'post',['200','201']], [detail,'get',['200']], [detail,'put',['200']],
    [detail+'/confirm','post',['200','202']], [detail+'/images/{position}/retry','post',['200','202']],
    [detail+'/apply-to-draft','post',['200']],
  ];
  for (const [path,method,successes] of statuses) {
    const {responses} = paths[path][method];
    assert.deepEqual(Object.keys(responses).filter(status=>/^2\d\d$/.test(status)),successes);
    for (const status of successes) {
      assert.equal(responses[status].content['application/json'].schema.type,'object');
      assert.equal(responses[status].headers['x-request-id'].schema.type,'string');
    }
  }
  const {properties} = paths[detail].get.responses['200'].content['application/json'].schema;
  for (const field of ['position','attempt','taskId','canRetry','retryUrl','eventCursor','aiGenerated','deliveryUrl']) {
    assert.ok(properties.images.items.required.includes(field),field);
  }
  const events = paths['/v1/tasks/{id}/events'].get;
  assert.ok(events.parameters.some(({name,schema})=>name==='after' && schema.type==='string'));
  const eventFields = events.responses['200'].content['application/json'].schema.properties;
  assert.equal(eventFields.nextCursor.type,'string');
  assert.equal(eventFields.items.items.properties.retryable.type,'boolean');
  const delivery = paths['/v1/assets/{id}/delivery'].get.responses;
  for (const type of ['image/png','image/jpeg','video/mp4']) {
    assert.equal(delivery['200'].content[type].schema.format,'binary');
  }
  assert.ok(delivery['200'].headers['content-disposition']);
  assert.ok(delivery['4XX'].content['application/json']);
  assert.equal(paths['/v1/assets/{id}/content'].get.responses['200'].content['image/png'].schema.format,'binary');
}

function png(color) {
  const canvas = createCanvas(32,32);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0,0,32,32);
  return canvas.toBuffer('image/png');
}

test('product image plans generate one main and three details, retry one failure and fill the draft', async t => {
  const database = process.env.FAI_TEST_DATABASE_URL;
  const db = database ? postgres(database) : new PGlite();
  const sourceImage = png('#406ab0');
  const resultImages = new Map([
    ['商品主图',png('#ccd121')], ['主体细节',png('#20d120')], ['使用场景',png('#db0a23')], ['卖点摘要',png('#5395ee')],
  ]);
  const providerCalls = [];
  const providerErrors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url,'/v1/images/edits');
      const form = await new Response(request,{headers:request.headers}).formData();
      assert.equal(form.get('model'),'test-images');
      assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()),sourceImage);
      const prompt = form.get('prompt');
      assert.match(prompt,/整体设计：统一使用深蓝底色/);
      const title = prompt.match(/^图片标题：([^\r\n]+)/m)?.[1];
      assert.ok(resultImages.has(title),'Unexpected image title: '+JSON.stringify(title));
      providerCalls.push(title);
      const firstScene = title === '使用场景' && providerCalls.filter(value=>value===title).length === 1;
      // A URL-only provider response cannot be applied to a draft or paid as a successful image.
      const item = firstScene ? {url:'https://image.example.test/preview.png'} :
        {b64_json:resultImages.get(title).toString('base64')};
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({data:[item]}));
    } catch (error) {
      providerErrors.push(error);
      response.writeHead(400);
      response.end();
    }
  });
  server.listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  t.after(()=>db.close());
  await once(server,'listening');
  const providers = installModels(createProviders(),[{
    id:'fixture-images',model:'test-images',protocol:'openai-images',
    baseUrl:'http://127.0.0.1:'+server.address().port+'/v1/',capabilities:['image.main-image'],
  }]);
  const shops = new Map();
  await migrate(db);
  const app = await buildApp({db,providers,shops});
  t.after(()=>app.close());
  const call = (member,method,url,payload) => app.inject({method,url,payload,headers:member?.headers ?? {}});
  async function json(member, method, url, expected, payload) {
    const response = await call(member,method,url,payload);
    assert.equal(response.statusCode,expected,response.body);
    const body = response.json();
    assert.ok(response.headers['x-request-id']);
    if (expected >= 400) assert.equal(response.headers['x-request-id'],body.error.requestId);
    return body;
  }
  async function account(label) {
    const session = await json(null,'POST','/v1/auth/register',201,{
      type:'personal',displayName:label,email:label+'-'+randomUUID()+'@example.test',password:'synthetic-series-test',
    });
    return {accountId:session.account.id,workspaceId:session.workspaces[0].id,headers:{
      authorization:'Bearer '+session.token,'x-workspace-id':session.workspaces[0].id,
    }};
  }
  async function upload(member, bytes) {
    return json(member,'POST','/v1/assets',201,{name:'test.png',mediaType:'image/png',source:'Synthetic',
      purpose:'Test product image',dataBase64:bytes.toString('base64')});
  }

  assertPlanOpenApi((await json(null,'GET','/openapi.json',200)).paths);
  const owner = await account('image-plan-owner');
  const other = await account('image-plan-other');
  const source = await upload(owner,sourceImage);
  const base = root+'/'+randomUUID();
  const planInput = {id:base.split('/').at(-1),productName:'测试保温杯',requirements:'参考图为蓝色，突出便携设计',
    assetIds:[source.id],detailCount:3};
  await json(other,'POST',root,404,planInput);
  const plan = await json(owner,'POST',root,201,planInput);
  assert.equal(plan.state,'draft');
  assert.equal(plan.estimatedCredits,12);
  assert.deepEqual(plan.images.map(image=>image.role),['main','detail','detail','detail']);
  assert.ok(plan.images.every(image=>image.eventCursor==='0' && !image.canRetry && !image.aiGenerated && image.deliveryUrl===null));
  assert.deepEqual(await json(owner,'POST',root,200,planInput),plan);
  await json(other,'GET',base,404);

  const layout = {revision:1,designNotes:'统一使用深蓝底色',images:plan.images.map(({role,title,direction})=>({role,title,direction}))};
  const edited = await json(owner,'PUT',base,200,layout);
  assert.equal(edited.revision,2);
  assert.equal((await json(owner,'GET',base,200)).designNotes,layout.designNotes);
  assert.equal((await json(owner,'GET',root,200)).items[0].revision,2);
  await json(owner,'PUT',base,409,{...layout,designNotes:'过期编辑'});

  const confirm = {revision:2,modelId:'fixture-images'};
  const wallet = () => json(owner,'GET','/v1/credits/wallet',200);
  await provisionCredits(db,owner.workspaceId,owner.accountId,5,'product-plan-initial');
  await json(owner,'POST',base+'/confirm',409,{...confirm,revision:1});
  assert.equal((await json(owner,'POST',base+'/confirm',409,confirm)).error.code,'INSUFFICIENT_CREDITS');
  assert.deepEqual(await wallet(),{balance:5,reserved:0,available:5});
  const taskCount = () => row(db,'SELECT count(*)::int AS count FROM tasks WHERE workspace_id=$1',[owner.workspaceId]);
  assert.equal((await taskCount()).count,0);
  assert.equal((await json(owner,'GET',base,200)).state,'draft');
  await provisionCredits(db,owner.workspaceId,owner.accountId,17,'product-plan-topup');

  const duplicate = await Promise.all([1,2].map(()=>call(owner,'POST',base+'/confirm',confirm)));
  assert.deepEqual(duplicate.map(r=>r.statusCode).sort(),[200,202],duplicate.map(r=>r.body).join('\n'));
  const batch = duplicate[0].json();
  assert.deepEqual(duplicate[1].json(),batch);
  assert.equal(batch.state,'generating');
  assert.equal((await taskCount()).count,4);
  assert.deepEqual(await wallet(),{balance:22,reserved:12,available:10});
  await json(owner,'PUT',base,409,{...layout,revision:2});
  await json(owner,'POST',base+'/images/2/retry',409,{taskId:batch.images[2].taskId});
  const queuedImage = batch.images[2];
  const failedTaskUrl = taskUrl(queuedImage.taskId);
  const memberSdk = workspaceV1((method,url,payload)=>json(owner,method,url,200,payload));
  const queuedTask = await json(owner,'GET',failedTaskUrl,200);
  assert.deepEqual(queuedTask.imagePlan,{planId:plan.id,position:2,attempt:1,latest:true,canRetry:false,retryUrl:null,
    assetId:null,aiGenerated:false,deliveryUrl:null});
  assert.equal(queuedTask.eventCursor,queuedImage.eventCursor);
  const queuedEvents = await memberSdk.events(queuedTask.id,{after:'0'});
  assert.deepEqual(queuedEvents.items.map(event=>event.event),['queued']);
  assert.equal(queuedEvents.nextCursor,queuedTask.eventCursor);
  await json(other,'GET',failedTaskUrl+'/events?after=0',404);
  await json(owner,'GET',failedTaskUrl+'/events?after=9223372036854775808',400);
  await json(owner,'GET',failedTaskUrl+'/events?after=0&offset=1',400);
  for (let index=0; index<4; index++) assert.equal(await workOnce({db,providers,shops}),true);

  const partial = await json(owner,'GET',base,200);
  assert.deepEqual(providerErrors,[], 'Loopback model received invalid requests');
  assert.equal(partial.state,'partial',JSON.stringify({
    calls:providerCalls,
    results:partial.images.map(({title,state,errorCode})=>({title,state,errorCode})),
  }));
  assert.deepEqual(partial.images.map(image=>image.state),['succeeded','succeeded','failed','succeeded']);
  assert.equal(partial.images[2].errorCode,'INVALID_PROVIDER_IMAGE');
  const failedTask = await json(owner,'GET',failedTaskUrl,200);
  assert.equal(failedTask.imagePlan.canRetry,true);
  assert.equal(failedTask.imagePlan.retryUrl,partial.images[2].retryUrl);
  assert.equal(failedTask.eventCursor,partial.images[2].eventCursor);
  const taskList = await json(owner,'GET','/v1/tasks?state=failed',200);
  assert.deepEqual(taskList.items[0].imagePlan,failedTask.imagePlan);
  const runningEvents = await memberSdk.events(queuedTask.id,{after:queuedEvents.nextCursor,limit:1});
  assert.deepEqual(runningEvents.items.map(event=>event.event),['running']);
  const failedEvents = await memberSdk.events(queuedTask.id,{after:runningEvents.nextCursor,limit:1});
  assert.deepEqual(failedEvents.items.map(({taskId,event,errorCode,attempt,retryable})=>({taskId,event,errorCode,attempt,retryable})),[
    {taskId:queuedTask.id,event:'failed',errorCode:'INVALID_PROVIDER_IMAGE',attempt:1,retryable:true},
  ]);
  assert.equal(failedEvents.nextCursor,failedTask.eventCursor);
  assert.deepEqual(await memberSdk.events(queuedTask.id,{after:failedEvents.nextCursor}),{items:[],nextCursor:failedEvents.nextCursor});
  assert.deepEqual((await memberSdk.events(queuedTask.id)).items.map(event=>event.event),['failed','running','queued']);
  assert.deepEqual(await wallet(),{balance:13,reserved:0,available:13});

  const draftUrl = '/v1/studio/pinduoduo-drafts/'+randomUUID();
  const draft = await json(owner,'PUT',draftUrl,200,{revision:0,title:'测试保温杯',sku:'QA-BLUE',stock:12,
    variants:[{specification:'大号',sku:'QA-BLUE-L',stock:3,assetId:source.id}],
    images:[{role:'main',assetId:source.id},{role:'sku',assetId:source.id}]});
  const fill = {draftId:draft.id,draftRevision:1,detailPositions:[1,2,3]};
  await json(owner,'POST',base+'/apply-to-draft',409,fill);
  assert.deepEqual(await json(owner,'GET',draftUrl,200),draft);
  await json(owner,'POST',taskUrl(partial.images[0].taskId)+'/regenerate',409,{idempotencyKey:randomUUID()});
  const retryUrl = partial.images[2].retryUrl;
  const retryData = {taskId:partial.images[2].taskId};
  await json(owner,'POST',retryUrl,404,{taskId:partial.images[1].taskId});
  const genericRetryUrl = failedTaskUrl+'/regenerate';
  const genericRetryData = {idempotencyKey:randomUUID()};
  await json(other,'POST',genericRetryUrl,404,genericRetryData);
  const retries = await Promise.all([
    call(owner,'POST',retryUrl,retryData),
    call(owner,'POST',genericRetryUrl,genericRetryData),
    call(owner,'POST',retryUrl,retryData),
  ]);
  assert.deepEqual(retries.map(r=>r.statusCode).sort(),[200,200,202],retries.map(r=>r.body).join('\n'));
  const retried = retries[0].json();
  const retriedTask = retries[1].json();
  assert.deepEqual(retries[2].json(),retried);
  assert.equal(retriedTask.id,retried.taskId);
  assert.equal(retriedTask.parentId,retryData.taskId);
  assert.equal(retriedTask.imagePlan.attempt,2);
  assert.equal(retriedTask.imagePlan.latest,true);
  assert.equal((await json(owner,'GET',failedTaskUrl,200)).imagePlan.latest,false);
  assert.equal((await memberSdk.events(queuedTask.id,{after:runningEvents.nextCursor})).items[0].retryable,false);
  assert.equal(retried.attempt,2);
  assert.notEqual(retried.taskId,retryData.taskId);
  assert.equal(await workOnce({db,providers,shops}),true);
  assert.equal(await workOnce({db,providers,shops}),false);
  const final = await json(owner,'GET',base,200);
  assert.equal(final.state,'succeeded');
  assert.equal(final.images[2].taskId,retried.taskId);
  assert.equal(final.images[0].taskId,batch.images[0].taskId);
  assert.equal((await taskCount()).count,5);
  assert.deepEqual(await wallet(),{balance:10,reserved:0,available:10});
  assert.equal(providerCalls.length,5);
  assert.equal(providerCalls.filter(title=>title==='使用场景').length,2);
  assert.deepEqual(providerErrors,[]);

  const applied = await json(owner,'POST',base+'/apply-to-draft',200,fill);
  assert.equal(applied.revision,2);
  assert.equal(applied.title,draft.title);
  assert.equal(applied.stock,draft.stock);
  assert.equal(applied.sku,draft.sku);
  assert.deepEqual(applied.variants,draft.variants);
  const [main,...details] = final.images;
  assert.deepEqual(applied.images,[
    {role:'main',assetId:main.assetId},{role:'sku',assetId:source.id},...details.map(({assetId})=>({role:'detail',assetId})),
  ]);
  for (const image of final.images) {
    const saved = await call(owner,'GET','/v1/assets/'+image.assetId+'/content');
    assert.equal(saved.statusCode,200);
    assert.deepEqual(saved.rawPayload,resultImages.get(image.title));
    assert.equal((await loadImage(saved.rawPayload)).width,32);
    const task = await json(owner,'GET',taskUrl(image.taskId),200);
    assert.equal(task.imagePlan.assetId,image.assetId);
    assert.equal(task.imagePlan.deliveryUrl,image.deliveryUrl);
    assert.equal(task.imagePlan.aiGenerated,true);
    assert.equal(image.aiGenerated,true);
  }
  const marked = await call(owner,'GET',main.deliveryUrl);
  assert.equal(marked.statusCode,200,marked.statusCode===200?'':marked.body);
  assert.equal(marked.headers['content-type'],'image/png');
  assert.match(marked.headers['content-disposition'],/^attachment; filename="delivery-/);
  assert.ok(marked.rawPayload.includes('AI-generated content'));
  const pixels = createCanvas(32,32).getContext('2d');
  pixels.drawImage(await loadImage(marked.rawPayload),0,0);
  assert.deepEqual([...pixels.getImageData(3,20,1,1).data],[17,24,39,255]);
  await json(other,'GET',main.deliveryUrl,404);
  await json(owner,'GET','/v1/assets/'+source.id+'/delivery',422);
  await db.query('UPDATE assets SET rights_restricted=true WHERE id=$1',[main.assetId]);
  const restricted = (await json(owner,'GET',base,200)).images[0];
  assert.equal(restricted.state,'unavailable');
  assert.equal(restricted.deliveryUrl,null);
  assert.equal((await json(owner,'GET',taskUrl(main.taskId),200)).imagePlan.deliveryUrl,null);
  await json(owner,'GET',main.deliveryUrl,404);
  await db.query('UPDATE assets SET rights_restricted=false WHERE id=$1',[main.assetId]);
  assert.deepEqual(await json(owner,'POST',base+'/apply-to-draft',200,fill),applied);
  await json(owner,'POST',base+'/apply-to-draft',409,{...fill,detailPositions:[3,2,1]});
  await json(other,'POST',base+'/apply-to-draft',404,fill);
});
