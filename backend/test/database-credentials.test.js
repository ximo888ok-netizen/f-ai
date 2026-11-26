import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { config } from '../src/config.js';
import { openCredential, sealCredential } from '../src/database-credentials.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dbcred-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'credentials');
  mkdirSync(dir, { mode: 0o700 });
  const keys = { first: randomBytes(32).toString('base64'), next: randomBytes(32).toString('base64') };
  const keyFile = join(root, 'test.dbkeys.json');
  const setKeys = value => writeFileSync(keyFile, JSON.stringify(value), { mode: 0o600 });
  setKeys(keys);
  const secret = randomBytes(24).toString('hex');
  const url = 'postgresql://test_user:' + secret + '@localhost/tenant?sslmode=disable';
  const env = { DATABASE_URL: 'postgres://localhost/control', DEDICATED_CREDENTIAL_DIR: dir,
    DEDICATED_CREDENTIAL_KEYS_FILE: keyFile, DEDICATED_DATABASES_JSON: '{"team":{"credentialVersion":1}}' };
  return { dir, env, keys, setKeys, secret, url, path: (alias, rev) => join(dir, 'db-' + alias + '.v' + rev + '.dbcred') };
}

test('dedicated credentials seal the entire URL and atomically preserve existing revisions', t => {
  const { dir, env, secret, url, keys, path } = fixture(t);
  sealCredential(env, 'team', 1, 'first', url);
  const initial = readFileSync(path('team', 1), 'utf8');
  for (const value of [secret, 'test_user', 'localhost', keys.first]) assert.ok(!initial.includes(value));
  assert.ok(config(env).dedicatedDatabases.get('team') === url);
  assert.throws(() => sealCredential(env, 'team', 1, 'next', url.replace('test_user', 'replacement_user')), /unused version/);
  assert.ok(readFileSync(path('team', 1), 'utf8') === initial);
  sealCredential(env, 'team', 2, 'first', url);
  const next = JSON.parse(readFileSync(path('team', 2)));
  assert.notEqual(next.iv, JSON.parse(initial).iv);
  assert.notEqual(next.data, JSON.parse(initial).data);
  assert.equal(readdirSync(dir).length, 2);
});

test('missing keys, swapped records, invalid registry and tampered credentials fail closed without echoing input', t => {
  const { env, keys, url, setKeys, path } = fixture(t);
  sealCredential(env, 'team', 1, 'first', url);
  for (const [alias, version] of [['other', 1], ['team', 2]]) {
    copyFileSync(path('team', 1), path(alias, version));
    assert.throws(() => openCredential(env, alias, version), /credential unavailable/);
  }
  const record = JSON.parse(readFileSync(path('team', 1)));
  for (const field of ['data', 'tag', 'iv']) {
    const damaged = Buffer.from(record[field], 'base64');
    damaged[0] ^= 1;
    writeFileSync(path('team', 1), JSON.stringify({ ...record, [field]: damaged.toString('base64') }));
    assert.throws(() => config(env), /credential unavailable/);
  }
  writeFileSync(path('team', 1), url);
  assert.throws(() => config(env), { message: 'Dedicated database credential unavailable or invalid' });
  writeFileSync(path('team', 1), JSON.stringify(record));
  for (const changed of [{}, { first: keys.next }, { first: url }]) {
    setKeys(changed);
    assert.throws(() => config(env), { message: 'Dedicated database credential unavailable or invalid' });
  }
  assert.throws(() => config({ ...env, DEDICATED_DATABASES_JSON: url }), { message: 'Invalid dedicated database registry' });
});

test('encrypted revisions reject ambiguous targets and aliases, and keep platform and tenant databases distinct', t => {
  const { env, url } = fixture(t);
  for (const [alias, rev, secret] of [['../team', 1, url], ['team', 0, url], ['team', 1, 'postgresql://localhost/tenant'],
    ['team', 1, url + '&host=elsewhere'], ['team', 1, url + '&password=override']]) {
    assert.throws(() => sealCredential(env, alias, rev, 'first', secret), /Cannot create dedicated credential/);
  }
  sealCredential(env, 'team', 1, 'first', url.replace('/tenant', '/%63ontrol'));
  assert.throws(() => config(env), /distinct PostgreSQL/);
});
