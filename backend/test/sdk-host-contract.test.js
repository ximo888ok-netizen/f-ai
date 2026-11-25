import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { manifest, overview } from '../sdk/examples/asset-inbox.mjs';
import { bindPluginV1, createWorkspaceHttpRequest, workspaceV1, WorkspaceHttpError } from '../sdk/workspace-v1.mjs';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';
import { provisionCredits } from '../src/wallet.js';

async function register(origin, email, type) {
  const response = await fetch(origin + '/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email, password: 'sdk-host-contract-fixture-42', displayName: email, type,
      ...(type === 'enterprise' ? { workspaceName: 'SDK host contract' } : {}),
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function expectApiError(result, statusCode, code, message) {
  await assert.rejects(result, error => {
    assert.ok(error instanceof WorkspaceHttpError);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    if (message) assert.equal(error.message, message);
    assert.match(error.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('trusted host facade interoperates with the authenticated workspace API over HTTP', async t => {
  const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
  let app;
  t.after(async () => {
    try {
      await app?.close();
    } finally {
      await db.close();
    }
  });
  await migrate(db);
  app = await buildApp({ db });
  let calls = 0;
  app.addHook('onRequest', async () => { calls++; });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const runId = randomUUID();
  const owner = await register(origin, 'sdk-host-owner+' + runId + '@example.test', 'enterprise');
  const member = await register(origin, 'sdk-host-member+' + runId + '@example.test', 'personal');
  const team = owner.workspaces[0].id;
  const personal = member.workspaces[0].id;
  const requestFor = (session, workspaceId) => createWorkspaceHttpRequest({
    origin, workspaceId, getToken: () => session.token,
  });

  const ownerRequest = requestFor(owner, team);
  const invitation = await ownerRequest('POST', '/v1/invitations', { email: member.account.email, role: 'member' });
  const memberRequest = requestFor(member, team);
  await memberRequest('POST', '/v1/invitations/accept', { token: invitation.token });

  const ownerSdk = workspaceV1(ownerRequest);
  const personalSdk = workspaceV1(requestFor(member, personal));
  const wrongWorkspaceSdk = workspaceV1(requestFor(owner, personal));
  await expectApiError(wrongWorkspaceSdk.assets(), 404, 'NOT_FOUND', 'Workspace not found');

  const grants = new Set([...manifest.permissions, 'assets.write', 'notifications.write', 'plugins.read', 'tasks.read', 'tasks.write']);
  let enabled = true;
  const isGranted = scope => enabled && grants.has(scope);
  const reader = bindPluginV1(memberRequest, manifest, isGranted);
  const writer = bindPluginV1(memberRequest, {
    sdkVersion: 1, permissions: ['assets.write', 'notifications.write', 'plugins.read', 'tasks.read', 'tasks.write'],
  }, isGranted);
  assert.deepEqual(Object.keys(reader).sort(), ['asset', 'assetContent', 'assets', 'notifications', 'version']);
  assert.ok(Object.isFrozen(reader));

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64');
  const input = { name: 'SDK pixel', mediaType: 'image/png', source: 'synthetic', purpose: 'contract', dataBase64: png.toString('base64') };
  await expectApiError(writer.uploadAsset({ ...input, dataBase64: 'bm90LXBuZw==' }), 400, 'INVALID_INPUT');
  const asset = await writer.uploadAsset(input);
  assert.deepEqual((await overview(reader)).recentAssets, [{ id: asset.id, name: 'SDK pixel' }]);
  assert.equal((await reader.asset(asset.id)).sha256, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(await reader.assetContent(asset.id), new Uint8Array(png));
  for (const sdk of [ownerSdk, personalSdk]) {
    assert.deepEqual((await sdk.assets()).items, []);
    await expectApiError(sdk.asset(asset.id), 404, 'NOT_FOUND', 'Asset not found');
    await expectApiError(sdk.assetContent(asset.id), 404, 'NOT_FOUND', 'Asset not found');
  }

  await provisionCredits(db, team, member.account.id, 2, 'sdk-host-contract');
  const taskInput = {
    capabilityId: 'copywriting.detect-terms', mode: 'workflow',
    parameters: { content: 'SDK host fixture' }, idempotencyKey: randomUUID(),
  };
  const task = await writer.submit(taskInput);
  assert.equal((await writer.task(task.id)).state, 'queued');
  assert.deepEqual((await writer.events(task.id, { limit: 1 })).items.map(event => event.event), ['queued']);
  for (const sdk of [ownerSdk, personalSdk]) {
    await expectApiError(sdk.task(task.id), 404, 'NOT_FOUND', 'Task not found');
    await expectApiError(sdk.events(task.id), 404, 'NOT_FOUND', 'Task not found');
    await expectApiError(sdk.cancel(task.id), 404, 'NOT_FOUND', 'Task not found');
  }

  const pluginState = '/v1/plugins/copywriting/state';
  await expectApiError(memberRequest('PUT', pluginState, { enabled: false }), 403, 'FORBIDDEN');
  await ownerRequest('PUT', pluginState, { enabled: false });
  const copywriting = (await writer.plugins()).items.find(plugin => plugin.id === 'copywriting');
  assert.equal(copywriting.enabled, false);
  assert.equal(copywriting.capabilities.find(item => item.id === taskInput.capabilityId).available, false);
  assert.equal((await personalSdk.plugins()).items.find(plugin => plugin.id === 'copywriting').enabled, true);
  await expectApiError(writer.submit({ ...taskInput, idempotencyKey: randomUUID() }), 409, 'PLUGIN_DISABLED');
  assert.equal((await writer.submit(taskInput)).id, task.id);
  assert.equal((await writer.cancel(task.id)).state, 'cancelled');
  assert.deepEqual((await writer.events(task.id)).items.map(event => event.event), ['cancelled', 'queued']);
  const regeneration = { idempotencyKey: randomUUID() };
  await expectApiError(writer.regenerate(task.id, regeneration), 409, 'PLUGIN_DISABLED');
  await ownerRequest('PUT', pluginState, { enabled: true });
  assert.equal((await writer.regenerate(task.id, regeneration)).parentId, task.id);

  const inbox = await reader.notifications();
  const notice = inbox.items.find(item => item.type === 'task.cancelled' && item.data.taskId === task.id);
  assert.equal(notice.readAt, null);
  for (const sdk of [ownerSdk, personalSdk]) {
    assert.ok(!(await sdk.notifications()).items.some(item => item.id === notice.id));
    await expectApiError(sdk.readNotification(notice.id), 404, 'NOT_FOUND', 'Notification not found');
  }
  assert.equal(await writer.readNotification(notice.id), undefined);
  const readInbox = await reader.notifications();
  assert.equal(readInbox.unread, inbox.unread - 1);
  assert.ok(readInbox.items.find(item => item.id === notice.id).readAt);

  const beforeRevocation = calls;
  grants.delete('assets.read');
  assert.throws(() => reader.assetContent(asset.id), { message: 'PLUGIN_PERMISSION_DENIED' });
  enabled = false;
  assert.throws(() => reader.notifications(), { message: 'PLUGIN_PERMISSION_DENIED' });
  assert.equal(calls, beforeRevocation);
  enabled = true;
  assert.equal((await reader.notifications()).unread, readInbox.unread);
  grants.add('assets.read');
  assert.equal((await reader.asset(asset.id)).id, asset.id);

  assert.equal(await memberRequest('POST', '/v1/auth/logout'), undefined);
  await expectApiError(reader.assets(), 401, 'UNAUTHENTICATED', 'A valid session is required');
});

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return 'http://127.0.0.1:' + server.address().port;
}

test('trusted transport rejects outside paths and never follows same-origin or cross-origin redirects', async t => {
  let intercepted = 0;
  const intercept = (req, reply) => {
    intercepted++;
    reply.writeHead(204).end();
  };
  const otherOrigin = await listen(t, intercept);
  const expectedRequests = [];
  const origin = await listen(t, async (req, reply) => {
    if (req.url === '/v1/capture') return intercept(req, reply);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    expectedRequests.push([req.headers.authorization, req.headers['x-workspace-id'], Buffer.concat(chunks).toString()]);
    const location = req.url === '/v1/same-origin' ? '/v1/capture' : otherOrigin + '/v1/capture';
    reply.writeHead(307, { location }).end();
  });

  const workspaceId = randomUUID();
  const token = 'sdk-fixture-token';
  let tokenReads = 0;
  const getToken = () => { tokenReads++; return token; };
  const request = createWorkspaceHttpRequest({ origin, workspaceId, getToken });
  assert.doesNotThrow(() => createWorkspaceHttpRequest({ origin: 'http://localhost:4000', workspaceId, getToken }));
  assert.throws(() => createWorkspaceHttpRequest({ origin: 'http://example.test', workspaceId, getToken }), TypeError);
  assert.throws(() => createWorkspaceHttpRequest({ origin: origin + '/v1', workspaceId, getToken }), TypeError);
  for (const path of [otherOrigin + '/v1/capture', '//127.0.0.1/v1/capture', '/v1/%2e%2e/capture']) {
    await assert.rejects(request('POST', path, { dataBase64: 'Zml4dHVyZQ==' }), TypeError);
  }
  assert.equal(tokenReads, 0);

  const payload = { dataBase64: 'Zml4dHVyZQ==' };
  for (const path of ['/v1/same-origin', '/v1/cross-origin']) {
    await assert.rejects(request('POST', path, payload), error => {
      assert.ok(error instanceof WorkspaceHttpError);
      assert.equal(error.code, 'TRANSPORT_ERROR');
      assert.equal(error.cause, undefined);
      assert.equal(error.message, 'Workspace API request failed');
      return true;
    });
  }
  assert.deepEqual(expectedRequests, Array.from({ length: 2 }, () => ['Bearer ' + token, workspaceId, JSON.stringify(payload)]));
  assert.equal(intercepted, 0);
});
