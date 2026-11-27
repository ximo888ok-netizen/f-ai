import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerStudio, studioPublicFiles } from '../src/studio.js';

// Fetch the same URLs a browser resolves, including lazy modules and nested CSS imports.
test('both workbench entry points serve their complete static dependency graph', async t => {
  const app = Fastify();
  t.after(() => app.close());
  registerStudio(app);
  const origin = 'http://studio.test';
  const queue = new Set(['/', '/merchant']);
  for (const path of queue) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 200, path);
    const type = response.headers['content-type'];
    const patterns = [];
    if (type.startsWith('text/html')) {
      patterns.push(/(?:src|href)=["'](\/studio\/[^"']+)["']/g);
    }
    if (type.startsWith('text/css') || type.startsWith('text/html')) {
      patterns.push(/url\(\s*["']?((?:\/studio\/|\.\.?\/|[\w-]+[./])[\w./-]+)["']?\s*\)/g);
    }
    if (type.startsWith('text/javascript')) {
      patterns.push(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.\.?\/[^"']+\.js)["']/g);
    }
    for (const pattern of patterns) {
      for (const [, reference] of response.body.matchAll(pattern)) {
        const asset = new URL(reference, origin + path);
        assert.equal(asset.origin, origin);
        queue.add(asset.pathname);
      }
    }
  }
  for (const path of ['/studio/image-generation/product-plans.js', '/studio/media-skill-desk.js',
    '/studio/live-commerce-sdk.js', '/studio/live-copy-drafts.js', '/studio/merchant.js', '/studio/dot-matrix-switch.js']) {
    assert.ok(queue.has(path), 'Entry points must reach ' + path);
  }
  t.diagnostic('Validated ' + queue.size + ' page and asset URLs');
});
test('customer HTML and scripts contain no merchant dashboard destinations', async t => {
  const app = Fastify();
  t.after(() => app.close());
  registerStudio(app);
  for (const file of studioPublicFiles.filter(f => f === 'ai.html' || (f.endsWith('.js') && !f.startsWith('merchant')))) {
    const response = await app.inject({ method:'GET', url:file === 'ai.html' ? '/' : '/studio/' + file });
    assert.equal(response.statusCode,200,file);
    assert.ok(!/["'`]\/(?:merchant|platform-admin)(?:[#/?"'`]|$)|id="merchantLink"/.test(response.body), file + ' exposes an admin destination');
  }
  assert.equal((await app.inject({url:'/merchant'})).statusCode,200);
});
