import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerStudio } from '../src/studio.js';

test('the backend serves the glass workbench page, merchant page and required browser modules', async t => {
  const app = Fastify();
  t.after(() => app.close());
  registerStudio(app);
  const paths = ['/', '/ai.html', '/merchant', '/studio/studio-entry.js', '/studio/image-generation/product-plans.js'];
  const missing = [];
  for (const url of paths) {
    const response = await app.inject({ method: 'GET', url });
    t.diagnostic('Glass entry GET ' + url + ' -> ' + response.statusCode);
    if (response.statusCode !== 200) missing.push(url);
  }
  assert.deepEqual(missing, []);
});
