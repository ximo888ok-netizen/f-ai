import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('customer pages offer no merchant entry while direct merchant navigation preserves the signed-in workspace',
  { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 120000 }, async t => {
    const { page, origin, workspace, open } = await createStudioFixture(t);
    const recentResponses = [];
    const browserErrors = [];
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== origin || !(url.pathname.startsWith('/v1/') || response.request().isNavigationRequest() || response.status() >= 400)) return;
      recentResponses.push({ path: url.pathname, status: response.status() });
    });
    page.on('pageerror', error => browserErrors.push(error.message));
    await open('/merchant#members', page.getByRole('heading', { name: '成员与邀请', exact: true }));
    await page.bringToFront();

    async function crossDocument(label, navigate, destination, api, heading) {
      try {
        const [response] = await Promise.all([page.waitForResponse(result => {
          const url = new URL(result.url());
          return url.origin === origin && url.pathname === api && result.request().method() === 'GET';
        }, { timeout: 30000 }), page.waitForURL(url => url.origin === origin && url.pathname === destination,
          { waitUntil: 'commit', timeout: 30000 }),
        navigate()]);
        assert.equal(response.status(), 200);
        assert.equal((await response.request().allHeaders())['x-workspace-id'], workspace);
        assert.ok((await response.json()).items.length > 0);
        await heading.waitFor({ timeout: 15000 });
        assert.equal(await page.evaluate(() => Boolean(sessionStorage.getItem('fai.live.session'))), true);
        t.diagnostic('UI action: ' + label + ' → GET ' + api + ' 200');
      } catch (error) {
        const state = await page.evaluate(() => ({ path: location.pathname, fragment: location.hash,
          ready: document.readyState, sessionPresent: Boolean(sessionStorage.getItem('fai.live.session')),
          workspacePresent: Boolean(sessionStorage.getItem('fai.live.workspace')),
          main: document.querySelector(':is(#merchantContent,#commerce-directory,#main) h1')?.textContent ?? null,
        })).catch(() => ({ path: new URL(page.url()).pathname, documentAvailable: false }));
        t.diagnostic('Cross-document state: ' + JSON.stringify({ ...state, recentResponses, browserErrors }));
        const directory = process.env.FAI_UI_REPORT_DIR;
        if (directory) {
          const screenshot = join(directory, `platform-link-${destination === '/' ? 'workbench' : 'merchant'}.png`);
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: screenshot, timeout: 4000 }).catch(() => {});
        }
        throw error;
      }
    }

    await crossDocument('从商家后台返回同一标签页的工作台', () => page.getByRole('link', { name: '返回工作台', exact: true }).click({noWaitAfter:true}),
      '/', '/v1/plugins', page.locator('#commerce-directory').getByRole('heading', { name: '电商工作台' }));
    await page.locator('#profile').click();
    const adminLinks = page.locator('a[href^="/merchant"], #merchantLink');
    assert.equal(await adminLinks.count(),0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    const search = page.getByRole('dialog',{name:'查找功能'});
    await search.getByRole('searchbox').fill('商家后台');
    await search.getByText('没有匹配功能。',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    for (const hash of ['chat','projects','team','manager','capabilities/connections','cloud-assets','feishu','shops']) {
      await open(hash);
      assert.equal(await adminLinks.count(),0,hash);
      assert.equal(await page.locator('#main [data-retry],#main .live-error').count(),0,hash);
    }
    await crossDocument('直接访问已知商家后台地址', () => page.goto(origin + '/merchant#members',{waitUntil:'commit'}),
      '/merchant', '/v1/members', page.getByRole('heading', { name: '成员与邀请', exact: true }));
  });
