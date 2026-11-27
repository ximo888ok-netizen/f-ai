import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { watchControls } from '../test-support/ui-control-report.js';

const playwrightPath = process.env.FAI_TEST_PLAYWRIGHT_PATH;
import { studioRoutes, merchantRoutes, categories } from '../test-support/studio-routes.js';

async function routesFrom(page, origin, filename) {
  const response = await page.request.get(origin + '/studio/' + filename);
  assert.equal(response.status(), 200, filename);
  const source = await response.text();
  const body = /^const pages = \{([\s\S]*?)^\};/m.exec(source)?.[1];
  assert.ok(body, 'Route registry missing in ' + filename);
  return [...body.matchAll(/(?:^|,)\s*['"]?([a-z][a-z-]*)['"]?:\s*\[/gm)].map(entry => entry[1]);
}

test('Chrome renders all registered business routes and key categories against the served APIs',
  { skip: !playwrightPath, timeout: 150000 }, async t => {
    const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
    let app, browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally {
        try { await app?.close(); }
        finally { await db.close(); }
      }
    });
    await migrate(db);
    app = await buildApp({ db, providers: createProviders(), shops: new Map() });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const registration = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: {
      email: randomUUID() + '@example.test', password: 'navigation-test-only',
      type: 'enterprise', workspaceName: '导航验收', displayName: '导航验收',
    } });
    assert.equal(registration.statusCode, 201, registration.body);
    const { token, workspaces } = registration.json();
    const workspace = workspaces[0].id;
    const copyRules = await app.inject({ method: 'PUT', url: '/v1/copywriting/rules/pinduoduo',
      headers: { authorization: 'Bearer ' + token, 'x-workspace-id': workspace },
      payload: { revision: 0, titleLimit: 30, sellingPointLimit: 20, forbiddenPhrases: ['测试禁用词'] },
    });
    assert.equal(copyRules.statusCode, 200, copyRules.body);

    browser = await createRequire(import.meta.url)(playwrightPath).chromium.launch({
      channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'],
    });
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await watchControls(t, page.context());
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(({ token, workspace }) => {
      sessionStorage.setItem('fai.live.session', token);
      sessionStorage.setItem('fai.live.workspace', workspace);
    }, { token, workspace });
    assert.deepEqual((await routesFrom(page, origin, 'live.js')).sort(), [...studioRoutes].sort());
    assert.deepEqual((await routesFrom(page, origin, 'merchant.js')).sort(), [...merchantRoutes].sort());

    const failures = [];
    let locationUnderTest = '/';
    page.on('pageerror', error => failures.push(locationUnderTest + ' ' + error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400) {
        failures.push(locationUnderTest + ' ' + response.status() + ' ' + response.request().method() + ' ' + url.pathname);
      }
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith('/v1/') && !['GET', 'HEAD'].includes(request.method())) {
        failures.push(locationUnderTest + ' unexpected mutation ' + request.method() + ' ' + url.pathname);
      }
    });
    page.setDefaultTimeout(5000);

    // Establish the signed-in session on a separate route before measuring SPA navigation.
    const [identity] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/v1/auth/me', {timeout:30000}),
      page.goto(origin + '/#account', {waitUntil:'domcontentloaded'}),
    ]);
    assert.equal(identity.status(),200);
    await page.locator('#profile:visible').waitFor({timeout:30000});

    async function checkRoute(pathname, fragment, main) {
      locationUnderTest = pathname + '#' + fragment;
      try {
        await page.evaluate(selector => {
          window.previousBusinessView = document.querySelector(selector)?.firstElementChild;
        }, main);
        await page.goto(origin + locationUnderTest, { waitUntil: 'commit' });
        await page.waitForFunction(selector => {
          const area = document.querySelector(selector);
          return area?.firstElementChild && area.firstElementChild !== window.previousBusinessView &&
            area.getBoundingClientRect().height > 0 && area.innerText.trim() &&
            !/正在读取(工作区|工作台|后台数据)…/.test(area.innerText);
        }, main, { timeout: 5000 });
        const area = page.locator(main);
        assert.equal(await area.locator('.live-error:visible, [data-retry]:visible, [data-form=auth]:visible').count(), 0,
          await area.innerText());
        assert.doesNotMatch(await area.innerText(), /后台读取失败|当前账号没有管理权限/);
        t.diagnostic('Browser navigation passed: ' + locationUnderTest);
      } catch (error) {
        failures.push(locationUnderTest + ' ' + error.message);
      }
    }

    for (const route of [...studioRoutes, ...categories]) {
      await checkRoute('/', route, route === 'home' ? '#commerce-directory' : '#main');
    }
    for (const route of merchantRoutes) await checkRoute('/merchant', route, '#merchantContent');
    await page.waitForLoadState('networkidle', { timeout: 5000 });
    assert.deepEqual(failures, []);
  });
