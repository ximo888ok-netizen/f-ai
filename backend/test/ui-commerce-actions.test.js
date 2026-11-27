import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { createStudioFixture } from '../test-support/ui-actions.js';
import { operationForms } from '../src/operation-forms.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const studio = '/v1/studio';
const desk = '/v1/desk-shops';
const baseBooks = studio + '/pinduoduo/books';
const assets = '/v1/assets';
const products = studio + '/products';
const categories = studio + '/categories';
const idRoute = prefix => new RegExp('^' + prefix + '/[0-9a-f-]+$');

function controls(fixture) {
  const { page, act } = fixture;
  const form = name => page.locator('[data-form="' + name + '"]');
  const link = name => page.getByRole('link', { name, exact: true });
  const button = name => page.getByRole('button', { name, exact: true });
  const visible = text => page.getByText(text, { exact: true }).first().waitFor();
  const submit = async (name, values, request) => {
    const editor = form(name);
    for (const [key, value] of Object.entries(values)) {
      const field = editor.locator('[name="' + key + '"]');
      const control = await field.evaluate(node => ({ tag: node.tagName, type: node.type }));
      if (control.type === 'file') await field.setInputFiles(value);
      else if (control.tag === 'SELECT') await field.selectOption(value);
      else if (control.type === 'checkbox') await field.setChecked(value);
      else await field.fill(String(value));
    }
    return act(name, editor.locator('button[type=submit], button:not([type])').last(), request);
  };
  const confirmed = (label, locator, request) => {
    page.once('dialog', dialog => dialog.accept());
    return act(label, locator, request);
  };
  const download = async (label, locator, request) => {
    const [file] = await Promise.all([page.waitForEvent('download'), act(label, locator, request)]);
    return readFile(await file.path());
  };
  return { form, link, button, visible, submit, confirmed, download };
}

const file = (filename, value) => ({
  name: filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
});
const png = () => {
  const canvas = createCanvas(32, 32);
  const context = canvas.getContext('2d');
  context.fillStyle = '#a14c72';
  context.fillRect(0, 0, 32, 32);
  return { name: 'fixture-product.png', mimeType: 'image/png', buffer: canvas.toBuffer('image/png') };
};

test('product categories, catalog transfers, ROI and asset controls persist and retrieve real workspace data', options, async t => {
  const fixture = await createStudioFixture(t);
  const { page, open, act, read } = fixture;
  const { form, link, button, visible, submit, confirmed, download } = controls(fixture);
  const sku = 'CAT-' + randomUUID().slice(0, 8);
  await open('products', form('new-product'));
  await act('商品分类入口', link('分类管理'), { method: 'GET', path: categories });
  const category = await (await submit('new-category', { name: '陶杯验收类目' },
    { method: 'POST', path: categories, status: 201 })).json();
  await visible('陶杯验收类目');
  const row = page.locator('.live-item').filter({ hasText: '陶杯验收类目' });
  await act('展开分类编辑', row.getByText('编辑分类', { exact: true }));
  await submit('rename-' + category.id, { name: '验收类目已更新' },
    { method: 'PATCH', path: categories + '/' + category.id });
  await visible('验收类目已更新');
  await act('回到商品清单', link('商品清单'), { method: 'GET', path: products });

  const product = await (await submit('new-product', { sku, name: '验收陶瓷杯', description: '自造资料', categoryId: category.id },
    { method: 'POST', path: products, status: 201 })).json();
  await form('edit-product').waitFor();
  assert.equal(product.categoryId, category.id);
  await submit('edit-product', { name: '验收陶瓷杯更新' }, { method: 'PUT', path: products + '/' + product.id });
  await page.getByRole('heading', { name: '验收陶瓷杯更新', exact: true }).waitFor();
  const copy = await (await submit('duplicate-product', { sku: sku + '-COPY' },
    { method: 'POST', path: products, status: 201 })).json();
  assert.equal(copy.name, '验收陶瓷杯更新');
  assert.equal(copy.categoryId, category.id);
  await confirmed('删除商品副本', button('删除商品档案'), { method: 'DELETE', path: products + '/' + copy.id, status: 204 });
  await visible('验收陶瓷杯更新');
  assert.ok(!(await read(products)).items.some(({ id }) => id === copy.id));

  await act('打开商品传输记录', link('导入与导出'), { method: 'GET', path: studio + '/transfers' });
  await submit('import', { file: file('catalog.json', { items: [{ sku: sku + '-IMPORT', name: '导入商品' }] }) },
    { method: 'POST', path: products + '/import', status: 201 });
  await visible('导入 1 项');
  await form('export').locator('[name=ids]').selectOption(product.id);
  const exported = await download('生成并下载商品包', button('生成并下载'), { method: 'POST', path: products + '/export' });
  assert.equal(JSON.parse(exported).items[0].sku, sku);
  await visible('导出 1 项');
  await act('清单入口', link('商品清单'), { method: 'GET', path: products });
  const selected = page.locator('.live-item').filter({ hasText: '验收陶瓷杯更新' });
  await act('打开商品详情', selected.getByRole('link', { name: '详情', exact: true }), { method: 'GET', path: products });
  await submit('edit-product', { categoryId: '' }, { method: 'PUT', path: products + '/' + product.id });
  await act('返回类目清单', link('分类管理'), { method: 'GET', path: categories });
  await act('打开移除分类控件', page.getByText('编辑分类', { exact: true }));
  await confirmed('移除未使用分类', button('删除分类'), { method: 'DELETE', path: categories + '/' + category.id, status: 204 });
  assert.ok(!(await read(categories)).items.some(({ id }) => id === category.id));

  await open('roi', form('roi'));
  const roi = await (await submit('roi', { priceMinor: 2500, unitCostMinor: 1000, units: 2, feesMinor: 100, adSpendMinor: 500 },
    { method: 'POST', path: studio + '/roi' })).json();
  assert.equal(roi.contributionMinor, 2400);
  assert.equal(JSON.parse(await download('下载本次 ROI', button('导出本次测算'))).result.contributionMinor, 2400);

  await open('assets', form('upload'));
  const image = png();
  const uploaded = await (await submit('upload', { file: image, source: '浏览器合成图片', purpose: '验证素材功能' },
    { method: 'POST', path: assets, status: 201 })).json();
  await visible(image.name);
  const assetRow = page.locator('.live-item').filter({ hasText: image.name });
  assert.deepEqual(await download('素材列表下载', assetRow.getByRole('button', { name: '下载', exact: true }),
    { method: 'GET', path: assets + '/' + uploaded.id + '/content' }), image.buffer);
  await act('打开素材文件详情', assetRow.getByRole('link', { name: '文件详情', exact: true }),
    { method: 'GET', path: assets + '/' + uploaded.id });
  await act('核对文件摘要', button('校验原文件'), { method: 'GET', path: assets + '/' + uploaded.id + '/content' });
  await visible('校验通过，文件内容与登记摘要一致。');
  assert.deepEqual(await download('详情下载原件', button('下载原文件'),
    { method: 'GET', path: assets + '/' + uploaded.id + '/content' }), image.buffer);
  await submit('source-review', { personCount: 0, occlusionPercent: 0 },
    { method: 'PUT', path: /\/v1\/media\/images\/.*\/preflight/ });
  await act('返回素材库', link('返回素材库'), { method: 'GET', path: assets });
  await confirmed('删除素材文件', button('删除'), { method: 'DELETE', path: assets + '/' + uploaded.id, status: 204 });
  assert.ok(!(await read(assets)).items.some(({ id }) => id === uploaded.id));
});

function ledgerSample(kind) {
  return {
    orders: { title: '订单商品', day: '2026-11-12', status: '待发货', units: 2, paidMinor: '12.50', shipBy: '2026-11-13' },
    shipments: { title: '测试包裹', orderRef: 'orders-main', status: '待配货' },
    returns: { title: '测试售后', orderRef: 'orders-main', kind: '换货', status: '待处理' },
    tickets: { title: '咨询工单', orderRef: 'orders-main', status: '待处理', due: '2026-11-13' },
    reviews: { title: '测试评价', day: '2026-11-12', content: '合成评价', status: '待拟回复' },
    inventory: { title: '测试库存', day: '2026-11-12', stock: 5, threshold: 6 },
    performance: { title: '测试商品数据', sku: 'BROWSER-SKU', day: '2026-11-12', views: 10, visitors: 5, buyers: 2, salesMinor: '12.50' },
    traffic: { day: '2026-11-12', channel: '搜索', views: 8 },
    campaigns: { title: '测试营销计划', start: '2026-11-12', end: '2026-11-16', status: '筹备中' },
    attributes: { title: '测试属性', category: '餐具', properties: '容量' },
    qualifications: { title: '测试资质', productRef: 'BROWSER-SKU', status: '待收集' },
    shippingTemplates: { title: '测试运费', regions: '浙江', firstFeeMinor: 4, nextFeeMinor: 1 },
    returnRules: { title: '测试退货规则', scope: '自营陶杯', instructions: '验收测试' },
  }[kind];
}

test('shop directory, all ledger modules, report filters, imports and downloads use the real server', options, async t => {
  const fixture = await createStudioFixture(t);
  const { page, open, act, read } = fixture;
  const { form, link, button, visible, submit, download } = controls(fixture);
  await open('commerce', page.locator('#scene-operations-shops-tab'));
  await act('经营页切换到店铺管理', page.locator('#scene-operations-shops-tab'));
  const shop = await (await submit('shop-add', { platform: 'pinduoduo', name: '台账验收店铺' },
    { method: 'POST', path: desk, status: 201 })).json();
  await visible('台账验收店铺');
  const login = page.getByRole('link', { name: '登录商家后台', exact: true }).first();
  assert.equal(new URL(await login.getAttribute('href')).hostname, 'mms.pinduoduo.com');
  await act('显示店铺编辑表单', page.getByText('管理店铺', { exact: true }));
  await submit('shop-edit-' + shop.id, { name: '验收店铺停用', enabled: 'no' }, { method: 'PATCH', path: desk + '/' + shop.id });
  await visible('验收店铺停用');
  assert.equal((await read(desk)).items.find(item => item.id === shop.id).enabled, false);
  await act('重新打开店铺编辑', page.getByText('管理店铺', { exact: true }));
  await submit('shop-edit-' + shop.id, { enabled: 'yes' }, { method: 'PATCH', path: desk + '/' + shop.id });
  assert.equal((await read(desk)).items.find(item => item.id === shop.id).enabled, true);
  await act('经营页切换到运营台账', page.locator('#scene-operations-books-tab'));
  const book = await (await submit('book', { name: '浏览器实测台账' }, { method: 'POST', path: baseBooks, status: 200 })).json();
  const bookPath = baseBooks + '/' + book.id;
  const bookRoute = 'commerce/' + book.id;
  await page.getByRole('heading', { name: book.name, exact: true }).waitFor();

  for (const [kind, model] of Object.entries(operationForms)) {
    const recordPath = bookPath + '/records/' + kind;
    const reference = kind + '-main';
    const details = ledgerSample(kind);
    await act('打开' + model.label, link('查看' + model.label), { method: 'GET', path: recordPath });
    await act('新增' + model.label, link('新增记录'));
    await submit('operation-edit', { reference, ...details }, { method: 'PUT', path: recordPath });
    await page.locator('.live-item').filter({ hasText: reference }).getByRole('link', { name: '编辑', exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.live-item').filter({ hasText: reference }).first().innerText(), /undefined/);
    await act('编辑' + model.label, link('编辑'), { method: 'GET', path: recordPath + '/lookup' });
    const editable = kind === 'traffic' ? 'views' : 'title';
    const changed = kind === 'traffic' ? 9 : model.label + '已更新';
    await submit('operation-edit', { [editable]: changed }, { method: 'PUT', path: recordPath });
    const committed = (await read(recordPath + '/lookup?reference=' + reference));
    assert.equal(committed.details[editable], changed);
    assert.equal(committed.revision, 2);
    const filter = kind === 'traffic' ? { from: '2026-11-12', to: '2026-11-12' } : { q: reference };
    const query = await submit('filter-records', filter, { method: 'GET', path: recordPath });
    for (const [key, value] of Object.entries(filter)) assert.equal(new URL(query.url()).searchParams.get(key), value);
    const exported = JSON.parse(await download('导出' + model.label, button('导出本页 JSON')));
    assert.equal(exported.items[0].reference, reference);
    const csv = await download('模板 ' + model.label, button('下载 CSV 表头'));
    assert.match(csv.toString(), new RegExp(model.keyLabel));
    const copy = { reference: reference + '-import', details: { ...committed.details } };
    if (kind === 'traffic') copy.details.channel = '推荐';
    const imported = await (await submit('operation-import', { file: file(kind + '.json', { kind, items: [copy] }) },
      { method: 'POST', path: recordPath + '/import' })).json();
    assert.equal(imported.inserted, 1);
    assert.equal((await read(recordPath + '/lookup?reference=' + copy.reference)).reference, copy.reference);
    if (details.orderRef) {
      const related = await act('查询关联订单 ' + model.label, link('查询关联订单').first(), { method: 'GET', path: bookPath + '/records/orders' });
      assert.equal(new URL(related.url()).searchParams.get('q'), 'orders-main');
    }
    await act('从' + model.label + '返回运营总览', link('返回运营总览'), { method: 'GET', path: bookPath + '/summary' });
    await page.getByRole('heading', { name: book.name, exact: true }).waitFor();
  }

  await act('查看订单经营日报', link('查看订单经营日报'), { method: 'GET', path: bookPath + '/analytics' });
  await submit('filter-records', { from: '2026-11-12', to: '2026-11-12' }, { method: 'GET', path: bookPath + '/analytics' });
  await act('打开日周月报表', link('日周月报表与导出'), { method: 'GET', path: bookPath + '/report' });
  for (const period of ['day', 'week', 'month']) {
    const report = await submit('report-range', { from: '2026-11-12', to: '2026-11-12', period }, { method: 'GET', path: bookPath + '/report' });
    assert.equal(new URL(report.url()).searchParams.get('period'), period);
    const data = await report.json();
    assert.equal(data.items[0].paidMinor, '2500');
    assert.equal(data.items[0].traffic['搜索'], '9');
  }
  const csv = await download('导出经营统计 CSV', button('导出当前报表 CSV'), { method: 'GET', path: bookPath + '/report/export' });
  assert.match(csv.toString(), /2500/);
  await act('从报表返回总览', link('返回运营总览'), { method: 'GET', path: bookPath + '/summary' });
  assert.match(await page.evaluate(() => location.hash), new RegExp(bookRoute.replace('commerce/', '')));
});

const drafts = studio + '/pinduoduo-drafts';

test('draft upload, image preview, variants, quality checks and confirmed inventory import preserve selected data', options, async t => {
  const fixture = await createStudioFixture(t);
  const { page, open, act, api, read } = fixture;
  const { form, link, button, visible, submit } = controls(fixture);
  const book = await api('POST', baseBooks, { name: '草稿入账合成台账' });
  await open('drafts', link('新建商品草稿'));
  await act('新建草稿', link('新建商品草稿'), { method: 'GET', path: assets });
  const source = await (await submit('draft-upload', { file: png(), source: '自制合成主图' },
    { method: 'POST', path: assets, status: 201 })).json();
  await page.getByRole('img', { name: '所选商品主图', exact: true }).waitFor();
  assert.equal(await form('save-draft').locator('[name=image-main]').inputValue(), source.id);
  await act('添加并移除尚未保存的规格', button('添加规格'));
  await act('移除此规格', button('移除此规格'));
  assert.equal(await page.locator('[data-variant]').count(), 0);
  await act('添加将保存的规格', button('添加规格'));
  const row = page.locator('[data-variant]');
  await row.locator('[name=variant-specification]').fill('大号');
  await row.locator('[name=variant-sku]').fill('SYN-UI-LARGE');
  await row.locator('[name=variant-price]').fill('20.00');
  await row.locator('[name=variant-stock]').fill('4');
  await row.locator('[name=variant-image]').selectOption(source.id);
  const draft = await (await submit('save-draft', {
    title: '合成陶杯草稿', specification: '标准', sku: 'SYN-UI-MAIN', price: '15.00', stock: 3,
  }, { method: 'PUT', path: idRoute(drafts) })).json();
  assert.equal(draft.variants[0].sku, 'SYN-UI-LARGE');
  await page.getByRole('heading', { name: draft.title, exact: true }).waitFor();
  await act('返回草稿列表', link('返回草稿列表'), { method: 'GET', path: drafts });
  await act('检查草稿资料', link('检查草稿资料'), { method: 'GET', path: drafts + '/quality' });
  await visible(draft.title);
  await act('从质量检查回到草稿', link('编辑商品草稿'), { method: 'GET', path: drafts + '/' + draft.id });
  await act('进入草稿入账预览', link('预览入账'), { method: 'GET', path: baseBooks });
  const target = baseBooks + '/' + book.id + '/records/inventory';
  const result = await (await submit('inventory-preview', { day: '2026-11-18', threshold: 2 },
    { method: 'POST', path: target + '/draft-import/preview' })).json();
  assert.equal(result.ready, true);
  assert.deepEqual(result.items.map(item => item.sku), ['SYN-UI-MAIN', 'SYN-UI-LARGE']);
  assert.equal((await read(target)).items.length, 0);
  await act('确认写入运营库存', button('确认写入台账'), { method: 'POST', path: target + '/draft-import/confirm' });
  const { items } = await read(target);
  assert.deepEqual(items.map(item => item.reference).sort(), ['SYN-UI-LARGE', 'SYN-UI-MAIN']);
});

const bases = '/v1/knowledge/bases';
const service = '/v1/customer-service';
const conversations = service + '/conversations';
const replies = service + '/quick-replies';
const rights = '/v1/rights/notices';

test('knowledge, workspace support and rights forms persist changes and enforce asset restrictions', options, async t => {
  const fixture = await createStudioFixture(t);
  const { page, open, act, api, read, app, headers } = fixture;
  const { form, link, button, visible, submit, confirmed } = controls(fixture);
  const product = await api('POST', products, { sku: 'K-1', name: '客服合成商品' });
  await open('resources', form('new-base'));
  const knowledge = await (await submit('new-base', { name: '客服合成知识库' }, { method: 'POST', path: bases, status: 201 })).json();
  const knowledgeUrl = bases + '/' + knowledge.id;
  const documents = knowledgeUrl + '/documents';
  const categoryUrl = knowledgeUrl + '/categories';
  await submit('rename-base', { name: '客服测试知识' }, { method: 'PATCH', path: knowledgeUrl });
  await page.getByRole('heading', { name: '客服测试知识', exact: true }).waitFor();
  await act('进入知识库分类', link('文档分类'), { method: 'GET', path: categoryUrl });
  const category = await (await submit('add-category', { name: '护养' }, { method: 'POST', path: categoryUrl })).json();
  await visible('护养');
  await submit('rename-category', { id: category.id, name: '清洗' }, {
    method: 'PATCH', path: categoryUrl + '/' + category.id,
  });
  await visible('清洗');
  await act('浏览空分类', link('查看资料'), { method: 'GET', path: documents });
  await visible('此分类暂无文档。');
  await act('从分类文档返回分类', link('返回分类'), { method: 'GET', path: categoryUrl });
  await confirmed('删除空的知识分类', button('删除空分类'), { method: 'DELETE', path: categoryUrl + '/' + category.id });
  await act('从分类回到知识库', link('返回知识库'), { method: 'GET', path: documents });
  const doc = await (await submit('add-doc', {
    name: '陶杯手册', category: '产品规格', content: '容量是 350 毫升。', customerScope: product.id,
  }, { method: 'POST', path: documents, status: 201 })).json();
  await visible(doc.name);
  await act('读取知识文档', link('阅读'), { method: 'GET', path: documents + '/' + doc.id });
  await act('展开文档编辑', page.getByText('编辑文档', { exact: true }));
  await submit('edit-document', { content: '新容量是 375 毫升。' }, { method: 'PATCH', path: documents + '/' + doc.id });
  await visible('新容量是 375 毫升。');
  await act('返回当前知识库', link('返回知识库'), { method: 'GET', path: documents });
  await act('返回知识库清单', link('返回知识库清单'), { method: 'GET', path: bases });
  await submit('search', { query: '375', baseId: knowledge.id }, { method: 'POST', path: '/v1/knowledge/search' });
  await act('打开搜索命中文档', link('查看文档'), { method: 'GET', path: documents + '/' + doc.id });

  await open('customer/replies', form('new-reply'));
  const reply = await (await submit('new-reply', { title: '客服验收话术', scenario: '商品容量', content: '已确认容量。' },
    { method: 'POST', path: replies, status: 201 })).json();
  await visible(reply.title);
  await act('展开快捷话术编辑', page.getByText('查看或编辑', { exact: true }));
  await submit('reply-' + reply.id, { content: '人工核对结果为 375 毫升。' }, { method: 'PUT', path: replies + '/' + reply.id });
  await act('返回客服接待台', link('返回客服工作台'), { method: 'GET', path: conversations });
  const newChat = button('新建工作台会话').first();
  await act('打开并关闭空白会话表单', newChat);
  await act('关闭新会话表单', page.locator('[data-close-new]'));
  assert.equal(await page.locator('[data-inbox-dialog]').evaluate(dialog => dialog.open), false);
  await act('打开新建会话表单', newChat);
  const chat = await (await submit('new-conversation', { subject: '容量验证咨询', productId: product.id, baseId: knowledge.id },
    { method: 'POST', path: conversations, status: 201 })).json();
  assert.equal(chat.productId, product.id);
  const messages = conversations + '/' + chat.id + '/messages';
  const composer = page.locator('[data-chat-send]');
  await act('展开客服知识检索选项', composer.getByText('检索选项', { exact: true }));
  await composer.locator('[name=content]').fill('陶杯容量是多少？');
  await composer.locator('[name=search]').fill('容量');
  const turn = await (await act('发送客户消息', button('发送客户消息'), { method: 'POST', path: messages, status: 201 })).json();
  assert.match(turn.assistant.content, /375/);
  await act('转到回复助手', composer.locator('[data-compose-draft]'));
  await page.locator('#scene-customer-draft-tab[aria-selected=true]').waitFor();
  await act('返回接待台', page.locator('#scene-customer-inbox-tab'));
  await act('人工接管会话', button('人工接管'), { method: 'POST', path: conversations + '/' + chat.id + '/handoff' });
  await composer.locator('[name=quick]').selectOption(reply.id);
  assert.equal(await composer.locator('[name=content]').inputValue(), '人工核对结果为 375 毫升。');
  await act('发送人工回复', button('发送人工回复'), { method: 'POST', path: messages, status: 201 });
  assert.equal((await read(messages)).items.at(-1).sender, 'operator');
  await act('按人工接待筛选会话', page.locator('[data-inbox-filter=human]'));
  await visible(chat.subject);
  await open('customer/replies', form('new-reply'));
  await act('再次展开话术编辑', page.getByText('查看或编辑', { exact: true }));
  await confirmed('删除已用话术', button('删除话术'), { method: 'DELETE', path: replies + '/' + reply.id });
  assert.equal((await read(replies)).items.length, 0);

  const image = png();
  const asset = await api('POST', assets, { name: image.name, mediaType: image.mimeType, source: '合成素材',
    purpose: '权利操作验证', dataBase64: image.buffer.toString('base64') });
  await open('assets', link('提交权利通知'));
  await act('从素材预填权利通知', link('提交权利通知'));
  assert.equal(await form('rights-submit').locator('[name=assetId]').inputValue(), asset.id);
  const notice = await (await submit('rights-submit', { statement: '合成权利声明', evidenceReference: '合成证据引用' },
    { method: 'POST', path: rights, status: 201 })).json();
  const target = rights + '/' + notice.id;
  const transitions = [
    ['forward', 'forwarded'], ['restrict', 'restricted'], ['counter', 'counter_received'],
    ['forward-counter', 'counter_forwarded'], ['uphold', 'upheld'], ['restore', 'restored'],
  ];
  for (const [action, state] of transitions) {
    if (['restrict', 'uphold', 'restore'].includes(action)) page.once('dialog', dialog => dialog.accept());
    const outcome = await (await submit('rights-action', { action, explanation: '合成处理说明 ' + action },
      { method: 'POST', path: target + '/actions' })).json();
    assert.equal(outcome.state, state);
    await page.getByText('版本 ' + outcome.revision, { exact: false }).waitFor();
    if (action === 'restrict' || action === 'restore') {
      const response = await app.inject({ url: assets + '/' + asset.id + '/content', headers });
      assert.equal(response.statusCode, action === 'restore' ? 200 : 403);
    }
  }
  assert.deepEqual((await read(target)).events.map(event => event.action), transitions.map(([action]) => action));
  await act('返回权利通知案件清单', link('返回权利通知'), { method: 'GET', path: rights });
  await act('重新打开权利通知', link('查看案件'), { method: 'GET', path: target });

  await open('resources/' + knowledge.id, form('add-doc'));
  await confirmed('删除知识库文档', button('删除'), { method: 'DELETE', path: documents + '/' + doc.id, status: 204 });
  await confirmed('删除空知识库', button('删除知识库'), { method: 'DELETE', path: knowledgeUrl, status: 204 });
  assert.equal((await read(bases)).items.length, 0);
});
