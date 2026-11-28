import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createStudioFixture } from '../test-support/ui-actions.js';
import { registrationPayload } from '../test-support/identity-fixture.js';
import { installModels } from '../src/models.js';

const browserTest = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 180000 };
const confirm = (dialog) => dialog.getByRole('button', { name: '确认', exact: true }).click();
const dialogOf = (page) => page.locator('dialog.admin-dialog[open]');
const panelOf = (page) => page.locator('.admin-shell');
const openTab = async (page, id) => {
  await page.locator('.adm-tabs a[href="#admin/' + id + '"]').click();
  await page.locator('.adm-tabs [aria-current=page][href="#admin/' + id + '"]').waitFor();
};

async function selectDemo(page, open) {
  await open('admin/server', '.admin-shell');
  const dialog = dialogOf(page);
  await panelOf(page).getByRole('button', { name: '编辑连接配置' }).click();
  await dialog.getByLabel('运行模式').selectOption('demo');
  await confirm(dialog);
  await dialog.waitFor({ state: 'detached' });
}

test('workspace administration updates the actual wallet, permissions, models and audit trail', browserTest, async t => {
  const checks = [];
  const upstream = createServer((request, reply) => {
    checks.push(request.method + ' ' + request.url);
    reply.setHeader('content-type', 'application/json');
    reply.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const { app, page, open, api, read, act, workspace, session, headers } = await createStudioFixture(t, {
    configureProviders: providers => installModels(providers, [{
      id: 'native-admin-fixture', model: 'fixture-chat', protocol: 'chat-completions',
      baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1/', checkModels: true
    }])
  });
  const shell = panelOf(page), dialog = dialogOf(page);
  const memberEmail = 'admin-fixture@example.test';
  await open('admin', '.adm-kpi-grid');
  await shell.getByText('当前工作台服务', { exact: true }).waitFor();
  assert.equal(await shell.locator('.adm-kpi-val').nth(2).innerText(), '500');
  await openTab(page, 'users');
  await shell.getByRole('button', { name: '邀请成员', exact: true }).click();
  await dialog.getByLabel('邮箱').fill(memberEmail);
  await act('创建工作区一次性邀请', dialog.getByRole('button', { name: '确认', exact: true }),
    { method: 'POST', path: '/v1/invitations', status: 201 });
  await shell.locator('[data-invite-link]').waitFor();
  const invite = new URL(await shell.locator('[data-invite-link]').inputValue()).hash.split('/')[1];
  const registration = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: await registrationPayload(app, {
    type: 'personal', email: memberEmail, password: 'synthetic-member-password', displayName: '实际受邀成员'
  }) });
  assert.equal(registration.statusCode, 201);
  const member = registration.json();
  const memberHeaders = { authorization: 'Bearer ' + member.token, 'x-workspace-id': workspace };
  const accepted = await app.inject({
    method: 'POST', url: '/v1/invitations/accept', headers: memberHeaders, payload: { token: invite }
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal((await app.inject({ url: '/v1/admin/workspace/overview', headers: memberHeaders })).statusCode, 403);
  const otherWorkspace = member.workspaces[0].id;
  assert.equal((await app.inject({
    url: '/v1/admin/workspace/members', headers: { ...headers, 'x-workspace-id': otherWorkspace }
  })).statusCode, 404);
  await open('admin/users', '.admin-shell');
  const memberRow = shell.getByRole('row').filter({ hasText: memberEmail });
  await memberRow.getByRole('button', { name: '调积分' }).click();
  await dialog.getByLabel('积分数').fill('60');
  await dialog.getByLabel('调账原因').fill('分配任务预算');
  const transferPath = '/v1/admin/workspace/credits/adjust';
  await act('从实际工作区钱包分配积分', dialog.getByRole('button', { name: '确认', exact: true }),
    { method: 'POST', path: transferPath });
  await memberRow.getByText('60', { exact: true }).waitFor();
  assert.equal((await read('/v1/credits/wallet')).available, 440);
  assert.equal(await page.locator('#topCreditText').innerText(), '440');

  const reclaim = { userId: member.account.id, delta: -10, reason: '回收闲置积分', operationId: crypto.randomUUID() };
  const replies = await Promise.all([api('POST', transferPath, reclaim), api('POST', transferPath, reclaim)]);
  assert.deepEqual(replies.map(reply => reply.replayed).sort(), [false, true]);
  const conflict = await app.inject({ method: 'POST', url: transferPath, headers, payload: { ...reclaim, delta: 10 } });
  assert.equal(conflict.statusCode, 409);
  const excess = await app.inject({ method: 'POST', url: transferPath, headers,
    payload: { ...reclaim, operationId: crypto.randomUUID(), delta: -51 } });
  assert.equal(excess.statusCode, 409);
  assert.equal((await read('/v1/credits/wallet')).available, 450);
  const nativeWallet = await app.inject({ url: '/v1/credits/wallet', headers: memberHeaders });
  assert.equal(nativeWallet.json().available, 50);

  await openTab(page, 'subscriptions');
  await shell.getByRole('row').filter({ hasText: '实际受邀成员' }).getByRole('button', { name: '编辑额度' }).click();
  await dialog.getByLabel('累计任务积分上限（留空为不限）').fill('20');
  await confirm(dialog);
  await dialog.waitFor({ state: 'detached' });
  const limit = await app.inject({ url: '/v1/credits/limit', headers: memberHeaders });
  assert.equal(limit.json().limit, 20);
  await openTab(page, 'models');
  const model = shell.getByRole('row').filter({ hasText: 'fixture-chat' });
  await model.getByRole('button', { name: '测试连通性' }).click();
  await model.getByText('连通', { exact: true }).waitFor();
  assert.deepEqual(checks, ['GET /v1/models']);
  await model.getByRole('switch').click();
  await model.locator('[aria-checked=false]').waitFor();
  assert.equal((await read('/v1/models')).items.some(item => item.id === 'native-admin-fixture'), false);
  await model.getByRole('switch').click();
  await model.locator('[aria-checked=true]').waitFor();
  assert.equal((await read('/v1/models')).items.some(item => item.id === 'native-admin-fixture'), true);

  await openTab(page, 'server');
  await shell.getByRole('button', { name: '检查服务和数据库' }).click();
  await shell.getByRole('status').filter({ hasText: '服务和共享数据库均已就绪' }).waitFor();
  await openTab(page, 'credits');
  assert.equal(await shell.getByRole('cell', { name: '调入', exact: true }).count(), 2);
  await openTab(page, 'overview');
  assert.equal(await shell.locator('.adm-kpi-val').nth(2).innerText(), '500');
  const history = (await read('/v1/merchant/audit-events')).items.filter(event => event.action === 'credits.reallocated');
  assert.deepEqual(history.map(event => event.detail.delta), [-10, 60]);
  assert.ok(history.every(event => event.actorId === session.account.id));
});

test('workbench glass follows all three materials and the sidebar fits narrow screens', browserTest, async (t) => {
  const { page, open } = await createStudioFixture(t);
  await open('chat/new', '.agent-composer > .glow-body');
  const body = page.locator('.agent-composer > .glow-body');
  const rings = new Set();
  const track = page.locator('.head-themes .dm-track');
  const box = await track.boundingBox();
  for (const [fraction, material] of [
    [0.17, 'dark'],
    [0.5, 'gray'],
    [0.83, 'white']
  ]) {
    await track.click({ position: { x: Math.round(box.width * fraction), y: Math.round(box.height / 2) } });
    await page.waitForFunction((m) => document.documentElement.dataset.material === m, material);
    const style = await body.evaluate((el) => ({
      ring: getComputedStyle(el, '::before').backgroundImage,
      width: getComputedStyle(el, '::before').paddingTop,
      filter: getComputedStyle(el).backdropFilter,
      mask: getComputedStyle(el, '::before').maskComposite,
      font: getComputedStyle(document.body).fontFamily
    }));
    assert.match(style.filter, /blur\(28px\) saturate\(1.85\)/);
    assert.match(style.font, /Inter/);
    assert.equal(style.width, '1.5px');
    assert.ok(style.mask.split(',').every((mode) => mode.trim() === 'exclude'));
    rings.add(style.ring);
  }
  assert.equal(rings.size, 3);
  await page.mouse.move(0, 0);
  const shadow = await body.evaluate((el) => getComputedStyle(el).boxShadow);
  await body.hover();
  await page.waitForFunction(
    (before) => getComputedStyle(document.querySelector('.glow-body')).boxShadow !== before,
    shadow
  );
  assert.equal(await page.locator('.agent-composer .glow-rim').count(), 1);
  await page.evaluate(
    () => (document.querySelector('#profile .account-name').textContent = '跨境电商工作区'.repeat(14))
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    if (width === 390) await page.locator('#studioMenu').click();
    const bounds = await page.locator('.sidebar-footer').evaluate((footer) => {
      const [link, profile] = [footer.querySelector(':scope > a'), footer.querySelector('#profile')].map((el) =>
        el.getBoundingClientRect()
      );
      const box = footer.getBoundingClientRect();
      return {
        row: getComputedStyle(footer).flexDirection,
        inBounds: link.left >= box.left - 1 && profile.right <= box.right + 1 && link.right <= box.right + 1,
        stacked: link.bottom <= profile.top + 1,
        documentFits: document.documentElement.scrollWidth <= innerWidth
      };
    });
    assert.deepEqual(
      bounds,
      { row: 'column', inBounds: true, stacked: true, documentFits: true },
      'viewport ' + width
    );
  }
});

test(
  'admin entry points, settings and six modules apply audited demo operations across reloads',
  browserTest,
  async (t) => {
    const { page, open, read } = await createStudioFixture(t);
    await selectDemo(page, open);
    await open('settings', '.admin-entry-card');
    await page.locator('.admin-entry-card [href="#admin"]').click();
    const shell = panelOf(page),
      dlg = dialogOf(page);
    const click = (label, where = shell) => where.getByRole('button', { name: label, exact: true }).click();
    const submit = async () => {
      await confirm(dlg);
      await dlg.waitFor({ state: 'detached' });
    };
    await shell.getByRole('heading', { name: '管理审计日志' }).waitFor();
    assert.equal(await shell.locator('.adm-tabs a').count(), 6);
    assert.equal(await shell.locator('.adm-trend-svg').evaluate((el) => getComputedStyle(el).height), '160px');
    assert.equal(await shell.locator('h1').evaluate((el) => getComputedStyle(el).fontWeight), '500');
    assert.equal(
      await shell
        .locator('.adm-kpi-val')
        .first()
        .evaluate((el) => getComputedStyle(el).fontWeight),
      '400'
    );
    await page.locator('#profile').click();
    await page.locator('#account-menu [href="#admin"]').click();

    await openTab(page, 'users');
    await click('新增用户');
    await dlg.getByLabel('姓名').fill('审查用户');
    await dlg.getByLabel('邮箱').fill('demo@example.test');
    await submit();
    await shell.getByRole('searchbox').fill('DEM');
    const user = shell.getByRole('row').filter({ hasText: 'demo@example.test' });
    await click('编辑', user);
    await dlg.getByLabel('角色').selectOption('admin');
    await submit();
    await user.getByRole('switch').click();
    await user.locator('[role=switch][aria-checked=false]').waitFor();
    await shell.locator('[data-filter=status]').selectOption('disabled');
    await user.waitFor();
    assert.equal(await shell.locator('tbody tr').count(), 1);
    await user.getByRole('switch').click();
    await shell.locator('[data-filter=status]').selectOption('');
    await click('调积分', user);
    await dlg.getByLabel('积分数').fill('80');
    await dlg.getByLabel('实际入账金额（元）').fill('12.34');
    await dlg.getByLabel('调账原因').fill('本地验收');
    await submit();
    await click('调积分', user);
    await dlg.getByLabel('变动方向').selectOption('subtract');
    await dlg.getByLabel('积分数').fill('90');
    await dlg.getByLabel('调账原因').fill('余额不足用例');
    await confirm(dlg);
    await dlg.getByRole('alert').getByText('积分余额不足。').waitFor();
    await dlg.getByLabel('积分数').fill('10');
    await submit();
    await openTab(page, 'credits');
    await shell.getByText('¥12.34', { exact: true }).waitFor();
    await click('新增档位');
    await dlg.getByLabel('档位名称').fill('验收档');
    await dlg.getByLabel('赠送积分').fill('8');
    await submit();
    const tier = shell.locator('.adm-subcard').filter({ hasText: '验收档' });
    await tier.getByRole('switch').click();
    await tier.locator('[role=switch][aria-checked=false]').waitFor();
    assert.equal(await tier.getByRole('switch').getAttribute('aria-checked'), 'false');
    await click('编辑倍率', shell.getByRole('row').filter({ hasText: '文本生成' }));
    await dlg.getByLabel('积分扣费倍率').fill('2');
    await submit();
    await openTab(page, 'subscriptions');
    const pro = shell.locator('.adm-subcard').filter({ hasText: '专业版' });
    await click('编辑套餐', pro);
    await dlg.getByLabel('月赠积分').fill('3');
    await submit();
    await click('手动开通');
    await dlg.getByLabel('用户').selectOption({ label: '审查用户 · demo@example.test' });
    await dlg.getByLabel('套餐').selectOption('pro');
    await submit();
    await click('续费 30 天');
    await submit();
    await click('取消订阅');
    await submit();
    await shell.getByText('已取消', { exact: true }).waitFor();
    await openTab(page, 'models');
    await click('新增模型');
    await dlg.getByLabel('Provider').fill('测试通道');
    await dlg.getByLabel('Model ID').fill('test-image');
    await dlg.getByLabel('类型').selectOption('image');
    await dlg.getByLabel('Base URL').fill('https://models.example.test');
    await dlg.getByLabel('API Key', { exact: true }).fill('synthetic-preview-key');
    await click('显示API Key', dlg);
    await submit();
    await click('测试连通性');
    await shell.getByRole('status').filter({ hasText: '演示连通性检查通过' }).waitFor();
    await openTab(page, 'server');
    await click('模拟健康检查');
    await shell.getByRole('status').filter({ hasText: '演示健康检查通过' }).waitFor();
    const download = page.waitForEvent('download');
    await click('导出配置 JSON');
    const obj = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    assert.equal(obj.mode, 'demo');
    assert.ok(!('secret' in obj));
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('synthetic-preview-key'));
    await open('admin/overview', '.adm-kpi-grid');
    await shell.getByText('¥12.34', { exact: true }).first().waitFor();
    await shell.locator('.adm-kpi-val').filter({ hasText: /^76$/ }).waitFor();
    await shell
      .locator('.adm-log-list')
      .getByText(/续期 30 天/)
      .waitFor();
    await shell
      .locator('.adm-log-list')
      .getByText(/演示连通性检查通过/)
      .waitFor();
    assert.equal((await read('/v1/credits/wallet')).available, 500, 'demo adjustments are scoped to the demo');
    await openTab(page, 'users');
    await click('删除', user);
    await click('取消', dlg);
    assert.equal(await user.count(), 1);
    await click('删除', user);
    await submit();
    assert.equal(await user.count(), 0);
    await openTab(page, 'models');
    await click('移除');
    await submit();
    assert.equal(await shell.getByText('test-image', { exact: true }).count(), 0);
  }
);

test(
  'configured backend uses dedicated credentials, reports failures and never exports the secret',
  browserTest,
  async (t) => {
    const { page, open, origin } = await createStudioFixture(t);
    const seen = [];
    const sample = {
      id: 'customer-a',
      name: '接入账号',
      email: 'remote@example.test',
      role: 'member',
      enabled: true,
      balance: 10
    };
    await page.route(origin + '/admin-fixture/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      seen.push({
        path: url.pathname,
        method: req.method(),
        headers: await req.allHeaders(),
        body: req.postDataJSON()
      });
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (req.headers()['x-admin-secret'] !== 'test-only-admin-secret')
        return route.fulfill({ status: 403, json: {} });
      if (url.pathname.endsWith('/users') && req.method() === 'GET')
        return route.fulfill({ json: { users: [sample] } });
      if (url.pathname.endsWith('/users/customer-a')) return route.fulfill({ status: 403, json: {} });
      return route.fulfill({
        json: { totals: { users: 1, credits: 10, revenueCents: 0, models: 0 }, trend: [], audit: [] }
      });
    });
    await open('admin/server', '.admin-shell');
    const shell = panelOf(page),
      dlg = dialogOf(page);
    await shell.getByRole('button', { name: '编辑连接配置' }).click();
    await dlg.getByLabel('运行模式').selectOption('remote');
    await dlg.getByLabel('后台 Base URL').fill(origin + '/admin-fixture');
    await dlg.getByLabel('鉴权方式').selectOption('secret');
    await dlg.getByLabel('管理凭据', { exact: true }).fill('test-only-admin-secret');
    await confirm(dlg);
    await dlg.waitFor({ state: 'detached' });
    await shell.getByRole('button', { name: '检查 /health' }).click();
    await shell.getByRole('status').filter({ hasText: '后台健康检查通过' }).waitFor();
    await openTab(page, 'users');
    const row = shell.getByRole('row').filter({ hasText: sample.email });
    await row.getByRole('switch').click();
    await shell.getByRole('status').filter({ hasText: 'HTTP 403' }).waitFor();
    assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), 'true');
    const patch = seen.find((x) => x.method === 'PATCH');
    assert.equal(patch.body.enabled, false);
    assert.equal(patch.headers['x-admin-secret'], 'test-only-admin-secret');
    assert.equal(patch.headers.authorization, undefined);
    assert.equal(patch.headers['x-workspace-id'], undefined);
    assert.equal(seen.find((x) => x.path.endsWith('/health')).headers['x-admin-secret'], undefined);
    await openTab(page, 'server');
    const downloaded = page.waitForEvent('download');
    await shell.getByRole('button', { name: '导出配置 JSON' }).click();
    assert.ok(!(await readFile(await (await downloaded).path(), 'utf8')).includes('test-only-admin-secret'));
    await page.reload();
    await shell.getByText('未设置', { exact: true }).first().waitFor();
    await openTab(page, 'users');
    await shell.getByRole('alert').filter({ hasText: '重新输入' }).waitFor();
  }
);

test(
  'blocked local storage and unprivileged accounts have separate administrative outcomes',
  browserTest,
  async (t) => {
    const { page, app, open, origin } = await createStudioFixture(t);
    await page.addInitScript(() =>
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('Disabled', 'SecurityError');
        }
      })
    );
    await selectDemo(page, open);
    await openTab(page, 'users');
    const shell = panelOf(page),
      dlg = dialogOf(page);
    await shell.getByRole('status').filter({ hasText: '浏览器存储不可用' }).waitFor();
    await shell.getByRole('button', { name: '新增用户' }).click();
    await dlg.getByLabel('姓名').fill('内存用户');
    await dlg.getByLabel('邮箱').fill('memory@example.test');
    await confirm(dlg);
    await dlg.waitFor({ state: 'detached' });
    await openTab(page, 'credits');
    await openTab(page, 'users');
    await shell.getByText('memory@example.test', { exact: true }).waitFor();
    // A real personal workspace owner is not a platform administrator.
    const identity = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: await registrationPayload(app, {
        type: 'personal',
        email: crypto.randomUUID() + '@example.test',
        password: 'personal-test-secret',
        displayName: '个人用户'
      })
    });
    assert.equal(identity.statusCode, 201, identity.body);
    const { token, workspaces } = identity.json();
    await page.evaluate(
      ({ token, workspace }) => {
        sessionStorage.setItem('fai.live.session', token);
        sessionStorage.setItem('fai.live.workspace', workspace);
      },
      { token, workspace: workspaces[0].id }
    );
    await page.reload();
    await page.getByRole('alert').filter({ hasText: '仅供企业工作区' }).waitFor();
    await page.goto(origin + '/#settings');
    await page.locator('#main h1').filter({ hasText: '设置与诊断' }).waitFor();
    assert.equal(await page.locator('.admin-entry-card').count(), 0);
    assert.equal(await page.locator('[data-account-admin]').isHidden(), true);
  }
);

test(
  'concurrent admin tabs preserve both adjustments and workspace scopes stay isolated',
  browserTest,
  async (t) => {
    const { page, open, origin, session, workspace } = await createStudioFixture(t);
    await selectDemo(page, open);
    await open('admin/overview', '.adm-kpi-grid');
    const second = await page.context().newPage();
    await second.goto(origin + '/#admin/overview');
    await second.locator('.adm-kpi-grid').waitFor();
    const args = { account: session.account, workspace: session.workspaces.find((w) => w.id === workspace) };
    const adjust = async (tab) =>
      tab.evaluate(async (args) => {
        const { adminAction } = await import('/studio/admin-data.js');
        const ctx = { ...args, signal: new AbortController().signal, active: () => true };
        return adminAction(ctx, 'adjust', {
          userId: args.account.id,
          delta: 5,
          reason: '并发调账',
          amountCents: 0
        });
      }, args);
    await Promise.all([adjust(page), adjust(second)]);
    const result = await page.evaluate(async (args) => {
      const { adminData, connection, saveConnection } = await import('/studio/admin-data.js');
      const ctx = { ...args, signal: new AbortController().signal, active: () => true };
      const state = await adminData(ctx, 'credits');
      const otherCtx = { ...ctx, workspace: { ...ctx.workspace, id: crypto.randomUUID() } };
      await saveConnection(otherCtx, connection(ctx));
      const other = await adminData(otherCtx, 'overview');
      return [state.users[0].balance, state.ledger.length, other.totals.credits];
    }, args);
    assert.deepEqual(result, [10, 2, 0]);
  }
);
