
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';

const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
const providers = createProviders();
const shops = new Map();
let app, owner, other;
const send = (method, url, session, payload) => app.inject({ method, url, payload, headers: session
  ? { authorization: 'Bearer ' + session.token, 'x-workspace-id': session.workspaces[0].id }
  : {} });
function data(response, code) {
  assert.equal(response.statusCode, code, response.body);
  return code === 204 ? undefined : response.json();
}

before(async () => {
  await migrate(db);
  app = await buildApp({ db, providers, shops });
  await app.ready();
  const register = async email => data(await send('POST', '/v1/auth/register', null, {
    email, password: 'studio-test-password', type: 'enterprise', workspaceName: 'Studio QA', displayName: email,
  }), 201);
  owner = await register('studio-owner@example.test');
  other = await register('studio-other@example.test');
});
after(async () => {
  await app?.close();
  await db.close();
});

test('Studio entry only serves real app code and current theme components', async () => {
  const entry = await send('GET', '/');
  assert.equal(entry.statusCode, 200);
  assert.match(entry.body, /\/studio\/live\.js/);
  assert.match(entry.body, /\/studio\/components\.css/);
  assert.doesNotMatch(entry.body, /src="studio\.js"/);
  assert.match(entry.headers['content-security-policy'], /connect-src 'self'/);
  for (const file of ['live.js', 'live-tasks.js', 'live-workspace.js', 'live-products.js', 'live-customer.js', 'components.css', 'assets/aurora.webp']) {
    assert.equal((await send('GET', '/studio/' + file)).statusCode, 200, file);
  }
  assert.equal((await send('GET', '/studio/studio.js')).statusCode, 404);
});

test('product records, category assignment, import rollback, export and tenant isolation', async () => {
  const categories = '/v1/studio/categories';
  const products = '/v1/studio/products';
  const category = data(await send('POST', categories, owner, { name: 'Home' }), 201);
  data(await send('POST', products, other, { sku: 'FOREIGN', name: 'Other', categoryId: category.id }), 409);
  const original = data(await send('POST', products, owner, { sku: 'MUG-001', name: 'Mug', categoryId: category.id }), 201);
  data(await send('DELETE', categories + '/' + category.id, owner), 409);
  assert.deepEqual(data(await send('GET', products, other), 200).items, []);
  data(await send('PUT', products + '/' + original.id, other, { sku: 'MUG-001', name: 'Different' }), 404);
  data(await send('POST', products + '/import', owner, { reference: 'failed-import', items: [
    { sku: 'NEW', name: 'Test', category: 'Will Roll Back' }, { sku: original.sku, name: 'Duplicate' },
  ] }), 409);
  assert.deepEqual(data(await send('GET', categories, owner), 200).items.map(item => item.name), ['Home']);
  assert.deepEqual(data(await send('GET', products, owner), 200).items.map(item => item.sku), [original.sku]);
  const response = data(await send('POST', products + '/import', owner, { reference: 'successful-import', items: [
    { sku: 'MUG-002', name: 'Cup', category: 'Home' },
  ] }), 201);
  assert.equal(response.count, 1);
  data(await send('POST', products + '/export', other, { reference: 'forbidden-export', ids: [original.id] }), 404);
  const result = data(await send('POST', products + '/export', owner, { reference: 'actual-export', ids: [original.id] }), 200);
  assert.deepEqual(result.items, [{ sku: 'MUG-001', name: 'Mug', description: '', category: 'Home' }]);
  assert.deepEqual(data(await send('GET', '/v1/studio/transfers', owner), 200).items.map(item => item.direction).sort(), ['export', 'import']);
  assert.deepEqual(data(await send('GET', '/v1/studio/transfers', other), 200).items, []);
  assert.deepEqual(data(await send('POST', '/v1/studio/roi', owner, {
    priceMinor: 1000, unitCostMinor: 250, units: 10, feesMinor: 500, adSpendMinor: 1000,
  }), 200), { revenueMinor: 10000, productCostMinor: 2500, contributionMinor: 6000, roas: 10 });
});

test('server settings save favorites and theme and suppress task notifications when disabled', async () => {
  const directory = data(await send('GET', '/v1/plugins', owner), 200);
  assert.equal(directory.items.length, 5);
  assert.equal(directory.models.capabilities.length, 5);
  const preferences = { studioTheme: 'jade', studioMotion: 'off', favoriteCapabilities: ['copywriting.detect-terms'], taskNotifications: false };
  assert.deepEqual(data(await send('PATCH', '/v1/settings', owner, preferences), 200).preferences, preferences);
  assert.deepEqual(data(await send('GET', '/v1/settings', other), 200).preferences, {});
  await provisionCredits(db, owner.workspaces[0].id, owner.account.id, 4, 'studio-prefs-test');
  const task = data(await send('POST', '/v1/tasks', owner, {
    capabilityId: 'copywriting.detect-terms', mode: 'workflow', parameters: { content: '100%' }, idempotencyKey: 'studio-prefs-test',
  }), 202);
  assert.equal(await workOnce({ db, providers, shops }), true);
  assert.equal(data(await send('GET', '/v1/tasks/' + task.id, owner), 200).state, 'succeeded');
  const notifications = data(await send('GET', '/v1/notifications', owner), 200);
  assert.deepEqual(notifications, { items: [], unread: 0 });
});
