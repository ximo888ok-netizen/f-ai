import assert from 'node:assert/strict';
import test from 'node:test';
import { modelDefinitions } from '../src/config.js';
import { catalog } from '../src/catalog.js';
import { installModels } from '../src/models.js';
import { GeneratedFile } from '../src/model-file.js';
import { PendingModelJob } from '../src/model-http.js';

const env = { FAI_MINIMAX_KEY: 'local-test', FAI_ARK_KEY: 'local-test', FAI_DASHSCOPE_KEY: 'local-test',
  FAI_KLING_KEY: 'local-test', FAI_DASHSCOPE_WORKSPACE: 'ws-test' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const asset = { mediaType: 'image/png', dataBase64: png };
const dataUrl = 'data:image/png;base64,' + png;
const videoUrl = 'https://media.example.test/clip.mp4';
const jobId = '952754926510378001';
const prompt = '自然光下展示茶杯';

function provider(model) {
  const definitions = modelDefinitions({ ...env, FAI_MEDIA_MODELS: model });
  return [...installModels(new Map(), definitions, env).values()][0];
}

function intercept(t, response) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = { url, body: options.body && JSON.parse(options.body), headers: options.headers, method: options.method };
    calls.push(request);
    return Response.json(response(request, calls.length));
  });
  return calls;
}

test('media presets preserve explicit routes and require the selected workspace and credentials', () => {
  assert.deepEqual(modelDefinitions(env), []);
  const explicit = [{ enabled: false, id: 'existing' }];
  const configs = modelDefinitions({ ...env, MODEL_PROVIDERS_JSON: JSON.stringify(explicit),
    FAI_MEDIA_MODELS: 'qwen-image-3.0-pro,MiniMax-H3-Image-Highspeed,MiniMax-H3-Highspeed,MiniMax-H3-Lite,MiniMax-H3-Max,kling-4.0-flash,wan3.0-video-prime,doubao-seedance-2-5-flash-261115' });
  assert.deepEqual(configs[0], explicit[0]);
  const providers = installModels(new Map(), configs, env);
  assert.equal(providers.size, 8);
  assert.equal(configs[1].baseUrl, 'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(providers.get('model:minimax-h3-max').info.videoLimits.minSeconds, 5);
  assert.throws(() => modelDefinitions({ FAI_MEDIA_MODELS: 'wan3.0-video' }), /WORKSPACE/);
  assert.throws(() => modelDefinitions({ ...env, FAI_MEDIA_MODELS: 'unknown' }), /Unknown model/);
  assert.throws(() => installModels(new Map(), configs, {}), /Missing credentials/);
});

for (const [model, protocol, basePath] of [
  ['qwen-image-3.0', 'qwen-image', '/compatible-mode/v1/'],
  ['MiniMax-H3-Image', 'minimax-h3-image', '/v1/'],
  ['doubao-seedream-5-5-261028', 'seedream-image', '/api/v3/'],
]) {
  test(model + ' produces a verified PNG and sends reference images through its official JSON endpoint', async t => {
    const api = provider(model);
    assert.equal(api.info.protocol, protocol);
    const calls = intercept(t, () => ({ data: [{ b64_json: png }] }));
    for (const assets of [[], [asset, asset]]) {
      const result = await api.run({}, { assets, parameters: { prompt, ratio: '9:16' } });
      assert.ok(result instanceof GeneratedFile);
      assert.equal(result.bytes.toString('base64'), png);
      const { url, body, headers } = calls.at(-1);
      assert.equal(headers.authorization, 'Bearer local-test');
      const mini = protocol === 'minimax-h3-image';
      assert.equal(url.pathname, basePath + (mini && assets.length ? 'images/edits' : 'images/generations'));
      assert.equal(body.model, model);
      assert.equal(body.response_format, 'b64_json');
      assert.equal(body[mini ? 'aspect_ratio' : 'size'], mini ? '9:16' : '720x1280');
      if (assets.length && mini) assert.deepEqual(body.images, [{ image_url: dataUrl }, { image_url: dataUrl }]);
      else if (assets.length) assert.deepEqual(body.image, [dataUrl, dataUrl]);
      else assert.ok(!('images' in body) && !('image' in body));
    }
    if (protocol === 'qwen-image') {
      assert.throws(() => api.validate(catalog.get('image.main-image'), { prompt, assetIds: Array(4).fill('id') }), /三张/);
    }
  });
}

const cases = [
  { model: 'wan3.0-video', create: '/api/v1/services/aigc/video-generation/video-synthesis', query: '/api/v1/tasks/'+jobId,
    created: { output: { task_id: jobId } }, pending: { output: { task_status: 'PENDING' } },
    done: { output: { task_status: 'SUCCEEDED', video_url: videoUrl } }, failed: { output: { task_status: 'FAILED' } } },
  { model: 'doubao-seedance-2-5-260628', create: '/api/v3/contents/generations/tasks', query: '/api/v3/contents/generations/tasks/'+jobId,
    created: { id: jobId }, pending: { status: 'queued' }, done: { status: 'succeeded', content: { video_url: videoUrl } }, failed: { status: 'failed' } },
  { model: 'MiniMax-H3', create: '/v2/video_generation', query: '/v2/query/video_generation/'+jobId,
    created: { task_id: jobId }, pending: { task: { id: jobId, status: 'queued' } },
    done: { task: { id: jobId, status: 'succeeded', content: { url: videoUrl } } }, failed: { task: { id: jobId, status: 'failed' } } },
  { model: 'kling-4.0', create: '/image-to-video/kling-4.0', query: '/tasks?task_ids='+jobId,
    created: { code: 0, data: { id: jobId } }, pending: { code: 0, data: [{ id: jobId, status: 'processing' }] },
    done: { code: 0, data: [{ id: 'other', status: 'failed' }, { id: jobId, status: 'succeeded', outputs: [{ type: 'video', url: videoUrl }] }] },
    failed: { code: 0, data: [{ id: jobId, status: 'failed' }] } },
];

for (const c of cases) {
  test(c.model + ' submits text or a first frame and polls the same upstream job', async t => {
    const api = provider(c.model);
    const replies = [c.created, c.created, c.pending, c.done, c.failed];
    const calls = intercept(t, () => replies.shift());
    for (const assets of [[], [asset]]) {
      const params = { prompt, options: { durationSeconds: 5 }, ...(assets.length ? { assetIds: ['frame'] } : { ratio: '16:9' }) };
      api.validate(catalog.get(assets.length ? 'video.from-image' : 'video.compose'), params);
      assert.equal((await api.run({}, { parameters: params, assets })).id, jobId);
      const { body, url, headers } = calls.at(-1);
      assert.equal(url.pathname, assets.length ? c.create : c.create.replace('image-to-video', 'text-to-video'));
      assert.equal(headers.authorization, 'Bearer local-test');
      if (c.model === 'wan3.0-video') {
        assert.equal(headers['X-DashScope-Async'], 'enable');
        assert.deepEqual(body.input.media, assets.length ? [{ type: 'first_frame', url: dataUrl }] : undefined);
      } else if (c.model === 'kling-4.0') {
        assert.equal(body.settings.duration, 5);
        if (assets.length) assert.deepEqual(body.contents[1], { type: 'first_frame', id: 'start', url: png });
        else assert.equal(body.prompt, prompt);
      } else {
        assert.deepEqual(body.content[1], assets.length ? { type: 'image_url', role: 'first_frame', image_url: { url: dataUrl } } : undefined);
        if (c.model === 'MiniMax-H3') assert.equal(body.ratio, assets.length ? 'adaptive' : '16:9');
      }
    }
    assert.ok((await api.poll(jobId)) instanceof PendingModelJob);
    assert.equal((await api.poll(jobId)).url, videoUrl);
    await assert.rejects(api.poll(jobId), { code: 'VIDEO_GENERATION_FAILED' });
    for (const call of calls.slice(2)) {
      assert.equal(call.method, 'GET');
      assert.equal(call.url.pathname + call.url.search, c.query);
    }
    assert.throws(() => api.validate(catalog.get('video.compose'), { prompt, options: { durationSeconds: 1 } }), /秒/);
  });
}
