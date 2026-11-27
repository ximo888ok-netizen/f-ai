import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { createStudioFixture } from '../test-support/ui-actions.js';
import { GeneratedFile } from '../src/model-file.js';
import { ProviderError } from '../src/providers.js';
import { MediaOutputs } from '../src/media-skill-files.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const taskRoot = '/v1/tasks';
const form = (page, name) => page.locator(`[data-form="${name}"]`);
const field = (box, name) => box.locator(`[name="${name}"]`);
const get = (path, status = 200) => ({ method: 'GET', path, status });
const post = (path, status = 202) => ({ method: 'POST', path, status });

function png() {
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = '#2e7e94';
  context.fillRect(0, 0, 64, 64);
  return canvas.toBuffer('image/png');
}

function fixtureProviders(providers) {
  const image = () => new GeneratedFile(png(), 'image/png');
  const add = (id, kind, protocol, capabilities, run, extra = {}) => providers.set('model:' + id, {
    info: { id, model: id, kind, protocol, capabilities, ...extra }, supports: cap => capabilities.includes(cap.id), run,
  });
  let detailAttempts = 0;
  add('media-browser-image', 'image', 'openai-images', ['image.main-image'], async (_task, { parameters }) => {
    if (parameters.prompt.includes('组图控件失败重试') && ++detailAttempts === 1) throw new ProviderError('INVALID_PROVIDER_IMAGE');
    return image();
  }, { imageQuality: true });
  add('media-browser-text', 'text', 'chat-completions', ['model.chat'], async (_task, { parameters }) => {
    const instructions = parameters.messages[0].content;
    const plans = [
      ['电商商品图片策划师', { images: [{ title: '商品正面', direction: '保留原有轮廓，使用自然侧光' }] }],
      ['提炼给定商品', { selling: ['陶瓷杯釉面'] }],
      ['2–4 个有区别', { directions: [{ title: '桌面全景', detail: '一个镜头展示商品' }, { title: '釉面细节', detail: '从侧光进入构图' }] }],
    ];
    const structured = plans.find(([marker]) => instructions.includes(marker));
    return { type: 'text', text: structured ? JSON.stringify(structured[1]) : '第一镜拍摄杯口，第二镜展示整个商品。' };
  });
  add('media-browser-video', 'video', 'ark-video', ['video.compose', 'video.from-image'], async () => ({
    type: 'video', fixture: 'synthetic task result',
  }));
  add('image-stitch', 'image', 'media-skill', ['image.skill-stitch'], async () => new MediaOutputs([
    { name: '合成详情.png', file: image() }, { name: '合成说明图.png', file: image() },
  ], { skill: 'image.skill-stitch', text: '合成测试制作说明' }));
}

async function download(page, action) {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  return readFile(await file.path());
}

test('media actions test quick image input, advanced prompt favorites and Agent confirmation in the served workbench', options, async t => {
  const { page, read, open, act } = await createStudioFixture(t, { configureProviders: fixtureProviders });
  const imageInput = mode => page.locator(`[data-image-mode="${mode}"]`);
  const file = { name: '合成商品.png', mimeType: 'image/png', buffer: png() };
  const uploadProduct = editor => editor.locator('[data-quick-upload=products] input[type=file]').setInputFiles(file);
  const quick = imageInput('quick');
  await open('desk/image', quick);
  assert.equal(await quick.locator('button[type=submit]').isDisabled(), true);
  await uploadProduct(quick);
  await page.locator('[data-quick-source]').waitFor();
  await act('media.quick-image.remove-file', quick.locator('[data-remove-quick-file]').first());
  assert.equal(await quick.locator('button[type=submit]').isDisabled(), true);
  await uploadProduct(quick);
  await field(quick, 'useReference').check();
  await act('media.quick-image.missing-reference', quick.locator('button[type=submit]'));
  await quick.getByText('请添加一张参考图，或关闭风格参考。').waitFor();
  await quick.locator('[data-quick-upload=reference] input[type=file]').setInputFiles({ ...file, name: '参考.png' });
  await quick.locator('[name=size][value=custom]').check();
  await field(quick, 'width').fill('64');
  await field(quick, 'height').fill('64');
  await quick.locator('[name=style][value="自定义"]').check();
  await field(quick, 'customStyle').fill('合成测试暖色');
  assert.match(await quick.locator('[data-quick-prompt]').inputValue(), /合成测试暖色/);
  const generated = await act('media.quick-image.submit', quick.locator('button[type=submit]'), post(taskRoot));
  assert.equal(generated.request().postDataJSON().parameters.assetIds.length, 2);
  const quickTask = await generated.json();
  await page.locator('.quick-image-results').getByRole('link', { name: '查看成品' }).waitFor();
  assert.equal((await read(taskRoot + '/' + quickTask.id)).state, 'succeeded');
  await act('media.quick-image.delivery-link', page.locator('.quick-image-results').getByRole('link', { name: '查看成品' }), get(/^\/v1\/assets\/[0-9a-f-]+$/));

  const advanced = imageInput('advanced');
  await open('desk/image', quick);
  await act('media.image.mode.advanced', page.getByRole('link', { name: '高级模式', exact: true }));
  const favorite = advanced.locator('[data-prompt-save]');
  const importFavorite = advanced.locator('[data-prompt-import]');
  const library = advanced.locator('[data-prompt-library]');
  await act('media.advanced-image.favorite-empty-error', favorite);
  await advanced.getByText('请输入 1–1200 字的完整提示词。').waitFor();
  const text = '按原样发送：杯子摆在浅色背景上。';
  await field(advanced, 'prompt').fill(text);
  await act('media.advanced-image.favorite-save', favorite);
  await advanced.getByText('已收藏到本机。').waitFor();
  await act('media.advanced-image.favorite-duplicate', favorite);
  await advanced.getByText('这条提示词已在收藏中。').waitFor();
  await act('media.advanced-image.favorite-open', importFavorite);
  await act('media.advanced-image.favorite-close', library.locator('[data-prompt-close]'));
  assert.equal(await library.isVisible(), false);
  await field(advanced, 'prompt').fill('');
  await act('media.advanced-image.favorite-reopen', importFavorite);
  await act('media.advanced-image.favorite-select', library.getByRole('button', { name: text }));
  assert.equal(await field(advanced, 'prompt').inputValue(), text);
  await advanced.locator('[name=size][value=custom]').check();
  await field(advanced, 'width').fill('64');
  await field(advanced, 'height').fill('64');
  const custom = await act('media.advanced-image.submit', advanced.locator('button[type=submit]'), post(taskRoot));
  assert.equal(custom.request().postDataJSON().parameters.prompt, text);
  await page.locator('.quick-image-results').getByRole('link', { name: '查看成品' }).waitFor();

  await act('media.image.mode.agent', page.getByRole('link', { name: 'Agent 生图', exact: true }));
  const agent = imageInput('agent');
  await uploadProduct(agent);
  await agent.locator('[name=size][value=custom]').check();
  await field(agent, 'width').fill('64');
  await field(agent, 'height').fill('64');
  const plan = await act('media.agent-image.plan', agent.locator('button[type=submit]'), post(taskRoot));
  assert.equal(plan.request().postDataJSON().capabilityId, 'model.chat');
  await act('media.agent-image.plan-prompt', page.getByText('查看完整生图提示词', { exact: true }));
  await page.locator('.quick-plan-grid').getByText('保留原有轮廓，使用自然侧光', { exact: true }).waitFor();
  const approved = await act('media.agent-image.confirm', agent.getByRole('button', { name: '确认方案并生成' }), post(taskRoot));
  assert.match(approved.request().postDataJSON().parameters.prompt, /保留原有轮廓/);
  await page.locator('.quick-image-results').getByRole('link', { name: '查看成品' }).waitFor();
  const generation = await approved.json();
  await act('media.agent-image.result-task', page.locator('.quick-image-results').getByRole('link', { name: '查看任务' }), get(taskRoot + '/' + generation.id));
  const asset = (await read(taskRoot + '/' + generation.id)).result.assetId;
  assert.deepEqual(await download(page, () => act('media.task.download', page.locator('[data-asset-download]'), get('/v1/assets/' + asset + '/content'))), png());
  const marked = await download(page, () => act('media.task.download-marked', page.locator('[data-delivery-download]'), get('/v1/assets/' + asset + '/delivery')));
  assert.equal(marked.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.notDeepEqual(marked, png());
});

test('media video actions exercise prompt popovers and each staged video submission', options, async t => {
  const { page, read, api, open, act } = await createStudioFixture(t, { configureProviders: fixtureProviders });
  const source = await api('POST', '/v1/assets', { name: '合成首帧.png', source: '合成素材', purpose: '视频控件回归', mediaType: 'image/png', dataBase64: png().toString('base64') });
  const prompt = form(page, 'video-prompt');
  const launch = prompt.locator('button[type=submit]');
  const pop = (box, key) => box.locator(`[popovertarget="video-${key}"]`);
  await open('desk/video', prompt);
  assert.equal(await launch.isDisabled(), true);
  await act('media.video.prompt.template', page.locator('[data-video-template="0"]'));
  assert.match(await field(prompt, 'prompt').inputValue(), /展示商品全貌/);
  await act('media.video.prompt.audio-popover', pop(prompt, 'audio'));
  await page.locator('#video-audio').getByRole('link', { name: '视频导出' }).waitFor();
  await page.keyboard.press('Escape');
  await act('media.video.prompt.input-popover', pop(prompt, 'input'));
  await prompt.locator('[name=inputType][value=reference]').check();
  assert.equal(await launch.isDisabled(), true);
  await prompt.locator('[name=inputType][value=frame]').check();
  await page.keyboard.press('Escape');
  await act('media.video.prompt.media-popover', pop(prompt, 'media'));
  await prompt.locator('[data-video-asset-picker]').selectOption(source.id);
  await prompt.getByText(source.name).waitFor();
  await act('media.video.prompt.remove-asset', prompt.locator('[data-video-remove]'));
  assert.equal(await launch.isDisabled(), true);
  await act('media.video.prompt.media-reopen', pop(prompt, 'media'));
  await prompt.locator('[data-video-asset-picker]').selectOption(source.id);
  await act('media.video.prompt.model-popover', pop(prompt, 'model'));
  assert.equal(await prompt.locator('[name=videoModel][value=media-browser-video]').isChecked(), true);
  await page.keyboard.press('Escape');
  await act('media.video.prompt.ratio-popover', pop(prompt, 'ratio'));
  await prompt.locator('[name=ratio][value="1:1"]').check();
  await page.keyboard.press('Escape');
  await act('media.video.prompt.length-popover', pop(prompt, 'length'));
  await field(prompt, 'defaultDuration').uncheck();
  await field(prompt, 'duration').press('Home');
  await field(prompt, 'duration').press('ArrowRight');
  const duration = Number(await field(prompt, 'duration').inputValue());
  await page.keyboard.press('Escape');
  const direct = await act('media.video.prompt.direct', launch, post(taskRoot));
  assert.deepEqual(direct.request().postDataJSON().parameters, {
    prompt: '先用中景展示商品全貌，再用近景拍摄关键细节，最后以一个稳定的商品镜头收尾。',
    assetIds: [source.id], ratio: '1:1', options: { durationSeconds: duration },
  });
  await page.getByText('实际结果', { exact: true }).waitFor();
  assert.equal((await read(taskRoot + '/' + (await direct.json()).id)).state, 'succeeded');

  await open('desk/video', prompt);
  await field(prompt, 'prompt').fill('以自然光展示陶瓷杯。');
  await act('media.video.prompt.plan-mode', page.locator('[data-video-mode=plan]'));
  await act('media.video.prompt.skill-popover', pop(prompt, 'skill'));
  await prompt.locator('[name=skill][value=story]').check();
  await page.keyboard.press('Escape');
  const plan = await act('media.video.prompt.plan', launch, post(taskRoot));
  assert.match(plan.request().postDataJSON().parameters.messages[1].content, /简短场景/);
  await prompt.locator('[data-video-plan-text]').fill('用平移镜头展示测试杯子。');
  const finished = await act('media.video.prompt.plan-confirm', launch, post(taskRoot));
  assert.equal(finished.request().postDataJSON().parameters.prompt, '用平移镜头展示测试杯子。');

  const pickFrame = async (box, label) => {
    await act('media.video.' + label + '.library', box.locator('[popovertarget=video-quick-library]'));
    await act('media.video.' + label + '.choose-frame', box.locator(`[data-video-quick-pick="${source.id}"]`), get('/v1/assets/' + source.id + '/content'));
  };
  const quick = page.locator('[data-video-quick]');
  await open('desk/video/quick', quick);
  await pickFrame(quick, 'quick');
  await field(quick, 'notes').fill('保留合成商品原有轮廓');
  const script = await act('media.video.quick.script', quick.locator('button[type=submit]'), post(taskRoot));
  assert.match(script.request().postDataJSON().parameters.messages[1].content, /原有轮廓/);
  await quick.locator('[data-video-quick-script-text]').fill('保留测试商品的镜头。');
  const quickVideo = await act('media.video.quick.confirm', quick.locator('button[type=submit]'), post(taskRoot));
  assert.deepEqual(quickVideo.request().postDataJSON().parameters.assetIds, [source.id]);
  assert.equal(quickVideo.request().postDataJSON().parameters.prompt, '保留测试商品的镜头。');
  await quick.locator('[data-video-quick-result]').waitFor();

  const director = page.locator('[data-video-director]');
  await open('desk/video/director', director);
  await pickFrame(director, 'director');
  await field(director, 'notes').fill('测试陶瓷杯釉面');
  const next = director.locator('[data-director-next]');
  await act('media.video.director.insights', director.locator('button[type=submit]'), post(taskRoot));
  await field(director, 'director-fact').check();
  await act('media.video.director.reset', director.locator('[data-director-reset]'));
  assert.equal(await director.locator('[data-director-stage]').isVisible(), false);
  await act('media.video.director.restart', director.locator('button[type=submit]'), post(taskRoot));
  await field(director, 'director-fact').check();
  const direction = await act('media.video.director.directions', next, post(taskRoot));
  assert.match(direction.request().postDataJSON().parameters.messages[1].content, /陶瓷杯釉面/);
  await field(director, 'director-direction').first().check();
  await act('media.video.director.script', next, post(taskRoot));
  await director.locator('[data-director-script]').fill('本地验证：先拍整个陶瓷杯。');
  const result = await act('media.video.director.confirm', next, post(taskRoot));
  assert.equal(result.request().postDataJSON().parameters.prompt, '本地验证：先拍整个陶瓷杯。');
  assert.deepEqual(result.request().postDataJSON().parameters.assetIds, [source.id]);
});

test('media task actions recover trace errors, query and filter real events, re-run a task and show every skill output', options, async t => {
  const { page, read, api, open, act } = await createStudioFixture(t, { configureProviders: fixtureProviders });
  const createAsset = name => api('POST', '/v1/assets', { name, source: '合成数据', purpose: '任务回归', mediaType: 'image/png', dataBase64: png().toString('base64') });
  const sources = await Promise.all([createAsset('详情一.png'), createAsset('详情二.png')]);
  await open('desk/image/skills', '.media-skill-desk');
  await page.getByRole('link', { name: '商品组图方案', exact: true }).waitFor();
  const team = await read('/v1/media-skills/image');
  assert.ok(team.items.some(item => item.state !== 'configured'));
  const desk = page.locator('.media-skill-desk');
  await field(desk, 'onlyReady').check();
  await field(desk, 'search').fill('没有对应的合成技能');
  await desk.getByText('没有匹配的技能。', { exact: true }).waitFor();
  await field(desk, 'search').fill('');
  await act('media.skill.select', desk.locator('[data-select="image.skill-stitch"]'));
  const skillForm = desk.locator('[data-skill-run]');
  await act('media.skill.source-open', desk.getByText('来源与运行要求', { exact: true }));
  await act('media.skill.upload-open', skillForm.getByText('上传到素材库', { exact: true }));
  await act('media.skill.upload-empty', skillForm.locator('[data-upload-files]'));
  await skillForm.getByText('请先选择文件。', { exact: true }).waitFor();
  await field(skillForm, 'library').selectOption(sources[0].id);
  assert.equal(await skillForm.locator('[type=submit]').isDisabled(), true);
  await field(skillForm, 'library').selectOption(sources[1].id);
  await act('media.skill.asset-up', skillForm.locator('[data-up="1"]'));
  await act('media.skill.asset-remove', skillForm.locator('[data-remove="1"]'));
  await field(skillForm, 'library').selectOption(sources[0].id);
  await field(desk, 'onlyReady').uncheck();
  await act('media.skill.alternate', desk.locator('[data-select="image.skill-white-check"]'));
  await act('media.skill.return-to-draft', desk.locator('[data-select="image.skill-stitch"]'));
  assert.deepEqual(await skillForm.locator('[data-asset-order] li span').allTextContents(), [sources[1].name, sources[0].name]);
  const brief = JSON.parse((await download(page, () => act('media.skill.brief', skillForm.locator('[data-brief]')))).toString());
  assert.deepEqual(brief.parameters.assetIds, [sources[1].id, sources[0].id]);
  const submitted = await act('media.skill.run', skillForm.locator('[type=submit]'), post(taskRoot));
  assert.deepEqual(submitted.request().postDataJSON().parameters.assetIds, brief.parameters.assetIds);
  const skill = await submitted.json();
  await desk.locator('[data-results]').getByText('任务已完成', { exact: true }).waitFor();
  await page.route('**/v1/tasks/' + skill.id + '/events?limit=4', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"DATABASE_UNAVAILABLE"}' }), { times: 1 });
  await open('tasks/' + skill.id, '[data-trace-retry]');
  await act('media.task.trace-retry', page.locator('[data-trace-retry]'), get(taskRoot + '/' + skill.id + '/events'));
  await page.locator('[data-task-trace] ol').waitFor();
  await page.getByText('合成测试制作说明', { exact: true }).waitFor();
  const done = await read(taskRoot + '/' + skill.id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.result.files.map(file => file.name), ['合成详情.png', '合成说明图.png']);
  const asset = done.result.files[1].assetId;
  const second = page.locator(`[data-task-file-download="${asset}"]`);
  assert.deepEqual(await download(page, () => act('media.task.download-extra-output', second, get('/v1/assets/' + asset + '/content'))), png());
  await act('media.task.journal-open', page.getByText('查询执行日志', { exact: true }));
  const journal = form(page, 'journal');
  await field(journal, 'level').selectOption('error');
  const events = await act('media.task.journal-query', journal.getByRole('button', { name: '查询日志' }), get(taskRoot + '/' + skill.id + '/events'));
  assert.equal(new URL(events.url()).searchParams.get('level'), 'error');
  await page.locator('[data-journal-results]').getByText('没有符合条件的日志。').waitFor();
  await field(journal, 'from').fill('2030-01-02T01:00');
  await field(journal, 'to').fill('2030-01-01T01:00');
  await act('media.task.journal-invalid-range', journal.getByRole('button', { name: '查询日志' }));
  await page.getByText('开始时间不能晚于结束时间。', { exact: false }).waitFor();
  const retry = await (await act('media.task.regenerate', page.locator('[data-regenerate-task]'), post(taskRoot + '/' + skill.id + '/regenerate'))).json();
  assert.equal(retry.parentId, skill.id);
  await act('media.task.parent-link', page.getByRole('link', { name: '查看原任务', exact: true }), get(taskRoot + '/' + skill.id));
  await act('media.task.return-log', page.getByRole('link', { name: '返回任务记录' }), get(taskRoot));
  const filters = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
  for (const state of filters) {
    const filtered = await act('media.task.filter.' + state, page.locator(`a[href="#tasks/state/${state}"]`), get(taskRoot));
    assert.equal(new URL(filtered.url()).searchParams.get('state'), state);
  }
  await act('media.task.filter.all', page.getByRole('link', { name: '全部任务', exact: true }), get(taskRoot));
  await page.getByRole('link', { name: '查看任务', exact: true }).first().waitFor();
});

test('media plan actions verify revision guards, run a single failed-image retry from the task center and preview linked delivery', options, async t => {
  const { page, read, api, open, act } = await createStudioFixture(t, { configureProviders: fixtureProviders });
  const source = await api('POST', '/v1/assets', { name: '组图素材.png', source: '合成数据', purpose: '组图回归', mediaType: 'image/png', dataBase64: png().toString('base64') });
  const planRoot = '/v1/media/images/product-plans';
  const create = form(page, 'image-plan-create');
  await open('desk/image', '[data-image-mode=quick]');
  await act('media.plan.open', page.getByRole('link', { name: '商品组图方案', exact: true }), get(planRoot));
  await field(create, 'productName').fill('浏览器合成商品');
  await field(create, 'requirements').fill('展示杯口和侧面。');
  await field(create, 'assetId').selectOption(source.id);
  await field(create, 'detailCount').fill('1');
  const created = await (await act('media.plan.create', create.locator('.primary'), post(planRoot, 201))).json();
  const endpoint = planRoot + '/' + created.id;
  const edit = form(page, 'image-plan-edit');
  const confirm = form(page, 'image-plan-confirm');
  await field(edit, 'designNotes').fill('统一色调并保留商品轮廓。');
  await field(edit, 'imageTitle').nth(1).fill('组图控件失败重试');
  assert.equal(await confirm.locator('.primary').isDisabled(), true);
  await act('media.plan.edit', edit.locator('.primary'), { method: 'PUT', path: endpoint, status: 200 });
  assert.equal((await read(endpoint)).images[1].title, '组图控件失败重试');
  await field(confirm, 'modelId').selectOption('media-browser-image');
  await act('media.plan.confirm', confirm.locator('.primary'), { method: 'POST', path: endpoint + '/confirm' });
  await page.locator('[data-image-plan-retry]').waitFor();
  const failedPlan = await read(endpoint);
  const failed = failedPlan.images[1];
  assert.equal(failed.state, 'failed');
  await act('media.plan.refresh', page.locator('[data-image-plan-refresh]'), get(endpoint));
  await act('media.plan.review-failed-task', page.locator(`a[href="#tasks/${failed.taskId}"]`), get(taskRoot + '/' + failed.taskId));
  const restored = await (await act('media.plan.regenerate-via-task', page.locator('[data-regenerate-task]'), post(taskRoot + '/' + failed.taskId + '/regenerate'))).json();
  assert.equal(restored.imagePlan.attempt, 2);
  assert.equal(restored.parentId, failed.taskId);
  await act('media.plan.back-from-task', page.getByRole('link', { name: '查看整组方案', exact: true }), get(endpoint));
  await page.getByText('全部完成', { exact: true }).waitFor();
  const complete = await read(endpoint);
  const main = complete.images[0];
  await act('media.plan.preview', page.locator('[data-image-plan-preview="0"]'), get('/v1/assets/' + main.assetId + '/content'));
  await page.locator('[data-plan-preview] img').waitFor();
  const delivered = await download(page, () => act('media.plan.download', page.locator('[data-image-plan-download="0"]'), get(main.deliveryUrl)));
  assert.equal(delivered.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await act('media.plan.draft-prefill', page.getByRole('link', { name: '创建商品草稿', exact: true }), get(endpoint));
  const draft = form(page, 'save-draft');
  assert.equal(await field(draft, 'image-main').inputValue(), main.assetId);
  assert.equal(await field(draft, 'image-detail').locator('option:checked').getAttribute('value'), complete.images[1].assetId);
});
