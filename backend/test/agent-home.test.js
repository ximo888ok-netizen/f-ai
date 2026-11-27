import test from 'node:test';
import assert from 'node:assert/strict';
import { respond } from '../../前端设计审查/live-agent-dialogue.js';
import { interpret, referencedChat } from '../../前端设计审查/live-agent-model.js';

test('draft conversations reuse the selected product and keep a stable write ID across retries', async () => {
  const writes = [], thread = { messages: [] };
  const ctx = {
    all: async url => url === '/v1/assets' ? [{ id:'image-one', name:'托特包.jpg', mediaType:'image/jpeg' }] :
      [{ id:'product-one', name:'米白托特包', sku:'TOTE', description:'通勤款' }],
    api: async (url, { method, body }) => {
      assert.equal(method, 'PUT'); writes.push([url, body]);
      if (writes.length === 1) throw new Error('服务暂不可用');
      return { id:'saved', title:body.title };
    },
  };
  assert.equal((await respond(ctx, thread, '查商品：托特包')).items.length, 1);
  await respond(ctx, thread, '把第一个商品建成草稿');
  await respond(ctx, thread, '选第一张');
  await respond(ctx, thread, '标题改为春季上新');
  assert.equal(writes.length, 0);
  await assert.rejects(respond(ctx, thread, '保存草稿'));
  const saved = await respond(ctx, thread, '保存草稿');
  assert.deepEqual(writes[0], writes[1]);
  assert.deepEqual(writes[1][1], { title:'春季上新', sku:'TOTE', description:'通勤款', revision:0, images:[{ role:'main', assetId:'image-one' }] });
  assert.equal(saved.items[0].route, 'drafts/saved');
  assert.equal(thread.draft, null);
});

test('cancel and failed image rendering do not report an output or lose the editable request', async () => {
  const thread = { messages:[], attachment:{ id:'image-one', name:'主图.jpg' } };
  const ctx = { api:async () => ({ items:[{state:'failed'}] }) };
  await respond(ctx, thread, '裁切图片 640×640');
  assert.equal(thread.cover.width, 640);
  await assert.rejects(respond(ctx, thread, '开始出图'), /未成功/);
  assert.equal(thread.cover.image.id, 'image-one');
  await respond(ctx, thread, '取消');
  assert.equal(thread.cover, null);
});

test('the model can propose a known operation but cannot introduce an endpoint', async () => {
  const ctx = { api:async () => ({id:'model-task',state:'succeeded',result:{text:'{"action":"fetch","value":"/v1/settings"}'}}) };
  await assert.rejects(interpret(ctx, [{role:'user',text:'请帮忙'}], () => {}), /支持范围/);
  ctx.api = async (url, options) => {
    assert.equal(url, '/v1/tasks');
    assert.equal(options.body.modelId, 'selected-model');
    return {id:'model-task',state:'succeeded',result:{text:'{"action":"products","value":"夏季"}'}};
  };
  assert.deepEqual(await interpret(ctx, [{role:'user',text:'瞧瞧夏季的货品'}], () => {}, 'selected-model'), {action:'products',value:'夏季'});
});

test('gateway enhancement sends a real chat task without a named provider override', async () => {
  const ctx = {api:async (url,{body}) => {
    assert.equal(url,'/v1/tasks');
    assert.equal(Object.hasOwn(body,'modelId'),false);
    assert.equal(body.parameters.messages.at(-1).content,'写主图说明');
    return {id:'gateway-task',state:'succeeded',result:{text:'写一段突出材质的主图说明。'}};
  }};
  assert.equal(await referencedChat(ctx, {}, null, {draft:'写主图说明'}),'写一段突出材质的主图说明。');
});
