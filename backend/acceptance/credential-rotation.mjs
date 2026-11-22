import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { client } from './fixtures.mjs';

// Submit a SCRAM verifier, as psql's password command does. The SQL never contains a plaintext password.
function verifier(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const hmac = label => createHmac('sha256', salted).update(label).digest();
  return 'SCRAM-SHA-256$4096:' + salt.toString('base64') + '$' +
    createHash('sha256').update(hmac('Client Key')).digest('base64') + ':' + hmac('Server Key').toString('base64');
}

export async function rotationFixture({ work, application, env, port, Client, controlUrl, sql, cliLogs }) {
  const dir = join(work, 'encrypted');
  const keysFile = join(work, 'keys.dbkeys.json');
  await mkdir(dir, { mode: 0o700 });
  const keys = { first: randomBytes(32).toString('base64'), next: randomBytes(32).toString('base64') };
  const saveKeys = selected => writeFile(keysFile, JSON.stringify(selected), { mode: 0o600 });
  await saveKeys(keys);
  const credentialEnv = { DEDICATED_CREDENTIAL_DIR: dir, DEDICATED_CREDENTIAL_KEYS_FILE: keysFile };
  const oldPassword = randomBytes(24).toString('hex') + ':@/%';
  const newPassword = randomBytes(24).toString('hex') + ':@/%';
  const tenantUrl = (db, password) => 'postgresql://fai_tenant_qa:' + encodeURIComponent(password) + '@127.0.0.1:' + port + '/' + db;
  function credentialCommand(args, input, expected = 0) {
    const result = spawnSync(process.execPath, ['src/database-credentials.js', ...args], {
      env: { ...env, ...credentialEnv }, cwd: application, windowsHide: true, encoding: 'utf8', input, timeout: 15000 });
    cliLogs.push(result.stdout || '', result.stderr || '');
    assert.equal(result.status, expected, 'Unexpected credential CLI exit status');
  }
  async function withConnection(url, callback) {
    const db = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      await db.connect();
      return await callback(db);
    } finally { await db.end(); }
  }
  const rotate = password => withConnection(controlUrl, db =>
    db.query("ALTER ROLE fai_tenant_qa PASSWORD '" + verifier(password) + "'"));
  async function verifyConnection(password) {
    const { rows: [row] } = await withConnection(tenantUrl('tenant', password), db =>
      db.query('SELECT current_database() AS db, current_user AS role'));
    assert.deepEqual(row, { db: 'tenant', role: 'fai_tenant_qa' });
  }
  async function rejected(origin, session, sku) {
    const api = client(origin, session);
    assert.deepEqual(await api('GET', '/v1/workspace/database', 200), { mode: 'dedicated', state: 'unavailable' });
    const response = await api('POST', '/v1/studio/products', 503, { sku, name: 'Synthetic isolation check' });
    assert.equal(response.error.code, 'WORKSPACE_DATABASE_UNAVAILABLE');
  }
  const count = (db, sku) => sql(db, "SELECT count(*) FROM studio_products WHERE sku='" + sku + "'");
  await rotate(oldPassword);
  await verifyConnection(oldPassword);
  credentialCommand(['seal', 'qa', '1', 'first'], tenantUrl('tenant', oldPassword));
  return {
    connection(version) { return { ...credentialEnv, DEDICATED_DATABASES_JSON: JSON.stringify({ qa: { credentialVersion: version } }) }; },
    async exercise({ start, stop, session }) {
      credentialCommand(['seal', 'qa', '2', 'first'], tenantUrl('tenant', newPassword));
      await rotate(newPassword);
      await assert.rejects(verifyConnection(oldPassword), { code: '28P01' });
      await verifyConnection(newPassword);
      await rejected(await start(1), session, 'QA-OLD-PASSWORD');
      await stop();
      credentialCommand(['rewrap', 'qa', '2', '3', 'next']);
      await saveKeys({ next: keys.next });
      credentialCommand(['rewrap', 'qa', '2', '5', 'next'], undefined, 1);
      credentialCommand(['seal', 'qa', '4', 'next'], tenantUrl('restore_tenant', newPassword));
      const origin = await start(3);
      const api = client(origin, session);
      assert.deepEqual(await api('GET', '/v1/workspace/database', 200), { mode: 'dedicated', state: 'ready' });
      sql('postgres', 'ALTER DATABASE tenant ALLOW_CONNECTIONS false');
      try {
        sql('postgres', "SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname='tenant'");
        await rejected(origin, session, 'QA-DISCONNECTED');
      } finally { sql('postgres', 'ALTER DATABASE tenant ALLOW_CONNECTIONS true'); }
      await api('POST', '/v1/studio/products', 201, { sku: 'QA-RECOVERED', name: 'Synthetic recovered write' });
      for (const db of ['control', 'tenant']) {
        for (const sku of ['QA-OLD-PASSWORD', 'QA-DISCONNECTED']) assert.equal(count(db, sku), '0');
        assert.equal(count(db, 'QA-RECOVERED'), db === 'tenant' ? '1' : '0');
      }
      await stop();
    },
    async checkLogs({ appLog, pgLog, controlPassword }) {
      const service = await readFile(appLog, 'utf8');
      const postgres = await readFile(pgLog, 'utf8');
      assert.ok(service.includes('"status":503') && service.includes('HTTP request'), 'Missing failed HTTP request evidence');
      assert.ok(postgres.includes('fai_tenant_qa'), 'Missing PostgreSQL authentication evidence');
      assert.ok(cliLogs.some(line => line.includes('Credential operation failed')), 'Missing failed CLI evidence');
      const all = [service, postgres, ...cliLogs].join('\n');
      for (const secret of [oldPassword, newPassword, encodeURIComponent(oldPassword), encodeURIComponent(newPassword),
        oldPassword.slice(0, 48), newPassword.slice(0, 48), controlPassword, ...Object.values(keys)]) {
        assert.ok(!all.includes(secret), 'A database secret appeared in the captured logs');
      }
      console.log(JSON.stringify({ credentialRotation: 'passed', oldRoleLogin: '28P01', newRoleLogin: 'passed',
        wrappingKeyRotated: true, rejectedWriteStatus: [503, 503], rejectedControlRows: 0,
        rejectedTenantRows: 0, recoveredControlRows: 0, recoveredTenantRows: 1, logSecretMatches: 0 }));
    },
  };
}
