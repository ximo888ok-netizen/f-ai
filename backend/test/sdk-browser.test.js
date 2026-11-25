import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';

const playwrightPath = process.env.FAI_TEST_PLAYWRIGHT_PATH;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64');

async function serveHost(sdkModule) {
  const server = createServer((request, reply) => {
    if (request.url === '/') {
      reply.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Local SDK host fixture</title>');
    } else if (request.url === '/workspace-v1.mjs') {
      reply.writeHead(200, { 'content-type': 'text/javascript' }).end(sdkModule);
    } else if (request.url === '/pixel.png') {
      reply.writeHead(200, { 'content-type': 'image/png' }).end(pixel);
    } else {
      reply.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

test('the browser SDK exchanges assets with an allowed host and blocks an unlisted origin',
  { skip: !playwrightPath, timeout: 60000 }, async t => {
    const sdkModule = await readFile(new URL('../sdk/workspace-v1.mjs', import.meta.url));
    const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
    let app, browser, trustedHost, unlistedHost;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        try {
          await Promise.all([
            trustedHost?.server[Symbol.asyncDispose](), unlistedHost?.server[Symbol.asyncDispose](), app?.close(),
          ]);
        } finally {
          await db.close();
        }
      }
    });
    trustedHost = await serveHost(sdkModule);
    unlistedHost = await serveHost(sdkModule);
    const trustedOrigin = trustedHost.origin;
    const unlistedOrigin = unlistedHost.origin;
    await migrate(db);
    app = await buildApp({ db, origins: [trustedOrigin] });
    const deniedMethods = [];
    app.server.prependListener('request', request => {
      if (request.headers.origin === unlistedOrigin) deniedMethods.push(request.method);
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const registration = await fetch(origin + '/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: randomUUID() + '@example.test', password: 'sdk-browser-fixture-42',
        displayName: 'SDK browser fixture', type: 'personal',
      }),
    });
    assert.equal(registration.status, 201);
    const session = await registration.json();
    const config = { origin, workspaceId: session.workspaces[0].id, token: session.token };
    browser = await createRequire(import.meta.url)(playwrightPath).chromium.launch({ channel: 'chrome', headless: true });
    const trusted = await browser.newPage();
    const unlisted = await browser.newPage();
    const requests = [];
    for (const page of [trusted, unlisted]) {
      page.on('request', request => requests.push(request.url()));
    }

    await trusted.goto(trustedOrigin);
    const [downloadResponse, result] = await Promise.all([
      trusted.waitForResponse(response => response.url().startsWith(origin + '/v1/assets/') &&
        response.url().endsWith('/content') && response.request().method() === 'GET'),
      trusted.evaluate(async ({ origin, workspaceId, token }) => {
        const { bindPluginV1, createWorkspaceHttpRequest } = await import('/workspace-v1.mjs');
        const request = createWorkspaceHttpRequest({ origin, workspaceId, getToken: () => token });
        const permissions = ['assets.write', 'assets.read'];
        const sdk = bindPluginV1(request, { sdkVersion: 1, permissions }, scope => permissions.includes(scope));
        const fixture = new Uint8Array(await (await fetch('/pixel.png')).arrayBuffer());
        const asset = await sdk.uploadAsset({
          name: 'Browser SDK pixel', mediaType: 'image/png', source: 'synthetic', purpose: 'browser acceptance',
          dataBase64: btoa(String.fromCharCode(...fixture)),
        });
        const metadata = await sdk.asset(asset.id);
        const bytes = await sdk.assetContent(asset.id);
        const response = await fetch(origin + '/v1/assets/' + asset.id + '/content', {
          headers: { authorization: 'Bearer ' + token, 'x-workspace-id': workspaceId },
        });
        return {
          id: metadata.id, metadataDigest: metadata.sha256, exposedDigest: response.headers.get('x-content-sha256'),
          isUint8Array: bytes instanceof Uint8Array, bytes: Array.from(bytes),
        };
      }, config),
    ]);
    const digest = createHash('sha256').update(pixel).digest('hex');
    assert.equal(result.metadataDigest, digest);
    assert.equal(result.exposedDigest, digest);
    assert.equal(result.isUint8Array, true);
    assert.deepEqual(result.bytes, [...pixel]);
    assert.equal(downloadResponse.url(), origin + '/v1/assets/' + result.id + '/content');
    assert.equal(downloadResponse.status(), 200);
    const headers = await downloadResponse.allHeaders();
    assert.equal(headers['access-control-allow-origin'], trustedOrigin);
    assert.equal(headers['content-type'], 'image/png');
    assert.equal(headers['content-disposition'], 'attachment');
    assert.equal(headers['cache-control'], 'no-store');
    const requestHeaders = await downloadResponse.request().allHeaders();
    assert.ok(requestHeaders.authorization === 'Bearer ' + config.token, 'the SDK sends the session in Authorization');
    assert.equal(requestHeaders['x-workspace-id'], config.workspaceId);
    assert.equal(requestHeaders.referer, undefined);

    await unlisted.goto(unlistedOrigin);
    const denied = await unlisted.evaluate(async ({ origin, workspaceId, token, id }) => {
      const { createWorkspaceHttpRequest, workspaceV1 } = await import('/workspace-v1.mjs');
      const request = createWorkspaceHttpRequest({ origin, workspaceId, getToken: () => token });
      try {
        await workspaceV1(request).assetContent(id);
      } catch (error) {
        return { name: error.name, code: error.code, statusCode: error.statusCode };
      }
    }, { ...config, id: result.id });
    assert.deepEqual(denied, { name: 'WorkspaceHttpError', code: 'TRANSPORT_ERROR', statusCode: undefined });
    assert.deepEqual(deniedMethods, ['OPTIONS']);
    assert.ok(requests.every(url => !decodeURIComponent(url).includes(config.token)), 'the session never appears in a browser URL');
  });
