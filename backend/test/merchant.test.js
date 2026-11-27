import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { migrate, row } from '../src/db.js';
import { featureReleases } from '../src/merchant-features.js';
import { createProviders } from '../src/providers.js';
import { dispatchSchedule } from '../src/schedules.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';
import { cutoverWorkspace } from '../src/workspace-cutover.js';

const task = key => ({ capabilityId: 'copywriting.detect-terms', mode: 'workflow',
  parameters: { content: '商品详情' }, idempotencyKey: key });
const token = () => randomBytes(32).toString('base64url');

async function fixture(t, { dedicated = false } = {}) {
  const db = new PGlite();
  const target = dedicated ? new PGlite() : null;
  const providers = createProviders();
  const cloudAssets = new Map();
  const shops = new Map();
  let app;
  t.after(async () => { await app?.close(); await target?.close(); await db.close(); });
  await migrate(db);
  if (target) await migrate(target);
  app = await buildApp({ db, providers, shops, cloudAssets,
    releases: featureReleases([{ pluginId: 'copywriting', version: 'rules-2', notes: 'Enable the local term checker',
      capabilities: ['copywriting.detect-terms'] }]),
    dedicatedDatabases: target ? new Map([['store', target]]) : new Map(),
  });

  async function send(method, url, status, session, payload) {
    const result = await app.inject({ method, url, payload, headers: {
      ...(session ? { authorization: 'Bearer ' + session.token } : {}),
      ...(session?.workspace ? { 'x-workspace-id': session.workspace } : {}),
    } });
    assert.equal(result.statusCode, status, result.body);
    return status === 204 ? null : result.json();
  }

  async function register(name, type = 'personal') {
    const result = await send('POST', '/v1/auth/register', 201, null,
      await registrationPayload(app, { email: name + '@example.test', displayName: name, password: 'merchant-test-password', type, workspaceName: name }));
    return { ...result, workspace: result.workspaces[0].id };
  }

  async function invite(owner, user, role = 'member') {
    return send('POST', '/v1/invitations', 201, owner, { email: user.account.email, role });
  }

  async function accept(owner, user, invitation) {
    await send('POST', '/v1/invitations/accept', 200, user, { token: invitation.token });
    return { ...user, workspace: owner.workspace };
  }

  return { db, target, app, providers, shops, cloudAssets, send, register, invite, accept };
}

test('merchant roles, invitations, scoped suspension and project grants are enforced on every request', async t => {
  const { send, register, invite, accept } = await fixture(t);
  const owner = await register('owner', 'enterprise');
  const outsider = await register('other', 'enterprise');
  const person = await register('person');
  const operator = await register('operator');
  const admin = await accept(owner, operator, await invite(owner, operator, 'admin'));

  await send('GET', '/v1/merchant/context', 200, owner);
  await send('GET', '/v1/merchant/context', 403, person);
  const original = await invite(admin, person);
  const renewed = await send('PUT', '/v1/invitations/' + original.id + '/token', 200, admin, { token: token(), revision: original.revision });
  assert.deepEqual(await send('PUT', '/v1/invitations/' + original.id + '/token', 200, admin, { token: renewed.token, revision: original.revision }), renewed);
  const replacement = await send('PUT', '/v1/invitations/' + original.id + '/token', 200, admin, { token: token(), revision: renewed.revision });
  await send('PUT', '/v1/invitations/' + original.id + '/token', 409, admin, { token: renewed.token, revision: original.revision });
  await send('POST', '/v1/invitations/accept', 404, person, { token: original.token });
  await send('DELETE', '/v1/invitations/' + renewed.id, 204, admin);
  await send('POST', '/v1/invitations/accept', 404, person, { token: replacement.token });
  const member = await accept(owner, person, await invite(admin, person));
  await send('GET', '/v1/merchant/context', 403, member);
  await send('PUT', '/v1/plugins/copywriting/state', 403, member, { enabled: false });
  await send('GET', '/v1/merchant/audit-events', 403, member);
  await send('PATCH', '/v1/members/' + operator.account.id + '/state', 403, admin, { state: 'suspended' });
  await send('PATCH', '/v1/members/' + person.account.id, 403, admin, { role: 'admin' });

  const project = await send('POST', '/v1/projects', 201, owner, { name: 'Company project' });
  const path = '/v1/projects/' + project.id;
  await send('GET', path, 404, outsider);
  await send('GET', path, 404, member);
  await send('PUT', path + '/members/' + person.account.id, 204, admin);
  const { items } = await send('GET', path + '/members', 200, owner);
  assert.deepEqual(items.map(item => item.id), [person.account.id]);
  await send('GET', path, 200, member);
  await send('PATCH', '/v1/members/' + person.account.id + '/state', 200, admin, { state: 'suspended' });
  assert.equal((await send('GET', path, 403, member)).error.code, 'MEMBER_SUSPENDED');
  await send('GET', '/v1/projects', 200, person);
  await send('PATCH', '/v1/members/' + person.account.id + '/state', 200, admin, { state: 'active' });
  await send('GET', path, 200, member);
  await send('PATCH', path, 200, admin, { state: 'archived' });
  await send('GET', path, 200, member);
  assert.equal((await send('POST', '/v1/tasks', 409, member, { ...task('archived-project'), projectId: project.id })).error.code, 'PROJECT_ARCHIVED');
  await send('DELETE', path + '/members/' + person.account.id, 204, admin);
  await send('GET', path, 404, member);
  const first = await send('GET', '/v1/merchant/audit-events?limit=3', 200, owner);
  assert.equal(first.hasMore, true);
  const cursor = first.items.at(-1);
  const second = await send('GET', '/v1/merchant/audit-events?' + new URLSearchParams({ beforeAt: cursor.occurredAt, beforeId: cursor.id }), 200, owner);
  assert(second.items.every(item => !first.items.some(previous => previous.id === item.id)));
  assert(second.items.some(item => item.action === 'invitation.created'));
  assert.deepEqual((await send('GET', '/v1/merchant/audit-events', 200, outsider)).items, []);
});

test('trial policies apply to the catalog, submission and scheduler while accepted tasks keep their version', async t => {
  const { db, providers, shops, send, register, invite, accept } = await fixture(t);
  const owner = await register('owner', 'enterprise');
  const participant = await register('participant');
  const member = await accept(owner, participant, await invite(owner, participant));
  for (const person of [owner, member]) await provisionCredits(db, owner.workspace, person.account.id, 8, randomUUID());
  const pending = await send('POST', '/v1/tasks', 202, member, task('before-switch'));
  const rule = '/v1/merchant/features/copywriting';
  const snapshot = (await send('GET', '/v1/merchant/features', 200, owner)).items.find(item => item.id === 'copywriting');
  const trial = { enabled: true, version: 'rules-2', mode: 'trial', memberIds: [member.account.id], revision: snapshot.revision };
  const changed = await send('PUT', rule, 200, owner, trial);
  await send('PUT', rule, 409, owner, trial);
  assert.equal((await send('GET', '/v1/plugins', 200, owner)).items.find(item => item.id === 'copywriting').enabled, false);
  assert.equal((await send('POST', '/v1/tasks', 409, owner, task('not-in-trial'))).error.code, 'FEATURE_NOT_AVAILABLE');
  const accepted = await send('POST', '/v1/tasks', 202, member, task('with-release'));
  assert.equal(accepted.featureVersion, 'rules-2');
  await send('PUT', rule, 200, owner, { ...trial, revision: changed.revision, enabled: false });
  await send('POST', '/v1/copywriting/review', 409, member, { platform: 'pinduoduo', revision: 1, title: '文案', sellingPoints: [] });

  assert.equal((await send('POST', '/v1/tasks', 409, member, task('after-switch'))).error.code, 'PLUGIN_DISABLED');
  await workOnce({ db, providers, shops });
  await workOnce({ db, providers, shops });
  assert.equal((await send('GET', '/v1/tasks/' + pending.id, 200, member)).state, 'succeeded');
  assert.equal((await send('GET', '/v1/tasks/' + accepted.id, 200, member)).featureVersion, 'rules-2');

  const scheduleId = randomUUID();
  await db.query(`INSERT INTO schedules(id,workspace_id,account_id,run_at,request,request_hash,idempotency_key,state)
    VALUES($1,$2,$3,now()-interval '1 minute',$4,'test-schedule','test-schedule','pending')`, [
    scheduleId, owner.workspace, member.account.id,
    { capabilityId: task('unused').capabilityId, mode: 'workflow', parameters: task('unused').parameters },
  ]);
  await send('PATCH', '/v1/members/' + member.account.id + '/state', 200, owner, { state: 'suspended' });
  assert(await dispatchSchedule({ db, providers, shops }));
  assert.equal((await row(db, 'SELECT error_code FROM schedules WHERE id=$1', [scheduleId])).error_code, 'MEMBER_SUSPENDED');
});

test('member model discovery follows the same merchant feature scope as task submission', async t => {
  const {send,register,providers,invite,accept}=await fixture(t);
  const owner=await register('catalog-owner','enterprise');
  const other=await register('other-catalog-owner','enterprise');
  const person=await register('catalog-member');
  const member=await accept(owner,person,await invite(owner,person));
  const capabilities=['model.chat','copywriting.generate'];
  providers.set('model:writer',{info:{id:'writer',model:'writer',protocol:'chat-completions',kind:'text',streamText:false,capabilities},
    supports:cap=>capabilities.includes(cap.id)});
  const list=async(user,filter='')=>(await send('GET','/v1/models'+filter,200,user)).items;
  const toggle=(id,body)=>send('PUT','/v1/merchant/features/'+id,200,owner,body);
  const initial={mode:'all',memberIds:[],version:'builtin',revision:0};
  const off=await toggle('models',{...initial,enabled:false});
  assert.deepEqual(await list(member,'?capabilityId=model.chat'),[]);
  assert.deepEqual((await list(member))[0].capabilities,['copywriting.generate']);
  assert.deepEqual((await list(other))[0].capabilities,capabilities);
  await toggle('models',{...initial,revision:off.revision,enabled:true,mode:'trial',memberIds:[person.account.id]});
  assert.deepEqual(await list(owner,'?capabilityId=model.chat'),[]);
  assert.equal((await list(member,'?capabilityId=model.chat'))[0].id,'writer');
});

test('owner checks and disconnects provisioned connections and audits survive workspace cutover', async t => {
  const { db, target, cloudAssets, shops, providers, send, register, invite, accept } = await fixture(t, { dedicated: true });
  const owner = await register('owner', 'enterprise');
  const person = await register('admin');
  const admin = await accept(owner, person, await invite(owner, person, 'admin'));
  const shopId = randomUUID();
  providers.set('model:provisioned', {
    info: { id: 'provisioned', name: 'Provisioned model', kind: 'text', capabilities: ['model.chat'] },
    supports: capability => capability.id === 'model.chat',
  });
  let probes = 0;
  cloudAssets.set(owner.workspace, { fingerprint: 'fixture', check: async () => { probes++; } });
  shops.set(shopId, { id: shopId, workspaceId: owner.workspace, name: 'Provisioned test shop', platform: 'pinduoduo', capabilities: [] });
  const connector = '/v1/merchant/connections/webdav/workspace';
  assert.equal((await send('GET', '/v1/merchant/connections', 200, admin)).items.length, 3);
  await send('PUT', connector, 403, admin, { enabled: false, revision: 0 });
  const off = await send('PUT', connector, 200, owner, { enabled: false, revision: 0 });
  assert.equal((await send('GET', '/v1/cloud-assets/status', 200, owner)).available, false);
  await send('PUT', connector, 409, owner, { enabled: true, revision: off.revision });
  const checked = await send('POST', connector + '/check', 200, owner);
  assert.equal(probes, 1);
  await send('PUT', connector, 200, owner, { enabled: true, revision: checked.revision });
  await send('PUT', '/v1/merchant/connections/shop/' + shopId, 200, owner, { enabled: false, revision: 0 });
  assert.deepEqual((await send('GET', '/v1/shops', 200, owner)).items, []);
  await send('PUT', '/v1/merchant/connections/model/provisioned', 200, owner, { enabled: false, revision: 0 });
  assert.deepEqual((await send('GET', '/v1/models', 200, owner)).items, []);
  await send('POST', '/v1/tasks', 422, owner, { capabilityId: 'model.chat', mode: 'chat',
    modelId: 'provisioned', parameters: { messages: [{ role: 'user', content: 'Hi' }] }, idempotencyKey: 'disabled-model' });

  await cutoverWorkspace(db, target, owner.workspace, 'store');
  const history = (await send('GET', '/v1/merchant/audit-events', 200, owner)).items;
  assert(history.some(item => item.action === 'invitation.accepted'));
  assert(history.some(item => item.action === 'connection.checked'));
  assert.equal((await send('GET', '/v1/merchant/connections', 200, owner)).items.find(item => item.id === shopId).enabled, false);
  await send('PATCH', '/v1/members/' + person.account.id + '/state', 200, owner, { state: 'suspended' });
  await send('GET', '/v1/merchant/context', 403, admin);
  await send('GET', '/v1/merchant/connections', 200, owner);
  assert.equal((await row(target, 'SELECT state FROM memberships WHERE workspace_id=$1 AND account_id=$2',
    [owner.workspace, person.account.id])).state, 'suspended');
});
