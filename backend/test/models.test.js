import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { config } from '../src/config.js';
import { catalog } from '../src/catalog.js';
import { createProviders, providerFor } from '../src/providers.js';
import { installModels } from '../src/models.js';
import { GeneratedFile } from '../src/model-file.js';
import { PendingModelJob } from '../src/model-http.js';

const catalogUrl = new URL('../model-providers.example.json', import.meta.url);
const presets = JSON.parse(await readFile(catalogUrl, 'utf8'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const env = { EXAMPLE_KEY: 'contract-test-key' };
const base = { id: 'test-route', baseUrl: 'https://models.example.test/version', model: 'test-model', keyEnv: 'EXAMPLE_KEY' };
function adapter(protocol, extra = {}) {
  const settings = { ...base, protocol, ...extra };
  return installModels(createProviders(), [settings], env).get('model:' + settings.id);
}
function payload(capabilityId, parameters, assets = []) {
  return { capabilityId, parameters, assets, mode: 'chat' };
}

function mockWire(t, responses) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options, json: typeof options.body === 'string' ? JSON.parse(options.body) : undefined });
    const next = responses.shift();
    assert.ok(next, 'unexpected upstream request');
    return next instanceof Response ? next : Response.json(next);
  });
  return requests;
}

test('presets can be loaded, disabled, filtered and validated without exposing credentials', () => {
  const secrets = Object.fromEntries(presets.filter(p => p.keyEnv).map(p => [p.keyEnv, env.EXAMPLE_KEY]));
  const parsed = config({ DATABASE_URL: 'postgres://unused', MODEL_PROVIDERS_JSON: JSON.stringify(presets) });
  assert.equal(installModels(createProviders(), parsed.models, {}).size, 1);
  const configured = installModels(createProviders(), presets.map(p => ({ ...p, enabled: true })), secrets);
  assert.equal(configured.size, presets.length + 1);
  const capability = catalog.get('copywriting.generate');
  assert.equal(providerFor(configured, capability), 'model:openai-chat');
  assert.equal(providerFor(configured, capability, 'kimi'), 'model:kimi');
  assert.throws(() => providerFor(configured, capability, 'hailuo'), { code: 'MODEL_NOT_SUPPORTED' });
  assert.throws(() => adapter('ollama-chat', { baseUrl: 'http://external.example' }), /baseUrl/);
  assert.throws(() => adapter('responses', { keyEnv: 'NO_SUCH_KEY' }), /Missing credentials/);
  assert.throws(() => adapter('responses', { capabilities: ['operations.publish'] }), /capabilities/);
  assert.throws(() => adapter('json-http', { mapping: { ...presets.at(-1).mapping, createPath: '../escape' } }), /mapping/);
  assert.throws(() => installModels(createProviders(), [base, base].map(item => ({ ...item, protocol: 'responses' })), env), /duplicate/);
});

const messages = [{ role: 'user', content: '商品名称？' }, { role: 'assistant', content: '茶杯' }, { role: 'user', content: '英文？' }];
const textCases = [
  ['chat-completions', 'chat/completions', { choices: [{ message: { content: 'cup' } }] }],
  ['responses', 'responses', { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'cup' }] }] }],
  ['anthropic-messages', 'messages', { content: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'cup' }] }],
  ['gemini-content', 'models/test-model:generateContent', { candidates: [{ content: { parts: [{ thought: true, text: 'internal' }, { text: 'cup' }] } }] }],
  ['cohere-chat', 'chat', { message: { content: [{ type: 'text', text: 'cup' }] } }],
  ['ollama-chat', 'chat', { message: { content: 'cup' } }],
];
for (const [protocol, path, output] of textCases) {
  test(protocol + ' sends three conversation turns and extracts visible text', async t => {
    const p = adapter(protocol);
    const requests = mockWire(t, [output]);
    const result = await p.run({}, payload('model.chat', { messages }));
    assert.deepEqual(result, { type: 'text', text: 'cup', modelId: base.id });
    const [request] = requests;
    assert.equal(request.url.href, base.baseUrl + '/' + path);
    assert.equal(request.redirect, 'error');
    if (protocol === 'anthropic-messages') {
      assert.equal(request.headers['x-api-key'], env.EXAMPLE_KEY);
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
    } else if (protocol === 'gemini-content') {
      assert.equal(request.headers['x-goog-api-key'], env.EXAMPLE_KEY);
      assert.equal(request.json.contents[1].role, 'model');
    } else assert.equal(request.headers.authorization, 'Bearer ' + env.EXAMPLE_KEY);
    assert.equal((request.json.messages ?? request.json.input ?? request.json.contents).length, 3);
    if (protocol === 'responses') assert.equal(request.json.store, false);
    if (protocol === 'ollama-chat') assert.equal(request.json.stream, false);
  });
}

test('image protocols generate and edit images with correct binary and multipart contracts', async t => {
  const requests = mockWire(t, [
    { data: [{ b64_json: png }] }, { data: [{ b64_json: png }] },
    { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] },
  ]);
  const asset = { mediaType: 'image/png', dataBase64: png };
  const openai = adapter('openai-images');
  const input = payload('image.main-image', { prompt: 'A ceramic cup', format: 'png', ratio: '1:1' });
  const generated = await openai.run({}, input);
  assert.ok(generated instanceof GeneratedFile);
  assert.equal(generated.bytes.toString('base64'), png);
  await openai.run({}, { ...input, assets: [asset] });
  assert.equal(requests[0].url.pathname, '/version/images/generations');
  assert.equal(requests[0].json.size, '1024x1024');
  assert.equal(requests[1].url.pathname, '/version/images/edits');
  assert.equal(requests[1].body.get('image').type, 'image/png');
  assert.equal(requests[1].headers['content-type'], undefined);
  const gemini = adapter('gemini-image');
  assert.equal((await gemini.run({}, { ...input, assets: [asset] })).mediaType, 'image/png');
  assert.equal(requests[2].json.contents[0].parts[1].inlineData.data, png);
});

const videoCases = [
  ['runway-video', { id: 'vid-1' }, { status: 'THROTTLED' }, { status: 'SUCCEEDED', output: ['https://media.test/a.mp4'] }, 'text_to_video', 'tasks/vid-1'],
  ['ark-video', { id: 'vid-1' }, { status: 'running' }, { status: 'succeeded', content: { video_url: 'https://media.test/a.mp4' } }, 'contents/generations/tasks', 'contents/generations/tasks/vid-1'],
  ['wan-video', { output: { task_id: 'vid-1' } }, { output: { task_status: 'PENDING' } }, { output: { task_status: 'SUCCEEDED', video_url: 'https://media.test/a.mp4' } }, 'services/aigc/video-generation/video-synthesis', 'tasks/vid-1'],
  ['minimax-video', { task_id: 'vid-1', base_resp: { status_code: 0 } }, { status: 'Queueing', base_resp: { status_code: 0 } }, new Response('{"status":"Success","file_id":12345678901234567890,"base_resp":{"status_code":0}}'), 'video_generation', 'query/video_generation?task_id=vid-1'],
];
for (const [protocol, create, pending, done, submitPath, pollPath] of videoCases) {
  test(protocol + ' submits once and resolves native poll states', async t => {
    const p = adapter(protocol);
    const requests = mockWire(t, [create, pending, done, { file: { download_url: 'https://media.test/a.mp4' }, base_resp: { status_code: 0 } }]);
    const job = await p.run({}, payload('video.compose', { prompt: 'cup', options: { durationSeconds: 6 } }));
    assert.ok(job instanceof PendingModelJob);
    assert.equal((await p.poll(job.id)).id, job.id);
    assert.deepEqual(await p.poll(job.id), { type: 'video', url: 'https://media.test/a.mp4', modelId: base.id });
    assert.equal(requests[0].url.href, base.baseUrl + '/' + submitPath);
    assert.equal(requests[1].url.href, base.baseUrl + '/' + pollPath);
    assert.equal(requests.filter(r => r.method === 'POST').length, 1);
    if (protocol === 'wan-video') assert.equal(requests[0].headers['X-DashScope-Async'], 'enable');
    if (protocol === 'minimax-video') assert.equal(requests[3].url.searchParams.get('file_id'), '12345678901234567890');
  });
}

test('mapped Replicate and fal presets support one-step and two-step result retrieval', async t => {
  const requests = mockWire(t, [
    { id: 'prediction-1' }, { status: 'succeeded', output: ['https://media.test/one.png'] },
    { request_id: 'job-2' }, { status: 'COMPLETED' }, { images: [{ url: 'https://media.test/two.png' }] },
  ]);
  for (const preset of presets.slice(-2)) {
    const p = adapter('json-http', { ...preset, enabled: true, keyEnv: 'EXAMPLE_KEY' });
    assert.throws(() => p.validate(catalog.get('image.main-image'), { prompt: 'cup', format: 'psd' }), { code: 'INVALID_INPUT' });
    const job = await p.run({}, payload('image.main-image', { prompt: 'cup' }));
    assert.ok((await p.poll(job.id)).url.startsWith('https://media.test/'));
  }
  assert.equal(requests[0].json.input.prompt, 'cup');
  assert.equal(requests[2].headers.authorization, 'Key ' + env.EXAMPLE_KEY);
  assert.equal(requests[4].url.pathname, '/fal-ai/flux/requests/job-2');
});

test('audio, embeddings and ranking adapters map upstream payloads to bounded typed results', async t => {
  const requests = mockWire(t, [
    { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] },
    { results: [{ index: 1, relevance_score: 0.91 }] },
    new Response(Buffer.from('ID3audio')), { text: '茶杯' },
  ]);
  assert.deepEqual((await adapter('openai-embeddings').run({}, payload('model.embed', { input: ['a','b'] }))).vectors, [[1,2],[3,4]]);
  assert.deepEqual((await adapter('cohere-rerank').run({}, payload('model.rerank', { query: 'q', documents: ['a','b'], topN: 1 }))).results, [{ index: 1, score: 0.91 }]);
  const speech = await adapter('openai-speech').run({}, payload('model.speech', { input: '茶杯', voice: 'alloy' }));
  assert.equal(speech.mediaType, 'audio/mpeg');
  const asr = await adapter('openai-transcription').run({}, payload('model.transcribe', { language: 'zh' }, [{ mediaType: speech.mediaType, dataBase64: speech.bytes.toString('base64') }]));
  assert.equal(asr.text, '茶杯');
  assert.equal(requests[3].body.get('language'), 'zh');
  assert.equal(requests[3].body.get('file').type, 'audio/mpeg');
});

test('ambiguous creation failures, explicit rejections and invalid returned media are distinguishable', async t => {
  mockWire(t, [new Response(null, { status: 503 }), new Response(null, { status: 429 }), { data: [{ url: 'javascript:alert(1)' }] }]);
  const p = adapter('openai-images');
  const input = payload('image.main-image', { prompt: 'cup' });
  await assert.rejects(p.run({}, input), { code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: false });
  await assert.rejects(p.run({}, input), { code: 'PROVIDER_REJECTED', retryable: true });
  await assert.rejects(p.run({}, input), { code: 'INVALID_PROVIDER_RESULT' });
});
