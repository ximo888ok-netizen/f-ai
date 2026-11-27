
import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog } from '../src/catalog.js';
import { createProviders, providerFor } from '../src/providers.js';
import { createVideoArchive } from '../src/video-archive.js';

const capability = catalog.get('image.main-image');
const gatewaySettings = { url: 'https://example.test/run', token: 'test-gateway-key', capabilities: [capability.id] };

test('providers require explicit HTTPS configuration and allow-listed capabilities', () => {
  assert.throws(() => createProviders({ ...gatewaySettings, url: 'http://example.test/run' }), /HTTPS/);
  assert.throws(() => createProviders({ ...gatewaySettings, token: '' }), /configured together/);
  assert.throws(() => providerFor(createProviders(), capability), { code: 'CAPABILITY_UNAVAILABLE' });
  const providers = createProviders(gatewaySettings);
  assert.equal(providerFor(providers, capability), 'gateway');
  assert.throws(() => providerFor(providers, catalog.get('video.compose')), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('gateway sends a stable idempotency key and validates outcomes without following redirects', async t => {
  const fetcher = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, gatewaySettings.url);
    assert.equal(options.headers.authorization, 'Bearer ' + gatewaySettings.token);
    assert.equal(options.headers['idempotency-key'], 'task-id');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { capabilityId: capability.id, assets: [] });
    return Response.json({ result: { type:'image', url:'https://outputs.example.test/product.png' } });
  });
  const gateway = createProviders(gatewaySettings).get('gateway');
  const task = { id: 'task-id' };
  const input = { capabilityId: capability.id, assets: [] };
  assert.deepEqual(await gateway.run(task, input), { type:'image', url:'https://outputs.example.test/product.png' });
  for (const result of [{}, {status:'done'}, {type:'video',url:'https://outputs.example.test/video.mp4'}, {type:'image',url:''}]) {
    fetcher.mock.mockImplementation(async () => Response.json({result}));
    await assert.rejects(gateway.run(task,input), {code:'INVALID_PROVIDER_RESULT'});
  }
  fetcher.mock.mockImplementation(async () => new Response(null, { status: 429 }));
  await assert.rejects(gateway.run(task, input), { code: 'PROVIDER_REJECTED', retryable: true });
  fetcher.mock.mockImplementation(async () => new Response(null, { status: 403 }));
  await assert.rejects(gateway.run(task, input), { code: 'PROVIDER_REJECTED', retryable: false });
  fetcher.mock.mockImplementation(async () => new Response(JSON.stringify({ result: [] })));
  await assert.rejects(gateway.run(task, input), { code: 'INVALID_PROVIDER_RESULT' });
  fetcher.mock.mockImplementation(async () => new Response('x'.repeat(512 * 1024 + 1)));
  await assert.rejects(gateway.run(task, input), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
});

test('video archiving rejects other sources and treats unavailable or non-MP4 results as a fallback', async t => {
  assert.equal(createVideoArchive([]),null);
  const allowed='https://media.example.test';
  const fetcher = t.mock.method(globalThis,'fetch',async (url,options) => {
    assert.equal(options.redirect,'error');
    assert.equal(options.method,'GET');
    assert.equal(options.headers,undefined);
    return new Response('not a video');
  });
  const archive = createVideoArchive([allowed]);
  for (const url of ['http://media.example.test/a',allowed+'.invalid/a','https://name@media.example.test/a']) {
    assert.deepEqual(await archive(url),{status:'not_allowed'});
  }
  assert.equal(fetcher.mock.callCount(),0);
  assert.deepEqual(await archive(allowed+'/a'),{status:'failed'});
  assert.equal(fetcher.mock.callCount(),1);
  fetcher.mock.mockImplementation(async () => new Response(null,{status:503}));
  assert.deepEqual(await archive(allowed+'/a'),{status:'failed'});
});
