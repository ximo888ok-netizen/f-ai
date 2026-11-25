import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { seedPreviewAdmin } from '../src/auth.js';
import { migrate } from '../src/db.js';

test('the preview admin uses a regular workspace session and only the preview accepts its alias', async t => {
  const db = new PGlite();
  const preview = await buildApp({ db, previewAdmin: true });
  const standard = await buildApp({ db });
  t.after(async () => { await Promise.all([preview.close(), standard.close()]); await db.close(); });
  await migrate(db);
  await seedPreviewAdmin(db, 'local');
  const login = (app, password) => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin', password } });

  assert.equal((await login(standard, 'local')).statusCode, 400);
  assert.equal((await login(preview, 'wrong')).statusCode, 401);
  const response = await login(preview, 'local');
  assert.equal(response.statusCode, 200);
  const { account, token, workspaces: [workspace] } = response.json();
  assert.equal(account.displayName, 'admin');
  assert.equal(workspace.role, 'owner');
  const context = await preview.inject({ method: 'GET', url: '/v1/merchant/context',
    headers: { authorization: 'Bearer ' + token, 'x-workspace-id': workspace.id } });
  assert.equal(context.statusCode, 200);
  const signup = await preview.inject({ method: 'POST', url: '/v1/auth/register',
    payload: { email: 'new@example.test', password: 'short', displayName: 'New', type: 'personal' } });
  assert.equal(signup.statusCode, 400);
});
