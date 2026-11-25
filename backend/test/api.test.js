
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { installModels } from '../src/models.js';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';
import { createProviders, ProviderError } from '../src/providers.js';
import { dispatchSchedule } from '../src/schedules.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';
import { createVideoArchive } from '../src/video-archive.js';

const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
const providers = createProviders();
const shops = new Map();
const received = [];
let app;
let enterprise;
let personal;
let other;

function response(result, status) {
  assert.equal(result.statusCode, status, result.body);
  return status === 204 ? undefined : result.json();
}

function api(method, url, account = null, payload = undefined, workspace = account?.workspaces[0].id) {
  const headers = account ? { authorization: 'Bearer ' + account.token } : {};
  if (workspace) headers['x-workspace-id'] = workspace;
  return app.inject({ method, url, headers, payload });
}

const taskInput = (key, overrides = {}) => ({
  capabilityId: 'copywriting.detect-terms', parameters: { content: '😀第一，100%最好' },
  mode: 'workflow', idempotencyKey: key, ...overrides,
});

before(async () => {
  await migrate(db);
  await migrate(db);
  providers.set('gateway', {
    supports: capability => ['image.try-on', 'image.main-image', 'operations.publish'].includes(capability.id),
    async run(task, payload) {
      received.push({ taskId: task.id, payload });
      if (payload.parameters.prompt === 'temporary') throw new ProviderError('UPSTREAM_TEMPORARY', true);
      return { ok: true };
    },
  });
  app = await buildApp({ db, providers, shops, origins: ['http://localhost:5173'] });
  await app.ready();
  enterprise = response(await api('POST', '/v1/auth/register', null, {
    email: 'owner@example.test', password: 'test-password-1', displayName: 'Owner', type: 'enterprise', workspaceName: 'Store',
  }), 201);
  personal = response(await api('POST', '/v1/auth/register', null, {
    email: 'member@example.test', password: 'test-password-2', displayName: 'Member', type: 'personal',
  }), 201);
  other = response(await api('POST', '/v1/auth/register', null, {
    email: 'other@example.test', password: 'test-password-3', displayName: 'Other', type: 'personal',
  }), 201);
});

after(async () => {
  await app?.close();
  await db.close();
});

test('health, OpenAPI, CORS, authorization and request validation', async () => {
  assert.deepEqual(response(await api('GET', '/health'), 200), { status: 'ok' });
  assert.deepEqual(response(await api('GET', '/ready'), 200), { status: 'ready' });
  const spec = response(await api('GET', '/openapi.json'), 200);
  assert.ok(spec.components.securitySchemes.bearerAuth);
  assert.ok(spec.paths['/v1/tasks'].post.responses['202']);
  assert.ok(spec.paths['/v1/knowledge/search'].post);
  assert.ok(spec.paths['/v1/customer-service/conversations/{id}/handoff'].post);
  response(await api('GET', '/v1/projects'), 400);
  response(await api('GET', '/v1/auth/me'), 401);
  response(await api('GET', '/v1/projects', other, undefined, enterprise.workspaces[0].id), 404);
  response(await api('POST', '/v1/projects', enterprise, { name: 'Test', malicious: true }), 400);
  response(await api('GET', '/v1/projects?limit=1&offset=0', enterprise), 200);
  const preflight = await app.inject({
    method: 'OPTIONS', url: '/v1/tasks', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
});

test('login normalizes email and logout revokes session', async () => {
  const session = response(await api('POST', '/v1/auth/login', null, {
    email: 'OWNER@example.test', password: 'test-password-1',
  }), 200);
  assert.equal(session.account.id, enterprise.account.id);
  response(await api('POST', '/v1/auth/logout', session), 204);
  response(await api('GET', '/v1/auth/me', session), 401);
  response(await api('POST', '/v1/auth/login', null, { email: 'owner@example.test', password: 'invalid-password' }), 401);
});

test('accepted invitation limits project and knowledge access to explicit grants', async () => {
  const workspaceId = enterprise.workspaces[0].id;
  const { token } = response(await api('POST', '/v1/invitations', enterprise, { email: personal.account.email, role: 'member' }), 201);
  response(await api('POST', '/v1/invitations/accept', other, { token }), 404);
  response(await api('POST', '/v1/invitations/accept', personal, { token }), 200);
  response(await api('POST', '/v1/invitations/accept', personal, { token }), 404);
  response(await api('POST', '/v1/projects', personal, { name: 'forbidden' }, workspaceId), 403);
  const project = response(await api('POST', '/v1/projects', enterprise, { name: 'Campaign' }), 201);
  response(await api('GET', '/v1/projects/' + project.id, personal, undefined, workspaceId), 404);
  response(await api('PUT', '/v1/projects/' + project.id + '/members/' + personal.account.id, enterprise), 204);
  response(await api('GET', '/v1/projects/' + project.id, personal, undefined, workspaceId), 200);
  response(await api('PATCH', '/v1/projects/' + project.id, enterprise, { state: 'archived' }), 200);
  assert.equal(response(await api('GET', '/v1/projects', enterprise), 200).items.length, 0);
  const first = response(await api('POST', '/v1/knowledge/bases', enterprise, { name: 'A' }), 201);
  const second = response(await api('POST', '/v1/knowledge/bases', enterprise, { name: 'B' }), 201);
  const upload = id => '/v1/knowledge/bases/' + id + '/documents';
  const allowed = response(await api('POST', upload(first.id), enterprise, { name: 'Manual A', content: '蓝色商品的货号为 A01' }), 201);
  response(await api('POST', upload(second.id), enterprise, { name: 'Manual B', content: '蓝色商品的货号为 B02' }), 201);
  response(await api('PUT', '/v1/knowledge/bases/' + first.id + '/grants/' + personal.account.id, enterprise), 204);
  const search = '/v1/knowledge/search';
  assert.equal(response(await api('POST', search, personal, { query: '蓝色' }, workspaceId), 200).items[0].baseId, first.id);
  response(await api('POST', search, personal, { query: '蓝色', baseIds: [second.id] }, workspaceId), 404);
  response(await api('GET', upload(second.id), personal, undefined, workspaceId), 404);
  response(await api('DELETE', upload(first.id) + '/' + allowed.id, enterprise), 204);
  assert.deepEqual(response(await api('POST', search, personal, { query: '蓝色' }, workspaceId), 200).items, []);
});

test('allocates and reserves credits once, settles success, and releases cancellation', async () => {
  const workspaceId = enterprise.workspaces[0].id;
  await provisionCredits(db, workspaceId, enterprise.account.id, 30, 'fund-001');
  await provisionCredits(db, workspaceId, enterprise.account.id, 30, 'fund-001');
  const allocation = { memberId: personal.account.id, amount: 6, reference: 'allocate-001' };
  assert.equal(response(await api('POST', '/v1/credits/allocate', enterprise, allocation), 200).balance, 24);
  assert.equal(response(await api('POST', '/v1/credits/allocate', enterprise, allocation), 200).balance, 24);
  response(await api('POST', '/v1/credits/allocate', enterprise, { ...allocation, amount: 5 }), 409);
  const task = response(await api('POST', '/v1/tasks', enterprise, taskInput('test-success')), 202);
  assert.equal(task.state, 'queued');
  assert.equal(task.result, null);
  assert.equal(response(await api('POST', '/v1/tasks', enterprise, taskInput('test-success')), 200).id, task.id);
  response(await api('POST', '/v1/tasks', enterprise, taskInput('test-success', { mode: 'chat' })), 409);
  response(await api('GET', '/v1/tasks/' + task.id, personal, undefined, workspaceId), 404);
  assert.equal(response(await api('GET', '/v1/credits/wallet', enterprise), 200).reserved, 1);
  assert.equal(await workOnce({ db, providers, shops }), true);
  const finished = response(await api('GET', '/v1/tasks/' + task.id, enterprise), 200);
  assert.equal(finished.state, 'succeeded');
  assert.deepEqual(finished.result.matches.map(match => match.start), [2, 5, 9]);
  assert.deepEqual(response(await api('GET', '/v1/credits/wallet', enterprise), 200), { balance: 23, reserved: 0, available: 23 });
  const regen = response(await api('POST', '/v1/tasks/' + task.id + '/regenerate', enterprise, { idempotencyKey: 'regenerate-01' }), 202);
  assert.equal(regen.parentId, task.id);
  response(await api('POST', '/v1/tasks/' + regen.id + '/cancel', enterprise), 200);
  response(await api('POST', '/v1/tasks/' + regen.id + '/cancel', enterprise), 200);
  const notifications = response(await api('GET', '/v1/notifications', enterprise), 200);
  assert.equal(notifications.unread, 2);
  response(await api('POST', '/v1/notifications/read-all', enterprise), 204);
  assert.equal(response(await api('GET', '/v1/notifications', enterprise), 200).unread, 0);
});

test('gateway limits, plugin disablement, retry exhaustion and release', async () => {
  response(await api('POST', '/v1/tasks', enterprise, taskInput('bad-shape', { parameters: { wrong: 'x' } })), 400);
  response(await api('POST', '/v1/tasks', enterprise, taskInput('not-configured', { capabilityId: 'video.compose', parameters: {} })), 503);
  const catalog = response(await api('GET', '/v1/plugins', enterprise), 200).items;
  assert.equal(catalog.length, 5);
  assert.equal(catalog.flatMap(plugin => plugin.capabilities).length, 44);
  assert.equal(catalog.find(plugin => plugin.id === 'customer-service').capabilities[0].endpoint, '/v1/customer-service/conversations/{id}/messages');
  response(await api('PUT', '/v1/plugins/copywriting/state', enterprise, { enabled: false }), 200);
  response(await api('POST', '/v1/tasks', enterprise, taskInput('disabled-task')), 409);
  response(await api('PUT', '/v1/plugins/copywriting/state', enterprise, { enabled: true }), 200);
  const task = response(await api('POST', '/v1/tasks', enterprise, taskInput('retry-test', {
    capabilityId: 'image.main-image', parameters: { prompt: 'temporary' },
  })), 202);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await workOnce({ db, providers, shops }), true);
    await db.query('UPDATE tasks SET available_at = now() WHERE id = $1', [task.id]);
  }
  const failed = response(await api('GET', '/v1/tasks/' + task.id, enterprise), 200);
  assert.equal(failed.attempts, 3);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.errorCode, 'UPSTREAM_TEMPORARY');
  assert.deepEqual(response(await api('GET', '/v1/credits/wallet', enterprise), 200), { balance: 23, reserved: 0, available: 23 });
});

test('asset consent and operation confirmations are scoped and rechecked', async () => {
  const assetBody = {
    name: 'photo.png', source: 'authorized internal sample', purpose: 'product preview', mediaType: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
  };
  const upload = async overrides => response(await api('POST', '/v1/assets', enterprise, { ...assetBody, ...overrides }), 201);
  const a = await upload({});
  const b = await upload({ name: 'another.png' });
  response(await api('GET', '/v1/assets/' + a.id + '/content', other), 404);
  const download=await api('GET','/v1/assets/'+a.id+'/content',enterprise);
  assert.equal(download.statusCode,200);
  const info=response(await api('GET','/v1/assets/'+a.id,enterprise),200);
  assert.match(info.sha256,/^[a-f0-9]{64}$/);
  assert.equal(info.sha256,download.headers['x-content-sha256']);
  response(await api('GET','/v1/assets/'+a.id,other),404);
  const denied = response(await api('POST', '/v1/tasks', enterprise, taskInput('without-consent', {
    capabilityId: 'image.try-on', parameters: { assetIds: [a.id, b.id] },
  })), 422);
  assert.equal(denied.error.code, 'CONSENT_REQUIRED');

  const shopId = randomUUID();
  const workspaceId = enterprise.workspaces[0].id;
  shops.set(shopId, { id: shopId, workspaceId, platform: 'taobao', name: 'Demo shop', gatewayReference: 'store-test', capabilities: ['operations.publish'] });
  const parameters = {
    shopId, platform: 'taobao', listing: { title: 'Example', categoryId: 'a', description: 'Example listing', assetIds: [a.id], variants: [{ sku: '1', priceMinor: 100, stock: 5 }] },
  };
  const create = taskInput('shop-publish', { capabilityId: 'operations.publish', parameters });
  response(await api('POST', '/v1/tasks', enterprise, create), 409);
  response(await api('POST', '/v1/shops/previews', personal, { capabilityId: create.capabilityId, parameters }, workspaceId), 403);
  const preview = response(await api('POST', '/v1/shops/previews', enterprise, { capabilityId: create.capabilityId, parameters }), 201);
  const confirmationId = preview.confirmationId;
  response(await api('POST', '/v1/tasks', enterprise, {
    ...create, confirmationId, parameters: { ...parameters, listing: { ...parameters.listing, title: 'Changed' } },
  }), 409);
  const queued = response(await api('POST', '/v1/tasks', enterprise, { ...create, confirmationId }), 202);
  response(await api('POST', '/v1/tasks', enterprise, { ...create, confirmationId, idempotencyKey: 'reuse-confirmation' }), 409);
  await workOnce({ db, providers, shops });
  const result = response(await api('GET', '/v1/tasks/' + queued.id, enterprise), 200);
  assert.equal(result.state, 'succeeded');
  const outgoing = received.find(entry => entry.taskId === queued.id).payload;
  assert.equal(outgoing.shopReference, 'store-test');
  assert.equal(outgoing.parameters.shopId, undefined);
  assert.equal(outgoing.parameters.listing.assetIds, undefined);
  assert.equal(outgoing.assets.length, 1);

  const nextPreview = response(await api('POST', '/v1/shops/previews', enterprise, { capabilityId: create.capabilityId, parameters }), 201);
  const rebinding = { ...create, confirmationId: nextPreview.confirmationId, idempotencyKey: 'shop-binding-change' };
  const initialShop = shops.get(shopId);
  shops.set(shopId, { ...initialShop, gatewayReference: 'another-store' });
  response(await api('POST', '/v1/tasks', enterprise, rebinding), 409);
  shops.set(shopId, initialShop);
  const pending = response(await api('POST', '/v1/tasks', enterprise, rebinding), 202);
  shops.set(shopId, { ...initialShop, gatewayReference: 'another-store' });
  await workOnce({ db, providers, shops });
  const stopped = response(await api('GET', '/v1/tasks/' + pending.id, enterprise), 200);
  assert.equal(stopped.errorCode, 'SHOP_BINDING_CHANGED');
  assert.equal(received.some(entry => entry.taskId === pending.id), false);
  // A grant can expire after a valid preview and submission, before the worker runs.
  shops.set(shopId, initialShop);
  const grant = response(await api('POST','/v1/shops/previews',enterprise,{capabilityId:create.capabilityId,parameters}),201);
  const accepted = response(await api('POST','/v1/tasks',enterprise,{...create,confirmationId:grant.confirmationId,idempotencyKey:'shop-expired-after-queue'}),202);
  const expired=new Date(Date.now()-60000).toISOString();
  shops.set(shopId,{...initialShop,authorizedUntil:expired});
  const listed=response(await api('GET','/v1/shops',enterprise),200).items.find(s=>s.id===shopId);
  assert.deepEqual(listed.capabilities,[]);assert.equal(listed.authorizedUntil,expired);
  assert.equal(response(await api('POST','/v1/shops/previews',enterprise,{capabilityId:create.capabilityId,parameters}),403).error.code,'SHOP_AUTH_EXPIRED');
  await workOnce({db,providers,shops});
  assert.equal(response(await api('GET','/v1/tasks/'+accepted.id,enterprise),200).errorCode,'SHOP_AUTH_EXPIRED');
  assert.equal(received.some(entry=>entry.taskId===accepted.id),false);
  shops.set(shopId,initialShop);

});

test('personal and enterprise memory stay isolated and preferences persist', async () => {
  const workspace = enterprise.workspaces[0].id;
  response(await api('POST', '/v1/memory', enterprise, { scope: 'personal', content: 'owner only' }), 201);
  response(await api('POST', '/v1/memory', enterprise, { scope: 'enterprise', content: 'shared' }), 201);
  assert.deepEqual(response(await api('GET', '/v1/memory?scope=personal', personal, undefined, workspace), 200).items, []);
  assert.equal(response(await api('GET', '/v1/memory?scope=enterprise', personal, undefined, workspace), 200).items[0].content, 'shared');
  response(await api('GET', '/v1/memory?scope=enterprise', personal), 403);
  response(await api('PATCH', '/v1/settings', enterprise, { theme: 'dark' }), 200);
  response(await api('PATCH', '/v1/settings', enterprise, { doNotDisturb: true }), 200);
  assert.deepEqual(response(await api('GET', '/v1/settings', enterprise), 200).preferences, { theme: 'dark', doNotDisturb: true });
});

test('customer assistant uses scoped knowledge and respects human takeover', async () => {
  const workspace = enterprise.workspaces[0].id;
  const base = response(await api('POST', '/v1/knowledge/bases', enterprise, { name: 'Support' }), 201);
  const index = '/v1/knowledge/bases/' + base.id;
  response(await api('POST', index + '/documents', enterprise, {
    name: 'Return policy', content: '退货需要订单凭证。此文件用于联调。',
  }), 201);
  const create = { subject: '退货', knowledgeBaseIds: [base.id] };
  const conversations = '/v1/customer-service/conversations';
  response(await api('POST', conversations, personal, create, workspace), 404);
  response(await api('PUT', index + '/grants/' + personal.account.id, enterprise), 204);
  const conversation = response(await api('POST', conversations, personal, create, workspace), 201);
  const basePath = conversations + '/' + conversation.id;
  const messages = basePath + '/messages';
  const first = response(await api('POST', messages, personal, { content: '怎么退货？', search: '退货' }, workspace), 201);
  assert.equal(first.assistant.sources[0].baseId, base.id);
  const second = response(await api('POST', messages, personal, { content: '需要什么？' }, workspace), 201);
  assert.equal(second.assistant.sources[0].baseId, base.id);
  response(await api('GET', messages, other), 404);
  response(await api('POST', basePath + '/handoff', personal, undefined, workspace), 403);
  response(await api('DELETE', index + '/grants/' + personal.account.id, enterprise), 204);
  const revoked = response(await api('POST', messages, personal, { content: '怎么退货？', search: '退货' }, workspace), 201);
  assert.equal(revoked.assistant, null);
  assert.equal(response(await api('POST', basePath + '/handoff', enterprise), 200).state, 'human');
  const human = response(await api('POST', messages, personal, { content: '人工响应？' }, workspace), 201);
  assert.equal(human.assistant, null);
  response(await api('POST', messages, personal, { content: '冒充客服', sender: 'operator' }, workspace), 403);
  response(await api('POST', messages, enterprise, { content: '请提供订单编号。', sender: 'operator' }), 201);
  assert.equal(response(await api('GET', messages, personal, undefined, workspace), 200).items.at(-1).sender, 'operator');
  const quick = '/v1/customer-service/quick-replies';
  const reply = response(await api('POST', quick, enterprise, { title: '询问', scenario: 'return', content: '请提供订单编号。' }), 201);
  assert.equal(response(await api('PUT', quick + '/' + reply.id, enterprise, { title: '新询问', scenario: 'return', content: '请提供订单凭证。' }), 200).revision, 2);
  assert.equal(response(await api('GET', quick + '?scenario=return', personal, undefined, workspace), 200).items[0].id, reply.id);
});

test('schedules dispatch once, expose failures and forbid unattended shop mutations', async () => {
  const runAt = new Date(Date.now() + 60000).toISOString();
  const input = { runAt, idempotencyKey: 'schedule-test', capabilityId: 'copywriting.detect-terms', mode: 'workflow', parameters: { content: '第一' } };
  const first = response(await api('POST', '/v1/schedules', enterprise, input), 201);
  const noCredit = response(await api('POST', '/v1/schedules', other, input), 201);
  assert.equal(response(await api('POST', '/v1/schedules', enterprise, input), 200).id, first.id);
  response(await api('POST', '/v1/schedules', enterprise, { ...input, parameters: { content: '最' } }), 409);
  const cancelled = response(await api('POST', '/v1/schedules', enterprise, { ...input, idempotencyKey: 'cancel-schedule-test' }), 201);
  response(await api('POST', '/v1/schedules/' + cancelled.id + '/cancel', enterprise), 200);
  response(await api('POST', '/v1/schedules', enterprise, { ...input, capabilityId: 'operations.publish' }), 400);
  await db.query("UPDATE schedules SET run_at = now() - interval '1 second' WHERE id IN ($1, $2)", [first.id, noCredit.id]);
  const dependencies = { db, providers, shops };
  assert.equal(await dispatchSchedule(dependencies), true);
  assert.equal(await dispatchSchedule(dependencies), true);
  assert.equal(await dispatchSchedule(dependencies), false);
  const scheduled = response(await api('GET', '/v1/schedules', enterprise), 200).items.find(item => item.id === first.id);
  assert.equal(scheduled.state, 'submitted');
  assert.ok(scheduled.taskId);
  const failed = response(await api('GET', '/v1/schedules', other), 200).items.find(item => item.id === noCredit.id);
  assert.equal(failed.errorCode, 'INSUFFICIENT_CREDITS');
  assert.equal(failed.state, 'failed');
  await workOnce(dependencies);
  assert.equal(response(await api('GET', '/v1/tasks/' + scheduled.taskId, enterprise), 200).state, 'succeeded');
});


test('concurrent submissions respect the wallet and do not duplicate execution', async () => {
  const workspaceId = personal.workspaces[0].id;
  await provisionCredits(db, workspaceId, personal.account.id, 2, 'concurrent-test');
  const send = key => api('POST', '/v1/tasks', personal, taskInput(key));
  const duplicates = await Promise.all([send('shared-request'), send('shared-request'), send('shared-request')]);
  assert.deepEqual(duplicates.map(result => result.statusCode).sort(), [200, 200, 202]);
  assert.equal(new Set(duplicates.map(result => result.json().id)).size, 1);
  const independent = await Promise.all([send('independent-1'), send('independent-2'), send('independent-3')]);
  assert.deepEqual(independent.map(result => result.statusCode).sort(), [202, 409, 409]);
  assert.deepEqual(response(await api('GET', '/v1/credits/wallet', personal), 200), { balance: 2, reserved: 2, available: 0 });
  const dependencies = { db, providers, shops };
  const worked = await Promise.all([workOnce(dependencies), workOnce(dependencies), workOnce(dependencies)]);
  assert.equal(worked.filter(Boolean).length, 2);
  assert.deepEqual(response(await api('GET', '/v1/credits/wallet', personal), 200), { balance: 0, reserved: 0, available: 0 });
  assert.equal(response(await api('GET', '/v1/notifications', personal), 200).unread, 2);
});

test('model discovery, selection, media persistence and remote polling use the production task API', async t => {
  const posts = [];
  let polls = 0;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
  const upstream = createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (body) posts.push({ path: request.url, body });
    reply.setHeader('content-type', 'application/json');
    if (request.url === '/v1/chat/completions') return reply.end(JSON.stringify({ choices: [{ message: { content: '杯子' } }] }));
    if (request.url === '/v1/images/generations') return reply.end(JSON.stringify({ data: [{ b64_json: png }] }));
    if (request.url === '/v1/contents/generations/tasks') return reply.end(JSON.stringify({ id: 'remote-42' }));
    if (request.url === '/v1/contents/generations/tasks/remote-42') {
      polls += 1;
      if (polls === 1) reply.statusCode = 503;
      return reply.end(JSON.stringify(polls <= 2 ? { status: 'running' } : { status: 'succeeded', content: { video_url: 'https://media.test/42.mp4' } }));
    }
    reply.statusCode = 404;
    reply.end('{}');
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const routes = [['a-chat', 'chat-completions'], ['b-chat', 'ollama-chat'], ['a-image', 'openai-images'], ['a-video', 'ark-video']]
    .map(([id, protocol]) => ({ id, protocol, model: 'fixture', baseUrl }));
  installModels(providers, routes);
  t.after(() => routes.forEach(route => providers.delete('model:' + route.id)));
  const workspaceId = other.workspaces[0].id;
  const deps = { db, providers, shops };
  await provisionCredits(db, workspaceId, other.account.id, 20, 'model-route-funds');
  const list = response(await api('GET', '/v1/models?capabilityId=model.chat', other), 200);
  assert.deepEqual(list.items.map(item => item.id), ['a-chat', 'b-chat']);
  assert.ok(list.items.every(item => !('baseUrl' in item) && !('keyEnv' in item)));
  const send = (key, modelId, capabilityId, parameters) => api('POST', '/v1/tasks', other, { idempotencyKey: key, ...(modelId && { modelId }), mode: 'chat', capabilityId, parameters });
  const messages = [{ role: 'user', content: '杯子' }];
  const chat = response(await send('model-chat-key', null, 'model.chat', { messages }), 202);
  assert.equal(chat.modelId, 'a-chat');
  response(await send('model-chat-key', 'b-chat', 'model.chat', { messages }), 409);
  response(await send('bad-model-route', 'a-video', 'model.chat', { messages }), 422);
  response(await send('bad-model-format', 'a-image', 'image.main-image', { prompt: '杯', format: 'psd' }), 400);
  await workOnce(deps);
  const finished = id => api('GET', '/v1/tasks/' + id, other).then(result => response(result, 200));
  assert.equal((await finished(chat.id)).result.text, '杯子');

  const image = response(await send('model-image-key', 'a-image', 'image.main-image', { prompt: '杯' }), 202);
  await workOnce(deps);
  const { assetId } = (await finished(image.id)).result;
  const path = '/v1/assets/' + assetId + '/content';
  assert.equal((await api('GET', path, other)).rawPayload.toString('base64'), png);
  response(await api('GET', path, personal), 404);

  const video = response(await send('model-video-key', 'a-video', 'video.compose', { prompt: '杯' }), 202);
  await workOnce(deps);
  assert.equal((await finished(video.id)).state, 'running');
  // Recreate adapters between submission and polling, as after a worker restart.
  const videoBytes = Buffer.from('0000000c6674797069736f6d','hex');
  const archivedUrls = [];
  const videoArchive = createVideoArchive(['https://media.test'],async (url,options) => {
    archivedUrls.push(url.href);
    assert.equal(options.binary,true);
    return videoBytes;
  });
  const restarted = { ...deps, providers: installModels(createProviders(), routes), videoArchive };
  for (let i = 0; i < 3; i += 1) {
    await db.query("UPDATE tasks SET lease_until = now() WHERE id = $1", [video.id]);
    await workOnce(restarted);
  }
  const remote = await finished(video.id);
  assert.equal(remote.attempts, 1);
  assert.equal(remote.result.url, 'https://media.test/42.mp4');
  assert.equal(remote.result.archiveStatus,'saved');
  assert.deepEqual(archivedUrls,[remote.result.url]);
  const videoAsset = '/v1/assets/' + remote.result.assetId;
  const videoInfo = response(await api('GET',videoAsset,other),200);
  assert.equal(videoInfo.name,video.id+'.mp4');
  assert.equal(videoInfo.mediaType,'video/mp4');
  const file = await api('GET',videoAsset+'/content',other);
  assert.equal(file.statusCode,200);
  assert.deepEqual(file.rawPayload,videoBytes);
  response(await api('GET',videoAsset+'/content',personal),404);
  assert.equal(posts.filter(request => request.path.endsWith('/generations/tasks')).length, 1);

  // A process loss between the paid POST and persistence of its receipt is ambiguous.
  const lost = response(await send('model-lost-receipt', 'a-video', 'video.compose', { prompt: '杯' }), 202);
  await db.query("UPDATE tasks SET state='running', attempts=1, lease_until=now(), provider_sent_at=now() WHERE id=$1", [lost.id]);
  await workOnce(deps);
  assert.equal((await finished(lost.id)).errorCode, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(posts.length, 3);
  assert.deepEqual(response(await api('GET', '/v1/credits/wallet', other), 200), { balance: 10, reserved: 0, available: 10 });
});
