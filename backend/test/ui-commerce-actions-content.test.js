import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const rules = '/v1/copywriting/rules/taobao';

test('content supplier returns a structured content pack, exports edited proof and hands it to platform review', options, async t => {
  const submittedPlatforms = [];
  const specimen = {
    optimized_title: '合成蓝色陶杯',
    selling_points: ['蓝色釉面', '适合日常使用'],
    description: '由合成测试适配器生成的商品描述',
    social_copy: '合成测试社交文案',
    seo_keywords: ['陶杯', '蓝色'],
    quality_score: 90,
  };
  const fixture = await createStudioFixture(t, {
    integrations: { content: { shops: new Map(), model: {
      name: 'Synthetic content fixture', key: 'synthetic-content-key', baseUrl: 'https://example.test/',
    } } },
    integrationRunner: async (_configuration, engine, action, input) => {
      assert.equal(engine, 'content');
      if (action === 'probe') return {};
      assert.equal(action, 'generate');
      const { parameters } = input;
      assert.equal(parameters.title, '台账合成陶杯');
      assert.equal(parameters.category, '合成杯具');
      assert.match(parameters.facts, /蓝色釉面/);
      submittedPlatforms.push(parameters.platform);
      return { ...specimen, platform: parameters.platform };
    },
  });
  const { page, open, act, api, read } = fixture;
  const link = name => page.getByRole('link', { name, exact: true });
  const button = name => page.getByRole('button', { name, exact: true });
  const engine = '[data-engine=ecommerce-content-agent]';
  const editor = page.locator('[data-form=content-package]');
  const product = editor.locator('[name=product]');
  const output = page.locator(engine + ' [data-generation-result]');

  await open('copy-review', link('管理商品档案'));
  await act('内容包无档案时进入商品管理', link('管理商品档案'), { method: 'GET', path: '/v1/studio/products' });
  const category = await api('POST', '/v1/studio/categories', { name: '合成杯具' });
  const seeded = await api('POST', '/v1/studio/products', {
    sku: 'SYN-CONTENT-PRODUCT', name: '台账合成陶杯', categoryId: category.id, description: '自有合成档案，蓝色釉面',
  });
  await api('PUT', rules, { revision: 0, titleLimit: 80, sellingPointLimit: 160, forbiddenPhrases: [] });

  await open('copy-review', product);
  await product.selectOption(seeded.id);
  assert.equal(await editor.locator('[name=title]').inputValue(), seeded.name);
  assert.equal(await editor.locator('[name=category]').inputValue(), category.name);
  assert.equal(await editor.locator('[name=facts]').inputValue(), seeded.description);
  await act('展开商品文案受众选项', editor.getByText('卖点与目标受众', { exact: true }));
  await editor.locator('[name=sellingPoints]').fill('材质为陶瓷');
  await editor.locator('[name=audience]').fill('合成验收买家');
  const submitted = await act('从内容专页生成文案', button('生成商品文案'), { method: 'POST', path: '/v1/tasks', status: 202 });
  const task = await submitted.json();
  assert.equal(submitted.request().postDataJSON().parameters.audience, '合成验收买家');
  assert.deepEqual(submitted.request().postDataJSON().parameters.sellingPoints, ['材质为陶瓷']);
  await output.locator('[name=proof0]').waitFor();
  assert.equal(await output.locator('[name=proof0]').inputValue(), specimen.optimized_title);
  assert.equal(await output.locator('[name=proof4]').inputValue(), '陶杯、蓝色');
  assert.equal(await output.getByRole('link', { name: '任务原稿', exact: true }).getAttribute('href'), '#tasks/' + task.id);

  const updatedTitle = '人工核对的蓝色陶杯';
  await output.locator('[name=proof0]').fill(updatedTitle);
  await output.locator('[name=proof1]').fill('人工补录的陶瓷材质');
  const [downloaded] = await Promise.all([
    page.waitForEvent('download'), act('导出人工编辑的成稿', button('导出当前成稿')),
  ]);
  const exported = await readFile(await downloaded.path(), 'utf8');
  assert.match(exported, /人工核对的蓝色陶杯/);
  assert.match(exported, /人工补录的陶瓷材质/);
  await act('将编辑后的标题和卖点带到淘宝规则校验', button('带入平台校验'), { method: 'GET', path: '/v1/tasks/' + task.id });
  await page.waitForFunction(title => document.querySelector('[data-form=copy-review] [name=title]')?.value === title, updatedTitle);
  const reviewed = await act('校验转交后的成稿', button('校验文案'), { method: 'POST', path: '/v1/copywriting/review' });
  assert.equal(reviewed.request().postDataJSON().title, updatedTitle);
  assert.deepEqual(reviewed.request().postDataJSON().sellingPoints, ['人工补录的陶瓷材质']);
  assert.equal((await reviewed.json()).passed, true);
  const original = await read('/v1/tasks/' + task.id);
  assert.equal(original.state, 'succeeded');
  assert.equal(original.result.title, specimen.optimized_title);

  await act('返回内容制作', '#scene-copywriting-write-tab');
  await product.selectOption(seeded.id);
  await act('选择小红书目标平台', editor.getByText('小红书', { exact: true }));
  const social = await (await act('生成小红书内容包', button('生成商品文案'), { method: 'POST', path: '/v1/tasks', status: 202 })).json();
  await output.locator('[name=proof0]').waitFor();
  assert.equal(await button('带入平台校验').count(), 0);
  await act('打开成稿对应的原任务', output.getByRole('link', { name: '任务原稿', exact: true }),
    { method: 'GET', path: '/v1/tasks/' + social.id });
  assert.deepEqual(submittedPlatforms, ['taobao', 'xiaohongshu']);
});
