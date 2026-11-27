import assert from 'node:assert/strict';
import test from 'node:test';
import { installModels } from '../src/models.js';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('video steps use configured controls and submit the selected options through the task API', {
  skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 150000,
}, async t => {
  const spec = { ratios: ['21:9'], resolutions: ['720p', '1080p'], durations: [5, 12, 24], audio: true };
  const mapping = { kind: 'video', createPath: 'render', outputPath: 'url', outputFormat: 'url',
    body: { params: { $from: 'parameters' }, refs: { $from: 'assets' } } };
  const definition = { id: 'configured-video', model: 'local-render', protocol: 'json-http', baseUrl: 'http://localhost:4321',
    mapping, capabilities: ['video.compose', 'video.from-image', 'video.reference'],
    videoOptions: { text: spec, frame: { ratios: [], resolutions: ['720p'], durations: [5], audio: false },
      reference: { ...spec, durations: [4, 8] } } };
  const { page, open, read, headers, app, act } = await createStudioFixture(t, { configureProviders: p => installModels(p, [definition]) });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ url: 'https://media.example.test/unit.mp4' }));
  const form = page.locator('[data-form=video-prompt]'), steps = page.locator('[data-dual-workflow=video]');
  await open('desk/video', form);
  assert.deepEqual((await read('/v1/models')).items.find(m => m.id === definition.id).videoOptions, definition.videoOptions);
  const step = i => steps.locator('[data-dual-step="' + i + '"]').click();
  const action = name => steps.getByRole('button', { name, exact: true }).click();
  const escape = () => page.keyboard.press('Escape');
  const pop = key => form.locator('[popovertarget=video-' + key + ']').click();
  const check = (name, value) => form.locator('[name=' + name + '][value="' + value + '"]').check();
  await step(1);
  await action('选择生成方式');
  await check('inputType', 'reference');
  await escape();
  await pop('length');
  assert.deepEqual(await form.locator('select[name=durationChoice] option').allTextContents(), ['4 秒', '8 秒']);
  await escape();
  await pop('input');
  await check('inputType', 'text');
  await escape();
  await step(2);
  await action('编辑创作要求');
  await form.locator('[name=prompt]').fill('摄影机缓慢推进。');
  await step(3);
  await action('画幅与清晰度');
  await check('ratio', '21:9');
  await check('resolution', '1080p');
  await escape();
  await action('视频时长');
  await form.locator('[name=defaultDuration]').uncheck();
  await form.locator('[name=durationChoice]').selectOption('24');
  await escape();
  await action('声音');
  await check('generateAudio', 'false');
  await escape();
  const rejected = await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: {
    capabilityId: 'video.compose', modelId: definition.id, mode: 'workflow', parameters: { prompt: 'bad', options: { durationSeconds: 7 } },
    idempotencyKey: crypto.randomUUID(),
  } });
  assert.equal(rejected.statusCode, 400);
  await step(4);
  const response = await act('确认视频设置后提交', steps.locator('[data-dual-next]'), { method: 'POST', path: '/v1/tasks', status: 202 });
  assert.deepEqual(response.request().postDataJSON().parameters, { prompt: '摄影机缓慢推进。', ratio: '21:9',
    options: { durationSeconds: 24, resolution: '1080p', generateAudio: false } });
  const task = await response.json();
  await page.waitForURL(url => url.hash === '#tasks/' + task.id);
  await open('desk/video', form);
  await pop('ratio');
  await check('resolution', '1080p');
  await escape();
  await pop('input');
  await check('inputType', 'frame');
  await escape();
  assert.equal(await form.locator('[name=resolution]:checked').inputValue(), '');
  assert.equal(await form.locator('[name=generateAudio]').count(), 0);
  assert.equal(await form.locator('[name=ratio]').count(), 0);
});
