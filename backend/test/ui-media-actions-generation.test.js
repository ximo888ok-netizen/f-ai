import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
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
    info: { id, model: id, kind, protocol, capabilities, streamText: false, ...extra }, supports: cap => capabilities.includes(cap.id), run,
  });
  let detailAttempts = 0;
  add('media-browser-image', 'image', 'openai-images', ['image.main-image'], async (_task, { parameters }) => {
    if (parameters.prompt.includes('组图控件失败重试') && ++detailAttempts <= 2) throw new ProviderError('INVALID_PROVIDER_IMAGE');
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
  add('media-browser-video', 'video', 'ark-video', ['video.compose', 'video.from-image', 'video.skill-seedance-film'], async () => ({
    type: 'video', fixture: 'synthetic task result',
  }));
  add('media-browser-video-alt', 'video', 'runway-video', ['video.compose', 'video.from-image'], async () => ({
    type: 'video', fixture: 'alternate synthetic model result',
  }));
  add('video-product-storyboard', 'text', 'media-skill', ['video.skill-product-storyboard'], async () => ({
    type: 'text', text: '合成分镜：镜头从杯口移至商品全景。',
  }));
  add('image-stitch', 'image', 'media-skill', ['image.skill-stitch'], async () => new MediaOutputs([
    { name: '合成详情.png', file: image() }, { name: '合成说明图.png', file: image() },
  ], { skill: 'image.skill-stitch', text: '合成测试制作说明' }));
}

async function download(page, action) {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  return readFile(await file.path());
}

async function chooseFile(page, act, label, control, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), act(label, control)]);
  await chooser.setFiles(file);
}

test('media actions test quick image input, advanced prompt favorites and Agent confirmation in the served workbench', options, async t => {
  const { page, read, open, act } = await createStudioFixture(t, { configureProviders: fixtureProviders });
  const imageInput = mode => page.locator(`[data-image-mode="${mode}"]`);
  const file = { name: '合成商品.png', mimeType: 'image/png', buffer: png() };
  const uploadProduct = (editor, actionLabel) => chooseFile(page, act, actionLabel, editor.locator('[data-quick-upload=products] button.quick-drop'), file);
  const quick = imageInput('quick');
  await open('desk/image', quick);
  assert.equal(await quick.locator('button[type=submit]').isDisabled(), true);
  await uploadProduct(quick, 'media.quick-image.choose-product');
  await page.locator('[data-quick-source]').waitFor();
  await act('media.quick-image.remove-file', quick.locator('[data-remove-quick-file]').first());
  assert.equal(await quick.locator('button[type=submit]').isDisabled(), true);
  await uploadProduct(quick, 'media.quick-image.choose-product-again');
  await field(quick, 'useReference').check();
  await act('media.quick-image.missing-reference', quick.locator('button[type=submit]'));
  await quick.getByText('请添加一张参考图，或关闭风格参考。').waitFor();
  await chooseFile(page, act, 'media.quick-image.choose-reference', quick.locator('[data-quick-upload=reference] button.quick-drop'), { ...file, name: '参考.png' });
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

  await open('desk/image', quick);
  await uploadProduct(quick, 'media.quick-image.suite-choose-product');
  await act('media.quick-image.suite-select', quick.locator('[name=quantity][value=suite]'));
  assert.equal(await quick.locator('[data-quick-suite]').isVisible(), true);
  await quick.locator('[name=size][value=custom]').check();
  await field(quick, 'width').fill('64');
  await field(quick, 'height').fill('64');
  await act('media.quick-image.suite-submit', quick.locator('button[type=submit]'), post(taskRoot));
  const allImages = page.locator('.quick-image-results').getByRole('link', { name: '查看成品' });
  await allImages.nth(4).waitFor();
  assert.equal(await allImages.count(), 5);

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
  await uploadProduct(agent, 'media.agent-image.choose-product');
  await agent.locator('[name=size][value=custom]').check();
  await field(agent, 'width').fill('64');
  await field(agent, 'height').fill('64');
  const plan = await act('media.agent-image.plan', agent.locator('button[type=submit]'), post(taskRoot));
  assert.equal(plan.request().postDataJSON().capabilityId, 'model.chat');
  await act('media.agent-image.plan-prompt', page.getByText('查看完整生图提示词', { exact: true }));
  await page.locator('.quick-plan-grid').getByText('保留原有轮廓，使用自然侧光', { exact: true }).waitFor();
  await field(agent, 'notes').fill('调整测试商品的镜头方向。');
  assert.equal(await page.locator('.quick-agent-plan').isVisible(), false);
  assert.equal(await agent.getByRole('button', { name: '开始逐张策划' }).isEnabled(), true);
  await act('media.agent-image.replan-after-edit', agent.getByRole('button', { name: '开始逐张策划' }), post(taskRoot));
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
  await act('media.task.result-asset', page.getByRole('link', { name: '在素材库查看', exact: true }), get('/v1/assets/' + asset));
  await open('tasks/' + generation.id, '[data-asset-download]');
  await act('media.task.revise-inputs', page.getByRole('link', { name: '修改参数再提交', exact: true }), get(taskRoot + '/' + generation.id + '/inputs'));
  const revised = form(page, 'task');
  const revisedPrompt = page.locator('[name="params.prompt"][form="image-task"]');
  assert.match(await revisedPrompt.inputValue(), /保留原有轮廓/);
  await field(revised, 'mode').selectOption('chat');
  await act('media.task.guided-next', revised.locator('[data-next]'));
  await act('media.task.guided-previous', revised.locator('[data-prev]'));
  await field(revised, 'mode').selectOption('workflow');
  await act('media.task.parameters-preview', revised.getByText('核对参数', { exact: true }));
  const helper = page.locator('[data-brief-assist]');
  const suggestion = await act('media.task.image-brief-assist', helper, post(taskRoot));
  await page.getByRole('link', { name: '查看帮写任务', exact: true }).waitFor();
  assert.match(suggestion.request().postDataJSON().parameters.messages[1].content, /保留原有轮廓/);
  await page.waitForFunction(() => document.querySelector('[name="params.prompt"][form="image-task"]').value.includes('第一镜拍摄杯口'));
  await revisedPrompt.fill('检查修改输入后生成合成图。');
  const child = await act('media.task.submit-revised-inputs', revised.locator('button.primary').last(), post(taskRoot));
  assert.equal(child.request().postDataJSON().parentId, generation.id);
  assert.equal((await child.json()).parentId, generation.id);
});

test('media video actions exercise prompt popovers and each staged video submission', options, async t => {
  const { page, read, api, open, act } = await createStudioFixture(t, { configureProviders: fixtureProviders });
  const source = await api('POST', '/v1/assets', { name: '合成首帧.png', source: '合成素材', purpose: '视频控件回归', mediaType: 'image/png', dataBase64: png().toString('base64') });
  const prompt = form(page, 'video-prompt');
  const launch = prompt.locator('button[type=submit]');
  const pop = (box, key) => box.locator(`[popovertarget="video-${key}"]`);
  await open('desk/video');
  try {
    await prompt.waitFor();
  } catch (error) {
    t.diagnostic('Video route ' + new URL(page.url()).hash + ': ' + await page.locator('#main').innerText());
    throw error;
  }
  assert.equal(await launch.isDisabled(), true);
  await act('media.video.prompt.template', page.locator('[data-video-template="0"]'));
  assert.match(await field(prompt, 'prompt').inputValue(), /展示商品全貌/);
  await act('media.video.prompt.audio-popover', pop(prompt, 'audio'));
  await page.locator('#video-audio').getByRole('link', { name: '视频导出' }).waitFor();
  await page.keyboard.press('Escape');
  await act('media.video.prompt.input-popover', pop(prompt, 'input'));
  await act('media.video.prompt.choose-reference-mode', prompt.locator('[name=inputType][value=reference]'));
  assert.equal(await launch.isDisabled(), true);
  await act('media.video.prompt.choose-first-frame-mode', prompt.locator('[name=inputType][value=frame]'));
  await page.keyboard.press('Escape');
  await act('media.video.prompt.media-popover', pop(prompt, 'media'));
  const picker = page.waitForEvent('filechooser');
  await act('media.video.prompt.local-chooser', prompt.locator('[data-video-upload]'));
  const [localUpload] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/assets'),
    (await picker).setFiles({ name: '本地首帧.png', mimeType: 'image/png', buffer: png() }),
  ]);
  assert.equal(localUpload.status(), 201);
  assert.equal((await read('/v1/assets/' + (await localUpload.json()).id)).name, '本地首帧.png');
  await page.keyboard.press('Escape');
  await act('media.video.prompt.remove-local', prompt.locator('[data-video-remove]'));
  await act('media.video.prompt.media-after-upload', pop(prompt, 'media'));
  await prompt.locator('[data-video-asset-picker]').selectOption(source.id);
  await prompt.locator('[data-video-asset] .video-asset-chip').filter({ hasText: source.name }).waitFor();
  await act('media.video.prompt.remove-asset', prompt.locator('[data-video-remove]'));
  assert.equal(await launch.isDisabled(), true);
  await act('media.video.prompt.media-reopen', pop(prompt, 'media'));
  await prompt.locator('[data-video-asset-picker]').selectOption(source.id);
  await act('media.video.prompt.model-popover', pop(prompt, 'model'));
  assert.equal(await prompt.locator('[name=videoModel][value=media-browser-video]').isChecked(), true);
  await act('media.video.prompt.choose-model', prompt.locator('[name=videoModel][value=media-browser-video-alt]'));
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
  assert.equal(direct.request().postDataJSON().modelId, 'media-browser-video-alt');
  assert.deepEqual(direct.request().postDataJSON().parameters, {
    prompt: '先用中景展示商品全貌，再用近景拍摄关键细节，最后以一个稳定的商品镜头收尾。',
    assetIds: [source.id], ratio: '1:1', options: { durationSeconds: duration },
  });
  await page.getByText('实际结果', { exact: true }).waitFor();
  const directTask = await direct.json();
  assert.equal((await read(taskRoot + '/' + directTask.id)).state, 'succeeded');

  await open('desk/video', prompt);
  await act('media.video.prompt.recent-task', page.locator(`.video-side a[href="#tasks/${directTask.id}"]`), get(taskRoot + '/' + directTask.id));
  await open('desk/video', prompt);
  await act('media.video.prompt.switch-plan', page.locator('[data-video-mode=plan]'));
  await act('media.video.prompt.switch-direct', page.locator('[data-video-mode=direct]'));
  assert.equal(await page.locator('[data-video-mode=direct]').getAttribute('aria-pressed'), 'true');
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
  const finishedTask = await finished.json();
  await page.waitForURL(url => url.hash === '#tasks/' + finishedTask.id);

  const pickFrame = async (box, label) => {
    await act('media.video.' + label + '.library', box.locator('[popovertarget=video-quick-library]'));
    await act('media.video.' + label + '.choose-frame', box.locator(`[data-video-quick-pick="${source.id}"]`), get('/v1/assets/' + source.id + '/content'));
  };
  const quick = page.locator('[data-video-quick]');
  await open('desk/video/quick', quick);
  await pickFrame(quick, 'quick');
  await act('media.video.quick.recent-open', quick.locator('[popovertarget=video-quick-recent]'));
  await page.locator('#video-quick-recent').getByText('暂无可用的近期生图成品。').waitFor();
  await page.keyboard.press('Escape');
  const chooser = page.waitForEvent('filechooser');
  await act('media.video.quick.local-chooser', quick.locator('[data-video-quick-upload]'));
  await (await chooser).setFiles({ name: '替换首帧.png', mimeType: 'image/png', buffer: png() });
  const alternateFrame = quick.getByRole('button', { name: '设为首帧：替换首帧.png' });
  await act('media.video.quick.choose-cover', alternateFrame);
  assert.equal(await alternateFrame.getAttribute('aria-pressed'), 'true');
  await act('media.video.quick.remove-cover', quick.getByRole('button', { name: '移除 替换首帧.png' }));
  assert.equal(await quick.getByRole('button', { name: '设为首帧：' + source.name }).getAttribute('aria-pressed'), 'true');
  await field(quick, 'notes').fill('保留合成商品原有轮廓');
  const script = await act('media.video.quick.script', quick.locator('button[type=submit]'), post(taskRoot));
  assert.match(script.request().postDataJSON().parameters.messages[1].content, /原有轮廓/);
  await quick.locator('[data-video-quick-script-text]').fill('保留测试商品的镜头。');
  const quickVideo = await act('media.video.quick.confirm', quick.locator('button[type=submit]'), post(taskRoot));
  assert.deepEqual(quickVideo.request().postDataJSON().parameters.assetIds, [source.id]);
  assert.equal(quickVideo.request().postDataJSON().parameters.prompt, '保留测试商品的镜头。');
  await quick.locator('[data-video-quick-result]').waitFor();

  const made = await api('POST', taskRoot, { idempotencyKey: 'media-video-recent-image', capabilityId: 'image.main-image',
    modelId: 'media-browser-image', mode: 'workflow', parameters: { prompt: '生成近期合成首帧供选择' } });
  let recent = made;
  for (let attempt = 0; attempt < 20 && !recent.result; attempt++) {
    await delay(200);
    recent = await read(taskRoot + '/' + made.id);
  }
  assert.equal(recent.state, 'succeeded');
  const recentId = recent.result.assetId;
  await page.reload();
  await quick.waitFor();
  await act('media.video.quick.recent-reopen', quick.locator('[popovertarget=video-quick-recent]'));
  await act('media.video.quick.choose-recent', quick.locator(`#video-quick-recent [data-video-quick-pick="${recentId}"]`), get('/v1/assets/' + recentId + '/content'));
  assert.equal(await quick.locator(`[data-video-quick-cover="${recentId}"]`).getAttribute('aria-pressed'), 'true');

  const director = page.locator('[data-video-director]');
  await open('desk/video/director', director);
  await act('media.video.director.storyboard-list', director.getByRole('link', { name: '分镜编辑', exact: true }), get('/v1/media/storyboards'));
  await act('media.video.director.storyboard-return', page.getByRole('link', { name: '返回智能导演', exact: true }));
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

  const skillDesk = page.locator('.media-skill-desk');
  await act('media.video.director.storyboard-skill', director.getByRole('link', { name: '商品分镜技能', exact: true }), get('/v1/media-skills/video'));
  const skillForm = skillDesk.locator('[data-skill-run]');
  await field(skillForm, 'prompt').fill('准备合成商品分镜。');
  await field(skillForm, 'library').selectOption(source.id);
  const storyboard = await (await act('media.video.skill.storyboard-run', skillForm.locator('[type=submit]'), post(taskRoot))).json();
  const handoff = skillDesk.getByRole('button', { name: '编辑分镜并带入 Seedance 成片', exact: true });
  await act('media.video.skill.storyboard-handoff', handoff, get(taskRoot + '/' + storyboard.id + '/inputs'));
  await skillDesk.getByRole('heading', { name: 'Seedance 商品展示片', exact: true }).waitFor();
  assert.equal(await field(skillForm, 'prompt').inputValue(), '合成分镜：镜头从杯口移至商品全景。');
  await field(skillForm, 'frameMode').selectOption('references');
  const videoSkill = await act('media.video.skill.seedance-run', skillForm.locator('[type=submit]'), post(taskRoot));
  assert.equal(videoSkill.request().postDataJSON().capabilityId, 'video.skill-seedance-film');
  assert.equal(videoSkill.request().postDataJSON().parameters.frameMode, 'references');
  assert.deepEqual(videoSkill.request().postDataJSON().parameters.assetIds, [source.id]);
});

test('media task actions recover trace errors, query and filter real events, re-run a task and show every skill output', options, async t => {
  const { page, read, api, app, headers, open, act } = await createStudioFixture(t, { configureProviders: fixtureProviders });
  const createAsset = name => api('POST', '/v1/assets', { name, source: '合成数据', purpose: '任务回归', mediaType: 'image/png', dataBase64: png().toString('base64') });
  const sources = await Promise.all([createAsset('详情一.png'), createAsset('详情二.png')]);
  await open('desk/image/skills', '.media-skill-desk');
  await page.getByRole('link', { name: '商品组图方案', exact: true }).waitFor();
  const team = await read('/v1/media-skills/image');
  const unavailable = team.items.find(item => item.id === 'image.skill-kling-generate');
  assert.deepEqual(unavailable.models, []);
  const desk = page.locator('.media-skill-desk');
  const skillForm = desk.locator('[data-skill-run]');
  await act('media.skill.unavailable-select', desk.locator('[data-select="image.skill-kling-generate"]'));
  await field(skillForm, 'prompt').fill('仅验证未接入供应商的阻止提示。');
  assert.equal(await skillForm.locator('[type=submit]').isDisabled(), true);
  assert.match(await skillForm.locator('[data-run-status]').innerText(), /待安装|待配置|不可用|已停用/);
  const before = await read('/v1/credits/wallet');
  const blocked = await app.inject({ method: 'POST', url: taskRoot, headers, payload: {
    capabilityId: unavailable.id, mode: 'workflow', idempotencyKey: 'media-unavailable-no-reservation',
    parameters: { prompt: '仅验证未接入供应商的阻止提示。', platform: unavailable.channels[0] },
  } });
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().error.code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(await read('/v1/credits/wallet'), before);
  await field(desk, 'onlyReady').check();
  await field(desk, 'search').fill('没有对应的合成技能');
  await desk.getByText('没有匹配的技能。', { exact: true }).waitFor();
  await field(desk, 'search').fill('');
  await act('media.skill.select', desk.locator('[data-select="image.skill-stitch"]'));
  await act('media.skill.source-open', desk.getByText('来源与运行要求', { exact: true }));
  await act('media.skill.upload-open', skillForm.getByText('上传到素材库', { exact: true }));
  await act('media.skill.upload-empty', skillForm.locator('[data-upload-files]'));
  await skillForm.getByText('请先选择文件。', { exact: true }).waitFor();
  await chooseFile(page, act, 'media.skill.choose-local-file', field(skillForm, 'upload'), { name: '新上传详情.png', mimeType: 'image/png', buffer: png() });
  const uploaded = await (await act('media.skill.upload', skillForm.locator('[data-upload-files]'), post('/v1/assets', 201))).json();
  assert.equal((await read('/v1/assets/' + uploaded.id)).name, '新上传详情.png');
  await act('media.skill.remove-uploaded', skillForm.locator('[data-remove="0"]'));
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
  const notes = await download(page, () => act('media.skill.download-instructions', desk.getByRole('button', { name: '下载制作说明', exact: true })));
  assert.equal(notes.toString(), '合成测试制作说明');
  const selectSkill = (label, skillId) => act('media.skill.' + label, desk.locator(`[data-select="${skillId}"]`));
  const downloadBrief = async label => JSON.parse((await download(page, () => act('media.skill.' + label, skillForm.locator('[data-brief]')))).toString());
  await selectSkill('choose-language-tool', 'image.skill-linkpix-image-translate');
  await field(skillForm, 'prompt').fill('翻译合成图片上的文案。');
  await field(skillForm, 'language').selectOption('日语');
  assert.match((await downloadBrief('language-brief')).parameters.prompt, /目标语言：日语/);
  await selectSkill('choose-color-tool', 'image.skill-linkpix-clothing-recolor');
  await field(skillForm, 'prompt').fill('为合成服饰参考换色。');
  await field(skillForm, 'color').fill('雾蓝色');
  assert.match((await downloadBrief('color-brief')).parameters.prompt, /目标颜色：雾蓝色/);
  await selectSkill('choose-slot-tool', 'image.skill-ecommerce-listing-suite');
  await skillForm.locator('[name=slot][value="包装图"]').uncheck();
  assert.ok(!(await downloadBrief('slots-brief')).parameters.slots.includes('包装图'));
  await selectSkill('choose-consent-tool', 'image.skill-aidge-tryon');
  await act('media.skill.consent-upload-open', skillForm.getByText('上传到素材库', { exact: true }));
  await chooseFile(page, act, 'media.skill.choose-consented-file', field(skillForm, 'upload'), { name: '授权合成素材.png', mimeType: 'image/png', buffer: png() });
  await act('media.skill.consent-upload-invalid', skillForm.locator('[data-upload-files]'));
  await skillForm.getByText('请填写有效授权凭证和未来的到期时间。', { exact: true }).waitFor();
  await field(skillForm, 'consent').fill('合成素材验收授权');
  await field(skillForm, 'expires').fill('2099-01-01T01:00');
  const consented = await (await act('media.skill.consent-upload', skillForm.locator('[data-upload-files]'), post('/v1/assets', 201))).json();
  assert.equal((await read('/v1/assets/' + consented.id)).consentReference, '合成素材验收授权');
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
    const [filtered] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === 'GET' && url.pathname === taskRoot && url.searchParams.get('state') === state;
      }),
      act('media.task.filter.' + state, page.locator(`a[href="#tasks/state/${state}"]`)),
    ]);
    assert.equal(filtered.status(), 200);
    assert.ok((await filtered.json()).items.every(record => record.state === state));
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
  await api('PUT', endpoint, { revision: created.revision, designNotes: '在另一个视图保存的设计说明',
    images: created.images.map(({ role, title, direction }) => ({ role, title, direction })) });
  const stale = await act('media.plan.stale-edit', edit.locator('.primary'), { method: 'PUT', path: endpoint, status: 409 });
  assert.equal((await stale.json()).error.code, 'IMAGE_PLAN_CHANGED');
  await page.reload();
  await field(edit, 'designNotes').fill('统一色调并保留商品轮廓。');
  await field(edit, 'imageTitle').nth(1).fill('组图控件失败重试');
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
  const retry = page.locator('[data-image-plan-retry]');
  await retry.waitFor();
  const nextAttempt = (await read(endpoint)).images[1];
  assert.equal(nextAttempt.attempt, 2);
  assert.equal(nextAttempt.state, 'failed');
  await act('media.plan.retry-from-plan', retry, post(nextAttempt.retryUrl));
  await page.getByText('全部完成', { exact: true }).waitFor();
  const complete = await read(endpoint);
  assert.equal(complete.images[1].attempt, 3);
  const main = complete.images[0];
  await act('media.plan.preview', page.locator('[data-image-plan-preview="0"]'), get('/v1/assets/' + main.assetId + '/content'));
  await page.locator('[data-plan-preview] img').waitFor();
  const delivered = await download(page, () => act('media.plan.download', page.locator('[data-image-plan-download="0"]'), get(main.deliveryUrl)));
  assert.equal(delivered.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await act('media.plan.draft-prefill', page.getByRole('link', { name: '创建商品草稿', exact: true }), get(endpoint));
  const draft = form(page, 'save-draft');
  assert.equal(await field(draft, 'image-main').inputValue(), main.assetId);
  assert.equal(await field(draft, 'image-detail').locator('option:checked').getAttribute('value'), complete.images[1].assetId);
  await field(draft, 'image-main').selectOption(source.id);
  await field(draft, 'image-detail').selectOption([]);
  const draftRoot = '/v1/studio/pinduoduo-drafts';
  for (const [name, value] of Object.entries({ title: '合成组图草稿', specification: '350ml', sku: 'MEDIA-TEST', price: '29.90', stock: '10' })) {
    await field(draft, name).fill(value);
  }
  const savedDraft = await (await act('media.plan.save-prefilled-draft', draft.locator('.primary').last(), { method: 'PUT', path: /^\/v1\/studio\/pinduoduo-drafts\/[0-9a-f-]+$/ })).json();
  await page.waitForURL(url => url.hash === '#drafts/' + savedDraft.id);
  await open('image-plans/' + created.id, '[data-form=image-plan-apply]');
  const apply = form(page, 'image-plan-apply');
  await field(apply, 'draftId').selectOption(savedDraft.id);
  await field(apply, 'detailPosition').selectOption('1');
  await act('media.plan.apply-existing-draft', apply.locator('.primary'), { method: 'POST', path: endpoint + '/apply-to-draft' });
  const linkedDraft = await read(draftRoot + '/' + savedDraft.id);
  assert.equal(linkedDraft.revision, savedDraft.revision + 1);
  assert.deepEqual(linkedDraft.images, complete.images.map(({ role, assetId }) => ({ role, assetId })));
});

test('media task cancellation releases the reservation before the worker starts the queued task', options, async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { page, read, api, open, act } = await createStudioFixture(t, { configureProviders(providers) {
    fixtureProviders(providers);
    const provider = providers.get('model:media-browser-image');
    const run = provider.run;
    provider.run = async (task, payload) => {
      if (payload.parameters.prompt === '仓库隔离的合成阻塞任务') {
        entered.resolve();
        await release.promise;
      }
      return run(task, payload);
    };
  } });
  const queue = (idempotencyKey, prompt) => api('POST', taskRoot, {
    capabilityId: 'image.main-image', mode: 'workflow', modelId: 'media-browser-image', idempotencyKey, parameters: { prompt },
  });
  try {
    await queue('media-action-blocker', '仓库隔离的合成阻塞任务');
    await Promise.race([entered.promise, new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('Local media worker did not acquire blocker')), 10000);
      timeout.unref();
      entered.promise.then(() => clearTimeout(timeout));
    })]);
    const before = await read('/v1/credits/wallet');
    const queued = await queue('media-action-cancel', '排队但应被取消的合成任务');
    const path = taskRoot + '/' + queued.id;
    const afterSubmit = await read('/v1/credits/wallet');
    assert.equal(afterSubmit.reserved, before.reserved + queued.cost);
    const cancel = page.locator('[data-cancel-task]');
    await open('tasks/' + queued.id, cancel);
    await act('media.task.cancel', cancel, post(path + '/cancel', 200));
    await page.getByText('已取消', { exact: true }).first().waitFor();
    assert.deepEqual(await read('/v1/credits/wallet'), before);
    const stopped = await read(path);
    assert.equal(stopped.state, 'cancelled');
    assert.equal(stopped.attempts, 0);
    assert.equal(await cancel.count(), 0);
  } finally {
    release.resolve();
  }
});

test('task stream resume reconnects the browser to a real pending task after transport failures', options, async t => {
  const release = Promise.withResolvers();
  const { page, api, read, open, act } = await createStudioFixture(t, { configureProviders(providers) {
    fixtureProviders(providers);
    const provider = providers.get('model:media-browser-text');
    provider.info.streamText = true;
    provider.streamText = async (_payload, append) => {
      await release.promise;
      const text = '恢复连接后收到合成回复。';
      await append(1, text);
      return { type: 'text', text };
    };
  } });
  try {
    const task = await api('POST', taskRoot, { idempotencyKey: 'task-stream-resume-test', capabilityId: 'model.chat', mode: 'workflow',
      modelId: 'media-browser-text', parameters: { stream: true, messages: [{ role: 'user', content: '等待合成回复' }] } });
    const taskPath = taskRoot + '/' + task.id;
    const stream = taskPath + '/stream';
    let requests = 0;
    await page.route(url => url.pathname === stream, route => {
      if (++requests > 6) return route.continue();
      return route.fulfill({ status: 503, json: { error: { code: 'TASK_STREAM_BUSY', message: 'Synthetic transport interruption' } } });
    });
    await open('tasks/' + task.id, '#reply-status');
    const resume = page.locator('[data-resume-reply]');
    await resume.waitFor({ timeout: 25000 });
    assert.equal(requests, 6);
    const recovered = await act('media.task.resume-stream', resume, get(stream));
    assert.equal(new URL(recovered.url()).searchParams.get('after'), '0');
    release.resolve();
    await page.getByRole('heading', { name: '实际结果', exact: true }).waitFor();
    await page.getByText('恢复连接后收到合成回复。', { exact: true }).first().waitFor();
    assert.equal((await read(taskPath)).result.text, '恢复连接后收到合成回复。');
  } finally {
    release.resolve();
  }
});
