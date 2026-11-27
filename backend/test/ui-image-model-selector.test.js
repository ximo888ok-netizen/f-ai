import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { GeneratedFile } from '../src/model-file.js';
import { createStudioFixture } from '../test-support/ui-actions.js';
import { waitForModelTask } from '../../前端设计审查/live-agent-model.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const png = createCanvas(64, 64).toBuffer('image/png');
const product = { name: '商品.png', mimeType: 'image/png', buffer: png };
const submit = { method: 'POST', path: '/v1/tasks', status: 202 };

async function checkGeneratedAsset(t, read, task) {
  const completed = await waitForModelTask({signal: t.signal, api: read}, task, 60000);
  assert.equal(completed.state, 'succeeded', completed.errorCode);
  assert.equal((await read('/v1/assets/' + completed.result.assetId)).mediaType, 'image/png');
}

function configureModels(providers) {
  for (const id of ['image-one', 'image-two']) {
    providers.set('model:' + id, {
      info: { id, model: 'Image ' + id, kind: 'image', protocol: 'openai-images', capabilities: ['image.main-image'], streamText: false },
      supports: capability => capability.id === 'image.main-image',
      run: async () => new GeneratedFile(png, 'image/png'),
    });
  }
  providers.set('model:planner', {
    info: { id: 'planner', model: 'Planner', kind: 'text', protocol: 'chat-completions', capabilities: ['model.chat'], streamText: false },
    supports: capability => capability.id === 'model.chat',
    run: async () => ({ type: 'text', text: JSON.stringify({ images: [{ title: '正面', direction: '干净背景与柔和侧光' }] }) }),
  });
}

test('all three image modes share the choice beside the wallet and execute the chosen model', options, async t => {
  const { page, open, api, read, act } = await createStudioFixture(t, { configureProviders: configureModels });
  page.setDefaultTimeout(30000);
  const form = page.locator('.quick-image-form');
  const model = form.getByRole('combobox', { name: '生图模型', exact: true });
  const generate = form.locator('button[type=submit]');
  const upload = () => form.locator('[data-quick-upload=products] input').setInputFiles(product);
  const checkPosition = async () => {
    const wallet = await form.locator('[data-quick-wallet]').boundingBox();
    const control = await model.boundingBox();
    assert.ok(wallet && control && control.x >= wallet.x + wallet.width - 1 &&
      control.y < wallet.y + wallet.height && wallet.y < control.y + control.height, 'wallet and selector share a row');
  };
  const checkImageTask = async (name, modelId) => {
    const response = await act(name, generate, submit);
    assert.equal(response.request().postDataJSON().modelId, modelId);
    const task = await response.json();
    assert.equal(task.modelId, modelId);
    await checkGeneratedAsset(t, read, task);
  };
  await open('desk/image', '[data-image-mode=quick]');
  await checkPosition();
  assert.deepEqual(await model.locator('option').evaluateAll(items => items.map(item => item.value)), ['image-one', 'image-two']);
  await model.selectOption('image-two');
  await upload();
  await checkImageTask('快速模式用所选模型出图', 'image-two');

  await open('desk/image/advanced', '[data-image-mode=advanced]');
  assert.equal(await model.inputValue(), 'image-two');
  await page.setViewportSize({ width: 390, height: 844 });
  await checkPosition();
  await form.locator('[name=prompt]').fill('影棚内拍摄商品正面');
  await checkImageTask('高级模式用所选模型出图', 'image-two');

  await open('desk/image/agent', '[data-image-mode=agent]');
  await checkPosition();
  assert.equal(await model.inputValue(), 'image-two');
  await upload();
  const plan = await act('Agent 按选定生图模型策划', generate, submit);
  assert.equal((await plan.json()).modelId, 'planner');
  assert.match(plan.request().postDataJSON().parameters.messages.at(-1).content, /image-two/);
  await form.getByRole('button', {name: '确认方案并生成'}).waitFor();
  await model.selectOption('image-one');
  await form.getByRole('button', {name: '开始逐张策划'}).waitFor();
  const newPlan = await act('Agent 重新策划', generate, submit);
  assert.match(newPlan.request().postDataJSON().parameters.messages.at(-1).content, /image-one/);
  await form.getByRole('button', {name: '确认方案并生成'}).waitFor();
  await checkImageTask('Agent 确认后用所选模型出图', 'image-one');

  const disconnect = id => api('PUT', '/v1/merchant/connections/model/' + id, { revision: 0, enabled: false });
  await disconnect('image-one');
  await open('desk/image/advanced', '[data-image-mode=advanced]');
  assert.equal(await model.inputValue(), 'image-two');
  assert.equal(await model.locator('option').count(), 1);
  await disconnect('image-two');
  await open('desk/image', '[data-image-mode=quick]');
  await upload();
  assert.equal(await model.isDisabled(), true);
  assert.equal(await model.inputValue(), '');
  assert.equal(await generate.isDisabled(), true);
});

test('an image workspace with only a configured gateway can generate without a named alias', options, async t => {
  const { page, open, read, act } = await createStudioFixture(t, { configureProviders(providers) {
    providers.set('gateway', {
      supports: capability => capability.id === 'image.main-image',
      run: async () => new GeneratedFile(png, 'image/png'),
    });
  } });
  page.setDefaultTimeout(30000);
  await page.setViewportSize({width: 900, height: 720});
  const form = page.locator('[data-image-mode=advanced]');
  await open('desk/image/advanced', form);
  const model = form.getByRole('combobox', { name: '生图模型', exact: true });
  assert.equal(await model.count(), 1, 'gateway routing is visible beside the balance');
  assert.equal(await model.isDisabled(), true);
  assert.match(await model.locator('option:checked').textContent(), /工作区网关/);
  await form.locator('[name=prompt]').fill('白底商品图');
  const generate = form.locator('button[type=submit]');
  assert.equal(await generate.isEnabled(), true);
  const response = await act('工作区网关出图', generate, submit);
  assert.equal(Object.hasOwn(response.request().postDataJSON(), 'modelId'), false);
  await checkGeneratedAsset(t, read, await response.json());
});
