import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const form = (page, name) => page.locator(`[data-form="${name}"]`);
const submit = scope => scope.locator('button:not([type]), button[type=submit]').last();
const route = (method, path) => ({ method, path });
const named = (scope, name) => scope.locator(`[name="${name}"]`);

async function type(scope, fields) {
  for (const [name, value] of Object.entries(fields)) await named(scope, name).fill(value);
}

test('platform owner manages members, access, credits, features, connections and audits in Chrome', options, async t => {
  const cloudAssets = new Map();
  let checks = 0;
  const { page, origin, app, session, read, open, act } = await createStudioFixture(t, {
    cloudAssets,
    configureProviders(providers) {
      providers.set('model:platform-connection', {
        info: { id: 'platform-connection', model: 'Platform QA alias', protocol: 'openai-chat', kind: 'text',
          capabilities: ['model.chat'], streamText: false },
        supports: capability => capability.id === 'model.chat',
        run: async () => ({ type: 'text', text: '本机连接夹具' }),
      });
    },
  });
  cloudAssets.set(session.workspaces[0].id, { check: async () => { checks++; } });
  page.on('dialog', dialog => dialog.accept());
  const memberEmail = randomUUID() + '@example.test';
  const registration = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: {
    email: memberEmail, password: 'platform-member-fixture', displayName: '平台验收成员', type: 'personal',
  } });
  assert.equal(registration.statusCode, 201, registration.body);
  const member = registration.json();
  const memberId = member.account.id;
  await page.goto(origin + '/merchant#members');
  const invitationForm = form(page, 'invite');
  await type(invitationForm, { email: memberEmail });
  const invited = await act('生成成员邀请', submit(invitationForm), route('POST', '/v1/invitations'));
  const invitation = await invited.json();
  const inviteTarget = '/v1/invitations/' + invitation.id;
  const replacement = await act('重发成员邀请', page.locator(`[data-renew="${invitation.id}"]`), route('PUT', inviteTarget + '/token'));
  const { token: replacementToken } = await replacement.json();
  assert.notEqual(replacementToken, invitation.token);
  await page.waitForFunction(token => document.querySelector('[data-ticket]')?.value.includes(token), replacementToken);
  await act('复制当前邀请链接', page.locator('[data-copy-invite]'));
  const memberPage = await page.context().newPage();
  memberPage.setDefaultTimeout(10000);
  await memberPage.goto(origin + '/#team');
  const personal = member.workspaces[0].id;
  await memberPage.evaluate(({ token, personal }) => {
    sessionStorage.setItem('fai.live.session', token);
    sessionStorage.setItem('fai.live.workspace', personal);
  }, { token: member.token, personal });
  await memberPage.reload();
  const acceptance = form(memberPage, 'accept');
  await type(acceptance, { token: replacementToken });
  const [accepted] = await Promise.all([memberPage.waitForResponse(response =>
    new URL(response.url()).pathname === '/v1/invitations/accept' && response.request().method() === 'POST'),
  submit(acceptance).click()]);
  assert.equal(accepted.status(), 200);
  const company = session.workspaces[0].id;
  await memberPage.waitForFunction(id => document.querySelector('#workspace-selector')?.value === id, company);
  t.diagnostic('UI action: 接受企业邀请 → POST /v1/invitations/accept 200');
  const memberFilter = form(page, 'filters');
  await type(memberFilter, { q: memberEmail });
  await act('筛选企业成员', submit(memberFilter), route('GET', '/v1/members'));
  const memberPath = '/v1/members/' + memberId;
  for (const [action, label, expected] of [['member-role', '设为管理员', 'admin'], ['member-role', '设为成员', 'member'],
    ['member-state', '停用', 'suspended'], ['member-state', '恢复', 'active']]) {
    const attribute = action.endsWith('role') ? 'role' : 'state';
    const button = page.locator(`[data-${action}="${memberId}"]`).filter({ hasText: label });
    await act(label, button, route('PATCH', attribute === 'role' ? memberPath : memberPath + '/state'));
    assert.equal((await read('/v1/members')).items.find(entry => entry.id === memberId)[attribute], expected);
  }
  await type(invitationForm, { email: randomUUID() + '@example.test' });
  const second = await act('生成待撤回邀请', submit(invitationForm), route('POST', '/v1/invitations'));
  const revoked = await second.json();
  await act('撤回邀请', page.locator(`[data-revoke="${revoked.id}"]`), route('DELETE', '/v1/invitations/' + revoked.id));
  assert.equal((await read('/v1/invitations')).items.find(entry => entry.id === revoked.id).status, 'revoked');

  await page.locator(`a[href="#members/limit/${memberId}"]`).click();
  const memberLimit = form(page, 'member-limit');
  const limitPath = `/v1/credits/members/${memberId}/limit`;
  for (const limit of ['12', '']) {
    await type(memberLimit, { limit });
    await act('更新成员任务额度', submit(memberLimit), route('PUT', limitPath));
    assert.equal((await read(limitPath)).limit, limit ? Number(limit) : null);
    await page.getByText(limit ? '当前上限为 12 积分。' : '当前没有累计额度限制。', { exact: true }).waitFor();
  }

  await page.locator('#nav a[href="#projects"]').click();
  const projectForm = form(page, 'project');
  await type(projectForm, { name: '平台验收项目' });
  const added = await act('创建商家项目', submit(projectForm), route('POST', '/v1/projects'));
  const project = await added.json();
  const projectPath = '/v1/projects/' + project.id;
  const rename = form(page, 'rename');
  await type(rename, { name: '平台验收项目已更新' });
  await act('重命名商家项目', submit(rename), route('PATCH', projectPath));
  await page.getByRole('heading', { name: '平台验收项目已更新' }).waitFor();
  const grant = form(page, 'grant');
  await named(grant, 'memberId').selectOption(memberId);
  await act('授予项目访问', submit(grant), route('PUT', projectPath + '/members/' + memberId));
  assert.ok((await read(projectPath + '/members')).items.some(entry => entry.id === memberId));
  await act('撤销项目访问', page.locator(`[data-revoke-access="${memberId}"]`),
    route('DELETE', projectPath + '/members/' + memberId));
  assert.equal((await read(projectPath + '/members')).items.length, 0);
  for (const [label, archived] of [['归档项目', true], ['恢复项目', false]]) {
    await act(label, page.getByRole('button', { name: label, exact: true }), route('PATCH', projectPath));
    assert.equal(Boolean((await read(projectPath)).archivedAt), archived);
  }
  await page.getByRole('link', { name: '返回项目清单' }).click();
  const projectFilter = form(page, 'project-filter');
  await named(projectFilter, 'state').selectOption('active');
  const filtered = await act('筛选进行中项目', submit(projectFilter), route('GET', '/v1/projects'));
  assert.equal(new URL(filtered.url()).searchParams.get('state'), 'active');

  await page.locator('#nav a[href="#features"]').click();
  const feature = form(page, 'feature-copywriting');
  const featureSection = page.locator('details.merchant-feature-row').filter({ has: feature });
  for (const mode of ['trial', 'all']) {
    await featureSection.locator('summary').first().click();
    await named(feature, 'mode').selectOption(mode);
    if (mode === 'trial') await feature.locator(`[name=memberId][value="${memberId}"]`).check();
    await act('保存企业功能开放范围', submit(feature), route('PUT', '/v1/merchant/features/copywriting'));
    const entry = (await read('/v1/merchant/features')).items.find(item => item.id === 'copywriting');
    assert.equal(entry.mode, mode);
    assert.deepEqual(entry.memberIds, mode === 'trial' ? [memberId] : []);
    await page.getByRole('heading', { name: '功能管理', exact: true }).waitFor();
    await feature.waitFor({ state: 'hidden' });
  }

  await page.locator('#nav a[href="#connections"]').click();
  await act('读取企业接入概况', page.locator('[data-readiness]'), route('GET', '/v1/models'));
  await page.locator('[data-readiness-result]').getByText('模型登记', { exact: true }).waitFor();
  const webdav = page.locator('#merchantContent article').filter({ hasText: '工作区 WebDAV' });
  const webdavPath = '/v1/merchant/connections/webdav/workspace';
  const check = await act('检查本机 WebDAV 夹具连接', webdav.getByRole('button', { name: '检查连接' }), route('POST', webdavPath + '/check'));
  assert.equal((await check.json()).checkState, 'reachable');
  assert.equal(checks, 1);
  const model = page.locator('#merchantContent article').filter({ hasText: 'platform-connection' });
  for (const [label, enabled] of [['断开连接', false], ['启用连接', true]]) {
    const changed = await act(label + '模型别名', model.getByRole('button', { name: label, exact: true }),
      route('PUT', '/v1/merchant/connections/model/platform-connection'));
    assert.equal((await changed.json()).enabled, enabled);
    assert.equal((await read('/v1/models')).items.some(item => item.id === 'platform-connection'), enabled);
  }

  await page.locator('#nav a[href="#audit"]').click();
  const audit = form(page, 'audit-filter');
  await type(audit, { targetId: project.id });
  const auditResponse = await act('按对象筛选审计', submit(audit), route('GET', '/v1/merchant/audit-events'));
  assert.equal(new URL(auditResponse.url()).searchParams.get('targetId'), project.id);
  const exported = page.waitForEvent('download');
  await act('下载筛选后的审计记录', page.locator('[data-audit-export]'), route('GET', '/v1/merchant/audit-events'));
  const records = JSON.parse(await readFile(await (await exported).path(), 'utf8'));
  assert.ok(records.length > 0 && records.every(record => record.targetId === project.id));

  await open('account', form(page, 'allocate'));
  const allocation = form(page, 'allocate');
  await named(allocation, 'memberId').selectOption(memberId);
  await type(allocation, { amount: '3' });
  await act('从账户页分配积分', submit(allocation), route('POST', '/v1/credits/allocate'));
  assert.ok((await read('/v1/credits/ledger')).items.some(entry => entry.operation === 'transfer_out' && Math.abs(entry.amount) === 3));

  const workspaceControl = memberPage.locator('#workspace-selector');
  await memberPage.locator('#profile').click();
  for (const workspaceId of [personal, company]) {
    const [response] = await Promise.all([memberPage.waitForResponse(response =>
      new URL(response.url()).pathname === '/v1/plugins' &&
      response.request().headers()['x-workspace-id'] === workspaceId), workspaceControl.selectOption(workspaceId)]);
    assert.equal(response.status(), 200);
    await memberPage.waitForFunction(id => document.querySelector('#workspace-selector')?.value === id, workspaceId);
    t.diagnostic('UI action: 切换并读取工作区目录 → GET /v1/plugins 200');
    if (workspaceId === personal) await memberPage.locator('#profile').click();
  }
  await memberPage.close();
});
