import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { createStudioFixture } from '../test-support/ui-actions.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const media = '/v1/media';
const batchPath = media + '/images/batches';
const templatesPath = media + '/images/platform-templates';
const presetsPath = media + '/images/series-presets';
const storiesPath = media + '/storyboards';
const uuidTail = '/[0-9a-f-]+$';
const newRecord = endpoint => new RegExp('^' + endpoint + uuidTail);

function mediaPng(color = '#315f88') {
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 64, 64);
  return canvas.toBuffer('image/png');
}

function seedImage(api, name, color) {
  return api('POST', '/v1/assets', {
    name, mediaType: 'image/png', source: '合成测试素材', purpose: '媒体控件浏览器回归',
    dataBase64: mediaPng(color).toString('base64'),
  });
}

function form(page, name) {
  return page.locator(`[data-form="${name}"]`);
}

function control(container, name) {
  return container.locator(`[name="${name}"]`);
}

function submit(container) {
  return container.locator('button.primary').last();
}

function post(path, status) { return { method: 'POST', path, status }; }
function put(path, status) { return { method: 'PUT', path, status }; }
function get(path, status) { return { method: 'GET', path, status }; }

async function download(page, action) {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  return readFile(await file.path());
}

function assertPng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
}

test('media actions publish and apply image export specifications, process sources and render image-series revisions', options, async t => {
  const { page, api, read, open, act } = await createStudioFixture(t);
  const [source, second] = await Promise.all([
    seedImage(api, '主件.png'), seedImage(api, '配件.png', '#da9928'),
  ]);
  const batch = form(page, 'image-batch');
  const rows = batch.locator('[data-edit-row]');
  await open('media/images/new/' + source.id, batch);
  assert.equal(await control(rows.first(), 'source').inputValue(), source.id);
  await rows.first().locator('[data-source-preview] img').waitFor();
  assert.equal(await rows.first().locator('[data-row-command=remove]').isDisabled(), true);

  await act('media.image.platform.open', page.getByText('平台导出规范', { exact: true }));
  const template = form(page, 'image-template-save');
  await control(template, 'platform').selectOption('pinduoduo');
  await control(template, 'width').fill('400');
  await control(template, 'height').fill('480');
  await control(template, 'fit').selectOption('cover');
  await control(template, 'format').selectOption('jpeg');
  await act('media.image.platform.publish', submit(template), put(templatesPath + '/pinduoduo', 200));
  assert.deepEqual((await read(templatesPath)).items, [
    { platform: 'pinduoduo', revision: 1, width: 400, height: 480, fit: 'cover', format: 'jpeg' },
  ]);
  await batch.locator('option[value=pinduoduo]').waitFor({ state: 'attached' });
  await control(rows.first(), 'key').fill('平台主图');
  await control(rows.first(), 'size').selectOption('pinduoduo');
  assert.equal(await control(rows.first(), 'format').isDisabled(), true);
  await act('media.image.batch.options', rows.first().locator('summary'));
  await control(rows.first(), 'backgroundMode').selectOption('transparent');
  await act('media.image.batch.reject-transparent-jpg', submit(batch));
  await page.getByText('透明背景需要 PNG，请更换格式或选择背景。', { exact: false }).waitFor();
  await control(rows.first(), 'backgroundMode').selectOption('default');

  await act('media.image.batch.add', batch.locator('[data-row-command=add]'));
  await act('media.image.batch.remove', rows.nth(1).locator('[data-row-command=remove]'));
  assert.equal(await rows.count(), 1);
  await act('media.image.batch.add-stack', batch.locator('[data-row-command=add]'));
  const stack = rows.nth(1);
  await control(stack, 'source').selectOption(second.id);
  await control(stack, 'key').fill('拼接方图');
  await act('media.image.batch.stack-options', stack.locator('summary'));
  await control(stack, 'composition').selectOption('stack');
  await control(stack, 'panel').first().selectOption(source.id);
  await control(stack, 'size').selectOption('custom');
  await control(stack, 'width').fill('128');
  await control(stack, 'height').fill('256');
  const savedResponse = await act('media.image.batch.submit', submit(batch), post(batchPath, 201));
  const saved = await savedResponse.json();
  const [platform, stacked] = saved.items;
  assert.deepEqual(savedResponse.request().postDataJSON().items[0].platformTemplate, { platform: 'pinduoduo', revision: 1 });
  assert.deepEqual(savedResponse.request().postDataJSON().items[1].assetIds, [second.id, source.id]);
  assert.deepEqual(saved.items.map(({ state, width, height, mediaType }) => [state, width, height, mediaType]), [
    ['succeeded', 400, 480, 'image/jpeg'], ['succeeded', 128, 256, 'image/png'],
  ]);
  assert.deepEqual(await read(batchPath + '/' + saved.id), saved);
  const contentPath = id => '/v1/assets/' + id + '/content';
  await act('media.image.batch.preview', page.locator(`[data-image-preview="${platform.assetId}"]`), get(contentPath(platform.assetId), 200));
  await page.locator('[data-image-preview-area] img').waitFor();
  assertPng(await download(page, () => act('media.image.batch.download', page.locator(`[data-image-download="${stacked.assetId}"]`), get(contentPath(stacked.assetId), 200))));

  await act('media.image.series.open', page.getByText('新建或编辑系列预设', { exact: true }));
  const editor = form(page, 'image-series-save');
  await control(editor, 'name').fill('测试系列');
  await control(editor, 'productAssetId').selectOption(source.id);
  const created = await (await act('media.image.series.create', submit(editor), put(newRecord(presetsPath), 200))).json();
  const presetRecord = presetsPath + '/' + created.id;
  await act('media.image.series.edit', page.locator(`[data-image-series-edit="${created.id}"]`));
  assert.equal(await control(editor, 'productAssetId').inputValue(), source.id);
  await act('media.image.series.reset', page.locator('[data-image-series-reset]'));
  assert.equal(await control(editor, 'name').inputValue(), '');
  await act('media.image.series.reopen', page.locator(`[data-image-series-edit="${created.id}"]`));
  await control(editor, 'name').fill('测试系列第二版');
  await control(editor, 'background').fill('#ffee77');
  await act('media.image.series.revision', submit(editor), put(presetRecord, 200));
  assert.equal((await read(presetRecord + '?revision=2')).configuration.background, '#ffee77');
  assert.equal((await read(presetRecord + '?revision=1')).name, '测试系列');
  const series = form(page, 'image-series-render');
  const entry = series.locator('[data-edit-row]');
  await series.locator('option').filter({ hasText: '测试系列第二版' }).waitFor({ state: 'attached' });
  await control(series, 'presetId').selectOption(created.id);
  await act('media.image.series.add', series.locator('[data-row-command=add]'));
  await act('media.image.series.remove', entry.nth(1).locator('[data-row-command=remove]'));
  await control(entry.first(), 'key').fill('系列方图');
  await control(entry.first(), 'caption').fill('Local test caption');
  const renderedResponse = await act('media.image.series.render', submit(series), post(batchPath, 201));
  const rendered = await renderedResponse.json();
  assert.deepEqual(renderedResponse.request().postDataJSON().seriesPreset, { id: created.id, revision: 2 });
  assert.equal((await read(batchPath + '/' + rendered.id)).items[0].state, 'succeeded');
});

test('media actions edit and reorder storyboard shots, open the prompt view and exercise both native confirmation choices', options, async t => {
  const { page, api, read, open, act } = await createStudioFixture(t);
  const [first, second] = await Promise.all([seedImage(api, '分镜一.png'), seedImage(api, '分镜二.png', '#da9928')]);
  await open('media/storyboards', page.getByRole('link', { name: '新建视频分镜' }));
  await act('media.story.create-link', page.getByRole('link', { name: '新建视频分镜' }));
  const editor = form(page, 'storyboard-save');
  const shots = editor.locator('[data-edit-row]');
  await control(editor, 'title').fill('合成商品分镜');
  await control(editor, 'ratio').selectOption('1:1');
  await control(editor, 'template').selectOption('feature-details');
  await control(shots.first(), 'assetId').selectOption(first.id);
  await control(shots.first(), 'duration').fill('1.25');
  await control(shots.first(), 'caption').fill('第一幕');
  await control(shots.first(), 'prompt').fill('商品正面');
  await act('media.story.add-shot', editor.locator('[data-row-command=add]'));
  await control(shots.nth(1), 'assetId').selectOption(second.id);
  await control(shots.nth(1), 'prompt').fill('商品侧面');
  await act('media.story.move-up', shots.nth(1).locator('[data-row-command=up]'));
  assert.equal(await control(shots.first(), 'assetId').inputValue(), second.id);
  await act('media.story.move-down', shots.first().locator('[data-row-command=down]'));
  assert.equal(await control(shots.first(), 'assetId').inputValue(), first.id);
  await act('media.story.add-extra-shot', editor.locator('[data-row-command=add]'));
  await act('media.story.remove-shot', shots.nth(2).locator('[data-row-command=remove]'));
  const created = await (await act('media.story.save', submit(editor), put(newRecord(storiesPath), 200))).json();
  const record = storiesPath + '/' + created.id;
  assert.equal(created.revision, 1);
  assert.deepEqual((await read(record)).configuration.shots.map(({ assetId, durationMs }) => [assetId, durationMs]), [[first.id, 1250], [second.id, 1500]]);
  await act('media.story.prompts', page.locator('[data-storyboard-prompts]'), get(record + '/prompts', 200));
  await page.locator('[data-story-prompts]').getByText('商品正面', { exact: false }).waitFor();
  await act('media.story.return-list', page.getByRole('link', { name: '返回分镜列表' }), get(storiesPath, 200));
  await act('media.story.edit-link', page.getByRole('link', { name: '编辑分镜' }), get(record, 200));
  await control(shots.nth(1), 'prompt').fill('商品侧面新版');
  await act('media.story.update', submit(editor), put(record, 200));
  assert.equal((await read(record)).revision, 2);
  const deleteButton = page.locator('[data-storyboard-delete]');
  page.once('dialog', dialog => dialog.dismiss());
  await act('media.story.delete-cancel', deleteButton);
  assert.equal((await read(record)).revision, 2);
  page.once('dialog', dialog => dialog.accept());
  await act('media.story.delete-confirm', deleteButton, { method: 'DELETE', path: record });
  assert.ok(!(await read(storiesPath)).items.some(item => item.id === created.id));
});
