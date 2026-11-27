import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { buildAuthTestApp, deliveredCode, fixtureCaptchaAnswer } from '../test-support/identity-fixture.js';

const playwrightPath = process.env.FAI_TEST_PLAYWRIGHT_PATH;
const password = 'studio-auth-test-password';

function action(page, selector, path) {
  return Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === path),
    page.locator(selector).click(),
  ]).then(([response]) => response);
}

async function fillDetails(page, email, phone, username) {
  const form = page.locator('form[data-auth-mode]');
  for (const [key, value] of Object.entries({ email, phone, username, password })) {
    await form.locator('[name="' + key + '"]').fill(value);
  }
  await form.getByRole('button', { name: '下一步' }).click();
  await form.locator('[name=phoneCode]').waitFor();
}

async function browserSetup(t, configured) {
  const db = new PGlite();
  t.after(async () => db.close());
  await migrate(db);
  const app = configured ? await buildAuthTestApp({ db }) : await buildApp({ db, authVerification: {} });
  t.after(async () => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await createRequire(import.meta.url)(playwrightPath).chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader'] });
  t.after(async () => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  return { page, app, db, origin };
}

test('server CAPTCHA, contact cooldowns, preserved form values and legacy merchant binding work in Chrome',
  { skip: !playwrightPath, timeout: 120000 }, async t => {
    const { page, app, db, origin } = await browserSetup(t, true);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin + '/?mode=light');
    const image = page.locator('[data-captcha-image]:visible');
    await image.waitFor();
    const firstImage = await image.getAttribute('src');
    const captcha = await action(page, '[data-refresh-captcha]', '/v1/auth/captcha');
    assert.equal(captcha.status(), 200);
    await page.waitForFunction(src => document.querySelector('[data-captcha-image]').src !== src, firstImage);
    assert.match(await image.getAttribute('src'), /^data:image\/png;base64,/);

    const identifier = page.getByLabel('用户名或手机号');
    await identifier.fill('old-owner@example.test');
    await page.locator('#entry-identifier-hint').filter({ hasText: '绑定旧账号' }).waitFor();
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByLabel('图形验证码', { exact: true }).fill(fixtureCaptchaAnswer);
    await page.locator('[data-form=auth] [type=submit]').click();
    await page.getByRole('alert').filter({ hasText: '原邮箱账号' }).waitFor();
    await identifier.fill('legacy-name');
    await page.getByLabel('图形验证码', { exact: true }).fill('wrong');
    const invalid = await action(page, '[data-form=auth] [type=submit]', '/v1/auth/login');
    assert.equal(invalid.status(), 400);
    await page.getByRole('alert').filter({ hasText: '图形验证码有误' }).waitFor();
    await image.waitFor();
    assert.equal(await page.getByLabel('用户名或手机号').inputValue(), 'legacy-name');
    assert.equal(await page.getByLabel('图形验证码', { exact: true }).inputValue(), '');

    const accountId = randomUUID(), workspaceId = randomUUID();
    const email = 'old-owner@example.test', phone = '+12025550144';
    const salt = randomBytes(16).toString('hex');
    await db.query('INSERT INTO accounts(id,email,password_hash,display_name,account_type) VALUES ($1,$2,$3,$4,$5)',
      [accountId, email, salt + ':' + scryptSync(password, salt, 64).toString('hex'), '原所有者', 'enterprise']);
    await db.query('INSERT INTO workspaces(id,kind,name) VALUES ($1,$2,$3)', [workspaceId, 'enterprise', '原工作区']);
    await db.query('INSERT INTO memberships(workspace_id,account_id,role) VALUES ($1,$2,$3)', [workspaceId, accountId, 'owner']);
    await page.goto(origin + '/merchant?theme=noir&mode=dark');
    await page.locator('[data-auth-view=upgrade]').click();
    await fillDetails(page, email, phone, 'legacy-name');
    const send = channel => action(page, '[data-send-code=' + channel + ']', '/v1/auth/verification-codes');
    const smsSent = await send('sms');
    assert.equal(smsSent.status(), 200);
    await page.locator('[data-send-status=sms]').filter({ hasText: '已发送' }).waitFor();
    assert.match(await page.locator('[data-send-code=sms]').textContent(), /秒后重发/);
    assert.ok(await page.locator('[data-send-code=sms]').isDisabled());

    // A request from another tab already reserved this email on the same registration flow.
    const { flowId } = smsSent.request().postDataJSON();
    const reserved = await app.inject({ method: 'POST', url: '/v1/auth/verification-codes',
      payload: { flowId, target: email, channel: 'email' } });
    assert.equal(reserved.statusCode, 200);
    assert.equal((await send('email')).status(), 429);
    await page.locator('[data-send-status=email]').filter({ hasText: '发送间隔过短' }).waitFor();
    assert.match(await page.locator('[data-send-code=email]').textContent(), /秒后重发/);
    const code = deliveredCode(app, 'email', email);
    await page.getByLabel('邮箱验证码', { exact: true }).fill(code);
    await page.getByRole('button', { name: '上一步' }).click();
    assert.equal(await page.getByLabel('原账号密码').inputValue(), password);
    assert.equal(await page.getByLabel('原账号邮箱').inputValue(), email);
    await page.getByRole('button', { name: '下一步' }).click();
    assert.equal(await page.getByLabel('邮箱验证码', { exact: true }).inputValue(), code);
    const sms = deliveredCode(app, 'sms', phone);
    await page.getByLabel('短信验证码', { exact: true }).fill(sms === '000000' ? '111111' : '000000');
    const failed = await action(page, '[type=submit]', '/v1/auth/upgrade');
    assert.equal(failed.status(), 400);
    await page.getByRole('alert').filter({ hasText: '短信或邮箱验证码有误' }).waitFor();
    assert.equal(await page.getByLabel('邮箱验证码', { exact: true }).inputValue(), code);
    await page.getByLabel('短信验证码', { exact: true }).fill(sms);
    const upgraded = await action(page, '[type=submit]', '/v1/auth/upgrade');
    assert.equal(upgraded.status(), 200);
    assert.equal((await upgraded.json()).account.id, accountId);
    await page.locator('#merchantWorkspace:visible').waitFor();
    assert.equal(await page.locator('#merchantWorkspace').inputValue(), workspaceId);
    await page.locator('#merchantLogout').click();
    await page.getByLabel('用户名或手机号').fill(phone);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await image.waitFor();
    await page.getByLabel('图形验证码', { exact: true }).fill(fixtureCaptchaAnswer);
    assert.equal((await action(page, '[data-form=login] [type=submit]', '/v1/auth/login')).status(), 200);
    await page.locator('#merchantWorkspace:visible').waitFor();
    assert.deepEqual(pageErrors, []);
  });

test('unconfigured verification channels expose errors on a narrow dark registration screen',
  { skip: !playwrightPath, timeout: 90000 }, async t => {
    const { page, origin, db } = await browserSetup(t, false);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(origin + '/?theme=glass&mode=dark');
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    assert.equal(await page.locator('.entry-art').isVisible(), false);
    await fillDetails(page, 'mobile@example.test', '+12025550145', '移动账号');
    for (const channel of ['sms', 'email']) {
      const response = await action(page, '[data-send-code=' + channel + ']', '/v1/auth/verification-codes');
      assert.equal(response.status(), 503);
      await page.locator('[data-send-status=' + channel + ']').filter({ hasText: '请联系管理员' }).waitFor();
      assert.equal(await page.locator('[data-send-code=' + channel + ']').isEnabled(), true);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
    for (const input of await page.locator('[data-verification] input').all()) {
      const box = await input.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 320);
    }

    const outage = await buildApp({ db, authVerification: { email: async () => { throw Error('delivery not acknowledged'); } } });
    t.after(async () => outage.close());
    const otherOrigin = await outage.listen({ host: '127.0.0.1', port: 0 });
    await page.goto(otherOrigin + '/merchant');
    await page.locator('[data-auth-view=upgrade]').click();
    await fillDetails(page, 'outage@example.test', '+12025550146', '旧账号');
    const failed = await action(page, '[data-send-code=email]', '/v1/auth/verification-codes');
    assert.equal(failed.status(), 502);
    await page.locator('[data-send-status=email]').filter({ hasText: '尚未确认发送' }).waitFor();
    assert.match(await page.locator('[data-send-code=email]').textContent(), /秒后重发/);
  });
test('reference login uses the local comparison images and keeps the live password and CAPTCHA form', {
  skip: !playwrightPath, timeout: 120000,
}, async t => {
  const {page, origin} = await browserSetup(t, false);
  for (const route of ['/', '/merchant']) {
    await page.goto(origin + route);
    await page.locator('[data-captcha-image]:visible').waitFor();
    const stage=page.locator('[data-entry-scene]');
    assert.equal(await stage.count(),1);
    const toggle=stage.getByRole('button', {name:'精修对比'});
    await toggle.focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-pressed'),'true');
    await toggle.click();
    const pass=page.locator('[name=password]');
    await pass.fill('local-test-secret');
    await page.getByRole('button',{name:'显示密码'}).click();
    assert.equal(await pass.getAttribute('type'),'text');
    await page.getByRole('button',{name:'隐藏密码'}).click();
    assert.equal(await pass.getAttribute('type'),'password');
    await pass.fill('');
    for(const width of [1440,390,320]) {
      await page.setViewportSize({width,height:width>900?900:760});
      const panel=page.locator('.studio-entry');
      const frame=await panel.boundingBox(), artwork=await stage.boundingBox();
      assert.ok(artwork.width>0 && frame.width>0);
      if(width>900) assert.ok(Math.abs(artwork.width/frame.width-.618)<.015);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.waitForFunction(()=>[...document.querySelectorAll('[data-entry-scene] img')].every(img=>img.complete && img.naturalWidth));
    }
    await page.setViewportSize({width:1280,height:800});
    await page.getByRole('button',{name:'创建账号',exact:true}).click();
    await page.locator('[data-auth-mode=register] [name=phone]').waitFor();
    assert.equal(await stage.count(),0);
  }
});
