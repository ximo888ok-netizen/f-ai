import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog } from '../src/catalog.js';
import { installModels } from '../src/models.js';
import { startVideo } from '../src/model-video.js';
import { capabilitySignature } from '../src/tasks.js';
import { matchesTaskContract } from '../src/video-options.js';
import { videoLimits, videoTaskInput } from '../../前端设计审查/live-video-prompt-options.js';

function install(protocol, model, extra = {}) {
  return installModels(new Map(), [{ id: 'configured', protocol, model, baseUrl: 'http://localhost:4321', ...extra }])
    .get('model:configured');
}

test('queued video tasks retain their pre-upgrade contract while pricing and other policy changes invalidate it', () => {
  const oldSchema = catalog.get('video.reframe').parameters;
  for (const id of ['video.compose', 'video.from-image', 'video.reference']) {
    const cap = catalog.get(id);
    const previous = capabilitySignature({ ...cap, parameters: oldSchema });
    assert.equal(matchesTaskContract(id, previous, capabilitySignature(cap)), true);
    assert.equal(matchesTaskContract(id, previous, capabilitySignature({ ...cap, cost: cap.cost + 1 })), false);
    assert.equal(matchesTaskContract('video.export', previous, capabilitySignature(cap)), false);
  }
});

test('configured native video models expose per-mode options and preserve explicit silence on the wire', async () => {
  const cap = catalog.get('video.compose');
  const api = install('ark-video', 'doubao-seedance-2-5-flash-261115');
  const limits = videoLimits(api.info, 'text', cap);
  assert.equal(limits.max, 30);
  assert.deepEqual(limits.resolutions, ['480p', '720p']);
  assert.equal(limits.audio, true);
  assert.ok(limits.ratios.includes('21:9'));
  assert.deepEqual(videoLimits(api.info, 'frame', catalog.get('video.from-image')).ratios, []);
  const input = videoTaskInput({ capabilityId: cap.id, modelId: api.info.id, prompt: 'move',
    ratio: '21:9', duration: 29, resolution: '720p', audio: false });
  assert.deepEqual(input.parameters.options, { durationSeconds: 29, resolution: '720p', generateAudio: false });
  api.validate(cap, input.parameters);
  assert.throws(() => api.validate(cap, { prompt: 'move', options: { resolution: '4k' } }));
  assert.throws(() => api.validate(cap, { prompt: 'move', options: { durationSeconds: 31 } }));
  let body;
  await startVideo(api.info, { parameters: input.parameters, assets: [] }, async (_path, data) => { body = data; return { id: 'job' }; });
  assert.deepEqual([body.ratio, body.duration, body.resolution, body.generate_audio], ['21:9', 29, '720p', false]);
});

test('custom reference video mapping declares its discrete accepted values and rejects an unmapped option', () => {
  const mapping = { kind: 'video', createPath: 'render', outputFormat: 'url', outputPath: 'url',
    body: { prompt: { $from: 'prompt' }, refs: { $from: 'assets' }, args: { $from: 'parameters.options' } } };
  const spec = { ratios: [], resolutions: ['720p'], durations: [5, 12, 24], audio: true };
  const extra = { capabilities: ['video.reference'], mapping, videoOptions: { reference: spec } };
  const api = install('json-http', 'licensed-reference', extra);
  const cap = catalog.get('video.reference');
  const limits = videoLimits(api.info, 'reference', cap);
  assert.deepEqual(limits.durations, [5, 12, 24]);
  assert.deepEqual(limits.resolutions, ['720p']);
  assert.throws(() => api.validate(cap, { prompt: 'test', assetIds: ['ref'], options: { durationSeconds: 6 } }));
  assert.doesNotThrow(() => api.validate(cap, { prompt: 'test', assetIds: ['ref'], options: { durationSeconds: 24, generateAudio: false } }));
  assert.throws(() => install('json-http', 'broken', { ...extra, mapping: { ...mapping, body: { refs: mapping.body.refs } } }));
});

test('routes without advertised video options offer only model defaults', () => {
  const limits = videoLimits(undefined, 'text', catalog.get('video.compose'));
  assert.deepEqual([limits.ratios, limits.durations, limits.resolutions, limits.audio], [[], [], [], false]);
});

test('the native adapter uses each protocol’s case and audio field and rejects unavailable settings', async () => {
  const cap = catalog.get('video.compose');
  for (const [protocol, name, resolution, audio, upstreamResolution, max] of [
    ['wan3-video', 'wan3.0-video', '1080p', false, '1080P', 30],
    ['minimax-h3-video', 'MiniMax-H3-Max', '768p', false, '768P', 15],
    ['kling-video', 'kling-4.0-flash', '720p', undefined, '720p', 20],
  ]) {
    const api = install(protocol, name);
    const options = { resolution, durationSeconds: max, ...(audio === undefined ? {} : { generateAudio: audio }) };
    api.validate(cap, { prompt: 'move', options });
    assert.throws(() => api.validate(cap, { prompt: 'move', options: { ...options, durationSeconds: max + 1 } }));
    if (audio === undefined) assert.throws(() => api.validate(cap, { prompt: 'move', options: { generateAudio: false } }));
    let submitted;
    await startVideo(api.info, { parameters: { prompt: 'move', options }, assets: [] }, async (_path, body) => {
      submitted = body.parameters ?? body.settings ?? body;
      return { task_id: 'job', output: { task_id: 'job' }, code: 0, data: { id: 'job' } };
    });
    assert.equal(submitted.resolution, upstreamResolution);
    assert.equal(submitted.duration, max);
    assert.equal(submitted.generate_audio ?? submitted.audio, audio);
  }
});
