import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('merchant directory controls page records, switch enterprises and handle personal sign-in in Chrome',
  { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 180000 }, async t => {
    const { page, app, db, session, workspace, open, act } = await createStudioFixture(t);
    const secondWorkspace = randomUUID();
    const personalEmail = randomUUID() + '@example.test';
    const password = 'merchant-personal-qa-only';
    const registered = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: {
      email: personalEmail, password, type: 'personal', displayName: '商家权限测试个人账号',
    } });
    assert.equal(registered.statusCode, 201, registered.body);
    const personal = registered.json();

    await db.transaction(async tx => {
      await tx.query("INSERT INTO workspaces(id,kind,name) VALUES($1,'enterprise','第二验收企业')", [secondWorkspace]);
      await tx.query("INSERT INTO memberships(workspace_id,account_id,role) VALUES($1,$2,'owner')", [secondWorkspace, session.account.id]);
      const ids = Array.from({ length: 26 }, () => randomUUID());
      await tx.query(`INSERT INTO invitations(id,token_hash,workspace_id,email,role,expires_at)
        SELECT id,id::text,$1,id::text || '@example.test','member',now() + interval '1 day'
        FROM unnest($2::uuid[]) AS entries(id)`, [workspace, ids]);
      await tx.query(`INSERT INTO projects(id,workspace_id,name)
        SELECT id,$1,'分页项目 ' || ordinal FROM unnest($2::uuid[]) WITH ORDINALITY AS entries(id,ordinal)`, [workspace, ids]);
      const roster = Array.from({ length: 25 }, () => randomUUID());
      await tx.query(`INSERT INTO accounts(id,email,password_hash,display_name,account_type)
        SELECT id,id::text || '@example.test','pagination-fixture-only','分页成员 ' || position,'personal'
        FROM unnest($1::uuid[]) WITH ORDINALITY AS entries(id,position)`, [roster]);
      await tx.query(`INSERT INTO memberships(workspace_id,account_id,role)
        SELECT $1,id,'member' FROM unnest($2::uuid[]) AS entries(id)`, [workspace, roster]);
      const events = Array.from({ length: 31 }, () => randomUUID());
      await tx.query(`INSERT INTO merchant_events(id,workspace_id,actor_id,scope,action,target_id,detail,request_id)
        SELECT id,$1,$2,'workspace','test.pagination','merchant-pagination-target','{}'::jsonb,'pagination-fixture'
        FROM unnest($3::uuid[]) AS entries(id)`, [workspace, session.account.id, events]);
    });

    await open('/merchant#audit', page.getByRole('heading', { name: '管理操作记录', exact: true }));
    await page.bringToFront();
    const audit = page.locator('[data-form=audit-filter]');
    await audit.locator('[name=action]').fill('test.pagination');
    await audit.locator('[name=targetId]').fill('merchant-pagination-target');
    const auditPath = '/v1/merchant/audit-events';
    const auditSubmit = audit.getByRole('button', { name: '查询' });
    const previousForm = await audit.elementHandle();
    const firstAudit = await act('读取可分页审计记录', auditSubmit, { method: 'GET', path: auditPath });
    assert.equal(new URL(firstAudit.url()).searchParams.get('action'), 'test.pagination');
    assert.equal((await firstAudit.json()).hasMore, true);
    await previousForm.waitForElementState('hidden');
    const nextAudit = await act('按游标查看下一页审计', page.locator('[data-audit-next]'), { method: 'GET', path: auditPath });
    assert.ok(new URL(nextAudit.url()).searchParams.has('beforeId'));
    assert.equal((await nextAudit.json()).items.length, 1);
    const latestAudit = await act('返回最新审计记录', page.locator('[data-audit-reset]'), { method: 'GET', path: auditPath });
    assert.ok(!new URL(latestAudit.url()).searchParams.has('beforeId'));
    await page.locator('[data-audit-next]').waitFor();

    await act('从审计页点击进入成员清单', page.locator('#nav a[href="#members"]'), { method: 'GET', path: '/v1/members' });
    await page.getByRole('heading', { name: '成员与邀请', exact: true }).waitFor();

    async function pagination(name, attr, path) {
      let rows;
      for (const [offset, count] of [[25, 1], [0, 25]]) {
        const control = page.locator(`[data-${attr}="${offset}"]`);
        const response = await act(name + (offset ? '翻到下一页' : '返回上一页'), control, { method: 'GET', path });
        assert.equal(new URL(response.url()).searchParams.get('offset'), String(offset));
        rows = (await response.json()).items;
        assert.equal(rows.length, count);
      }
      return rows;
    }
    const members = page.locator('[data-form=filters]');
    const filterInput = members.locator('[name=q]');
    const filterButton = members.getByRole('button', { name: '筛选' });
    await filterInput.fill('分页成员 25');
    const filtered = await act('应用成员分页前的筛选', filterButton, { method: 'GET', path: '/v1/members' });
    assert.equal((await filtered.json()).items.length, 1);
    await page.locator('#merchantContent [data-page="25"]').waitFor({ state: 'hidden' });
    await filterInput.fill('');
    const reset = await act('清除成员筛选并载入完整清单', filterButton, { method: 'GET', path: '/v1/members' });
    assert.equal((await reset.json()).items.length, 25);
    await pagination('成员记录', 'page', '/v1/members');
    await pagination('邀请记录', 'invite-page', '/v1/invitations');

    const enterprise = page.locator('#merchantWorkspace');
    for (const company of [secondWorkspace, workspace]) {
      const [response] = await Promise.all([page.waitForResponse(result => {
        const request = result.request();
        return new URL(result.url()).pathname === '/v1/invitations' && request.headers()['x-workspace-id'] === company;
      }), enterprise.selectOption(company)]);
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).items.length, company === secondWorkspace ? 0 : 25);
      assert.equal(await enterprise.inputValue(), company);
      t.diagnostic('UI action: 切换商家后台企业并核对相应邀请清单 → GET /v1/invitations 200');
    }

    await act('进入商家项目清单', page.locator('#nav a[href="#projects"]'), { method: 'GET', path: '/v1/projects' });
    const [project] = await pagination('商家项目', 'page', '/v1/projects');
    const detail = await act('点击管理项目进入详情', page.locator(`#merchantContent a[href="#projects/${project.id}"]`),
      { method: 'GET', path: '/v1/projects/' + project.id });
    assert.equal((await detail.json()).name, project.name);
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor();

    const login = page.locator('[data-form=login]');
    const logout = page.locator('#merchantLogout');
    const logoutRoute = { method: 'POST', path: '/v1/auth/logout', status: 204 };
    async function signIn(label, email, secret, accountId) {
      await login.locator('[name=email]').fill(email);
      await login.locator('[name=password]').fill(secret);
      const response = await act(label, login.getByRole('button', { name: '登录', exact: true }), { method: 'POST', path: '/v1/auth/login' });
      assert.equal((await response.json()).account.id, accountId);
    }
    await act('从商家后台退出企业会话', logout, logoutRoute);
    await signIn('从商家后台重新登录企业所有者', session.account.email, 'synthetic-action-fixture', session.account.id);
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor();
    await act('退出企业会话以验证个人账号权限', logout, logoutRoute);
    await signIn('在商家后台登录个人账号', personalEmail, password, personal.account.id);
    await page.getByRole('heading', { name: '当前账号没有管理权限', exact: true }).waitFor();
    await act('从无管理权限提示点击切换账号', page.locator('[data-sign-out]'), logoutRoute);
    await login.waitFor();
    assert.equal(await page.evaluate(() => Boolean(sessionStorage.getItem('fai.live.session'))), false);
  });
