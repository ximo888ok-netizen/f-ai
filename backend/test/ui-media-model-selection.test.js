import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { modelDefinitions } from '../src/config.js';
import { installModels } from '../src/models.js';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('the workbench sends the chosen image model and uses its saved asset as the first frame of the chosen video model', {
  skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 180000,
}, async t => {
  const env = { FAI_MEDIA_MODELS: 'qwen-image-3.0,MiniMax-H3-Image,wan3.0-video,MiniMax-H3',
    FAI_DASHSCOPE_WORKSPACE: 'ws-test', FAI_DASHSCOPE_KEY: 'fixture', FAI_MINIMAX_KEY: 'fixture' };
  const { page, open, act, read } = await createStudioFixture(t, {
    configureProviders: providers => installModels(providers, modelDefinitions(env), env),
  });
  const sample = createCanvas(512, 512).toBuffer('image/png').toString('base64');
  const sent = [];
  const output = 'https://media.example.test/generated.mp4';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.hostname, 'api.minimax.cn');
    const body = options.body && JSON.parse(options.body);
    sent.push({ path: url.pathname, body });
    if (url.pathname === '/v1/images/generations') return Response.json({ data: [{ b64_json: sample }] });
    if (url.pathname === '/v2/video_generation') return Response.json({ task_id: 'ui-task' });
    assert.equal(url.pathname, '/v2/query/video_generation/ui-task');
    return Response.json({ task: { id: 'ui-task', status: 'succeeded', content: { url: output } } });
  });

  const image = page.locator('[data-image-mode="advanced"]');
  await open('desk/image/advanced', image);
  await image.getByLabel('生图模型').selectOption('minimax-h3-image');
  await image.locator('[name=prompt]').fill('用自然光拍摄一个陶瓷杯。');
  const submit = { method: 'POST', path: '/v1/tasks', status: 202 };
  const response = await act('提交所选图片模型', image.locator('button[type=submit]'), submit);
  assert.equal(response.request().postDataJSON().modelId, 'minimax-h3-image');
  const imageTask = await response.json();
  await page.locator('.quick-image-results').getByRole('link', { name: '查看成品' }).waitFor({timeout: 30000});
  const imageResult = (await read('/v1/tasks/' + imageTask.id)).result;
  assert.equal(imageResult.modelId, 'minimax-h3-image');
  assert.equal((await read('/v1/assets/' + imageResult.assetId)).mediaType, 'image/png');

  const video = page.locator('[data-form=video-prompt]');
  await open('desk/video', video);
  await video.locator('[popovertarget="video-input"]').click();
  await video.locator('[name=inputType][value=frame]').click();
  await page.keyboard.press('Escape');
  await video.locator('[popovertarget="video-media"]').click();
  await video.locator('[data-video-asset-picker]').selectOption(imageResult.assetId);
  await page.keyboard.press('Escape');
  await video.locator('[popovertarget="video-model"]').click();
  await video.locator('[name=videoModel][value=minimax-h3]').click();
  await page.keyboard.press('Escape');
  assert.equal(await video.locator('[name=duration]').getAttribute('min'), '4');
  await video.locator('[name=prompt]').fill('以商品主图为首帧，缓慢推进镜头。');
  const submitted = await act('用所选视频模型提交首帧', video.locator('button[type=submit]'), submit);
  assert.equal(submitted.request().postDataJSON().modelId, 'minimax-h3');
  const videoTask = await submitted.json();
  await page.getByText('实际结果', {exact:true}).waitFor({timeout: 45000});
  assert.equal((await read('/v1/tasks/' + videoTask.id)).result.url, output);
  assert.equal(sent[0].body.model, 'MiniMax-H3-Image');
  const videoBodies = sent.filter(r => r.path === '/v2/video_generation');
  assert.equal(videoBodies.length, 1);
  assert.equal(videoBodies[0].body.model, 'MiniMax-H3');
  assert.equal(videoBodies[0].body.content[1].image_url.url, 'data:image/png;base64,' + sample);
});
