
import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog } from '../src/catalog.js';
import { createProviders, providerFor } from '../src/providers.js';

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
    return new Response(JSON.stringify({ result: { status: 'done' } }));
  });
  const gateway = createProviders(gatewaySettings).get('gateway');
  const task = { id: 'task-id' };
  const input = { capabilityId: capability.id, assets: [] };
  assert.deepEqual(await gateway.run(task, input), { status: 'done' });
  fetcher.mock.mockImplementation(async () => new Response(null, { status: 429 }));
  await assert.rejects(gateway.run(task, input), { code: 'PROVIDER_REJECTED', retryable: true });
  fetcher.mock.mockImplementation(async () => new Response(null, { status: 403 }));
  await assert.rejects(gateway.run(task, input), { code: 'PROVIDER_REJECTED', retryable: false });
  fetcher.mock.mockImplementation(async () => new Response(JSON.stringify({ result: [] })));
  await assert.rejects(gateway.run(task, input), { code: 'INVALID_PROVIDER_RESULT' });
  fetcher.mock.mockImplementation(async () => new Response('x'.repeat(512 * 1024 + 1)));
  await assert.rejects(gateway.run(task, input), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
});
