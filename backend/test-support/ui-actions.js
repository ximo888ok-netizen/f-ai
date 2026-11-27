import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { createVideoDelivery } from '../src/video-delivery.js';
import { provisionCredits } from '../src/wallet.js';
import { startWorker } from '../src/worker.js';
import { watchControls } from './ui-control-report.js';

export async function createStudioFixture(t, { configureProviders, credits = 500, ...appOptions } = {}) {
  const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
  let app, browser, stop;
  const errors = [];
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await stop?.(); }
      finally {
        try { await app?.close(); }
        finally { await db.close(); }
      }
    }
    assert.deepEqual(errors, [], 'Uncaught application errors');
  });
  await migrate(db);
  const providers = createProviders();
  await configureProviders?.(providers);
  const shops = appOptions.shops ?? new Map();
  const { FAI_TEST_FFMPEG_PATH: ffmpeg, FAI_TEST_FFPROBE_PATH: ffprobe } = process.env;
  const videoDelivery = ffmpeg && ffprobe ? createVideoDelivery({ ffmpeg, ffprobe, encoder: 'libx264' }) : null;
  app = await buildApp({ db, providers, shops, videoDelivery, ...appOptions });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  stop = startWorker({ db, providers, shops }, app.log);
  const registration = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: {
    email: randomUUID() + '@example.test', password: 'synthetic-action-fixture',
    type: 'enterprise', workspaceName: '按钮验收企业', displayName: '按钮验收人员',
  } });
  assert.equal(registration.statusCode, 201, registration.body);
  const session = registration.json();
  const workspace = session.workspaces[0].id;
  if (credits) await provisionCredits(db, workspace, session.account.id, credits, 'ui-action-fixture');
  const headers = { authorization: 'Bearer ' + session.token, 'x-workspace-id': workspace };
  const api = async (method, path, payload) => {
    const result = await app.inject({ method, url: path, headers, payload });
    assert.ok(result.statusCode >= 200 && result.statusCode < 300, method + ' ' + path + ' ' + result.statusCode + ' ' + result.body);
    return result.body ? result.json() : undefined;
  };
  browser = await createRequire(import.meta.url)(process.env.FAI_TEST_PLAYWRIGHT_PATH).chromium.launch({
    channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 960 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(({ origin, token, workspace }) => {
    if (location.origin !== origin || sessionStorage.getItem('action-fixture-initialized')) return;
    sessionStorage.setItem('fai.live.session', token);
    sessionStorage.setItem('fai.live.workspace', workspace);
    sessionStorage.setItem('action-fixture-initialized', '1');
  }, { origin, token: session.token, workspace });
  await watchControls(t, context);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  const open = async (hash, target) => {
    const url = origin + (hash.startsWith('/') ? hash : '/#' + hash.replace(/^#/, ''));
    if (page.url() === url) await page.reload({waitUntil:'commit'});
    else await page.goto(url,{waitUntil:'commit'});
    await page.waitForFunction(() => {
      const root = document.querySelector(location.pathname === '/merchant' ? '#merchantContent' : '#main');
      return document.querySelector('#commerce-directory')?.getBoundingClientRect().height ||
        (root?.firstElementChild && root.innerText.trim() && !/正在读取(工作区|工作台|后台数据)…/.test(root.innerText));
    });
    if (target) await (typeof target === 'string' ? page.locator(target) : target).waitFor();
  };
  const act = async (label, locator, { method, path, status } = {}) => {
    const node = typeof locator === 'string' ? page.locator(locator) : locator;
    if (!path) {
      await node.click();
      t.diagnostic('UI action: ' + label);
      return;
    }
    assert.ok(method, label + ' requires an HTTP method');
    const [request] = await Promise.all([page.waitForRequest(r => {
      const u = new URL(r.url());
      return u.origin === origin && r.method() === method &&
        (path instanceof RegExp ? path.test(u.pathname) : u.pathname === path);
    }), node.click()]);
    const response = await request.response();
    assert.ok(response,label+' request was interrupted');
    assert.ok(status === undefined ? response.ok() : response.status() === status,
      label + ' ' + method + ' ' + new URL(response.url()).pathname + ' HTTP ' + response.status());
    t.diagnostic('UI action: ' + label + ' → ' + method + ' ' + new URL(response.url()).pathname + ' ' + response.status());
    return response;
  };
  return { page, browser, origin, app, db, providers, shops, session, workspace, headers, api,
    read: path => api('GET', path), open, act };
}
