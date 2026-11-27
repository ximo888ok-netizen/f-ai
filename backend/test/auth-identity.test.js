import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, row } from '../src/db.js';
import { cutoverWorkspace } from '../src/workspace-cutover.js';

const db = new PGlite();
const deliveries = new Map();
const password = 'test-account-password';
const captchaAnswer = '48275';
let app;
let legacy;

before(async () => {
  await db.exec(await readFile(new URL('../migrations/001_platform.sql', import.meta.url), 'utf8'));
  await db.query('CREATE TABLE migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await db.query("INSERT INTO migrations(name) VALUES('001_platform.sql')");
  legacy = await originalIdentity();
  await migrate(db);
  app = await buildApp({ db, authVerification: {
    sms: async (target, code) => deliveries.set(target, code),
    email: async (target, code) => deliveries.set(target, code),
    captchaAnswer: () => captchaAnswer,
  } });
  await app.ready();
});
after(async () => {
  await app?.close();
  await db.close();
});

async function call(endpoint, payload, expected, headers) {
  const result = await app.inject({ url: '/v1/' + endpoint, method: payload ? 'POST' : 'GET', payload, headers });
  assert.equal(result.statusCode, expected, result.body);
  return result.json();
}

async function codes(email, phone) {
  const flowId = randomUUID();
  for (const [channel, target] of [['email', email], ['sms', phone]]) {
    await call('auth/verification-codes', { channel, target, flowId }, 200);
  }
  return { flowId, emailCode: deliveries.get(email), phoneCode: deliveries.get(phone) };
}

async function login(identifier, pass = password) {
  const { id: captchaId } = await call('auth/captcha', null, 200);
  return { identifier, password: pass, captchaId, captchaAnswer };
}

const passwordHash = '0123456789abcdef0123456789abcdef:' +
  scryptSync(password, '0123456789abcdef0123456789abcdef', 64).toString('hex');

async function legacyAccount(email) {
  const id = randomUUID();
  await db.query(`INSERT INTO accounts(id,email,password_hash,display_name,account_type)
    VALUES($1,$2,$3,'Legacy name','personal')`, [id, email, passwordHash]);
  return id;
}

async function originalIdentity() {
  const email = 'legacy-member@example.test';
  const id = await legacyAccount(email);
  const priorToken = randomBytes(32).toString('base64url');
  const hash = value => createHash('sha256').update(value).digest('hex');
  await db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour')", [hash(priorToken), id]);
  const workspaceId = randomUUID();
  await db.query("INSERT INTO workspaces(id,kind,name) VALUES($1,'enterprise','Legacy business')", [workspaceId]);
  await db.query("INSERT INTO memberships(workspace_id,account_id,role) VALUES($1,$2,'admin')", [workspaceId, id]);
  const invitation = randomBytes(32).toString('base64url');
  const invitationWorkspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,kind,name) VALUES($1,'enterprise','Inviting business')", [invitationWorkspace]);
  await db.query(`INSERT INTO invitations(token_hash,workspace_id,email,role,expires_at)
    VALUES($1,$2,$3,'member',now()+interval '1 hour')`, [hash(invitation), invitationWorkspace, email]);
  return { email, id, priorToken, workspaceId, invitation, invitationWorkspace };
}

test('old registration and password-only login cannot create a session', async () => {
  const email = 'old-form@example.test';
  await call('auth/register', { email, password, type: 'personal', displayName: 'Old form' }, 400);
  const id = await legacyAccount(email);
  await call('auth/login', { email, password }, 400);
  await call('auth/login', { identifier: email, password }, 400);
  assert.equal((await row(db, 'SELECT count(*)::int AS n FROM sessions WHERE account_id=$1', [id])).n, 0);
});

test('verified personal identity logs in with normalized username or phone and requires a fresh CAPTCHA', async () => {
  const email = 'personal@example.test';
  const phone = '+8613800000123';
  const verified = await codes(email, phone);
  const payload = {
    email: email.toUpperCase(), username: '星河Ａbc', phone: '13800000123', type: 'personal', password, ...verified,
  };
  for (const field of ['emailCode', 'phoneCode']) {
    const incorrect = verified[field] === '000000' ? '111111' : '000000';
    assert.equal((await call('auth/register', { ...payload, [field]: incorrect }, 400)).error.code, 'VERIFICATION_CODE_INVALID');
  }
  assert.equal(await row(db, 'SELECT id FROM accounts WHERE email=$1', [email]), undefined);
  const session = await call('auth/register', payload, 201);
  const identity = await row(db, `SELECT username,phone,phone_verified_at,email_verified_at FROM accounts WHERE id=$1`, [session.account.id]);
  assert.equal(identity.username, '星河abc');
  assert.equal(identity.phone, phone);
  assert.ok(identity.phone_verified_at && identity.email_verified_at);
  assert.equal(session.account.email, email);
  assert.equal(session.workspaces[0].role, 'owner');
  const credentials = await login('星河AbC');
  assert.equal((await call('auth/login', credentials, 200)).account.id, session.account.id);
  assert.equal((await call('auth/login', credentials, 400)).error.code, 'CAPTCHA_INVALID');
  assert.equal((await call('auth/login', await login('13800000123'), 200)).account.id, session.account.id);
  await call('auth/login', await login(phone, 'incorrect-password'), 401);
  const emailLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: await login(email) });
  assert.ok([400, 401].includes(emailLogin.statusCode));
});

test('verified contacts cannot register a duplicate identity and conflicting writes roll back', async () => {
  const email = 'unique@example.test';
  const phone = '+12025550179';
  const candidate = { email, phone, username: 'Unique-1', password, type: 'agent', ...await codes(email, phone) };
  const blocker = await legacyAccount('taken@example.test');
  await db.query(`UPDATE accounts SET username='unique-1',phone='+12025550177',
    phone_verified_at=now(),email_verified_at=now() WHERE id=$1`, [blocker]);
  assert.equal((await call('auth/register', candidate, 409)).error.code, 'USERNAME_IN_USE');
  await db.query('UPDATE accounts SET username=$2,phone=$3 WHERE id=$1', [blocker, 'other-user', phone]);
  assert.equal((await call('auth/register', candidate, 409)).error.code, 'PHONE_IN_USE');
  await db.query('UPDATE accounts SET email=$2,phone=$3 WHERE id=$1', [blocker, email, '+12025550177']);
  assert.equal((await call('auth/register', candidate, 409)).error.code, 'EMAIL_IN_USE');
  await db.query('DELETE FROM accounts WHERE id=$1', [blocker]);
  for (const username of ['13800000123', 'bad@account', '...']) {
    await call('auth/register', { ...candidate, username }, 400);
  }
  const session = await call('auth/register', candidate, 201);
  assert.equal(session.account.type, 'agent');
  assert.equal(session.workspaces[0].kind, 'agent');
});

test('upgrade requires the old password, consumes both codes and preserves identity, sessions and invitations', async () => {
  const { email, id, priorToken, workspaceId, invitation, invitationWorkspace } = legacy;
  const phone = '+12025550181';
  const payload = { email, phone, username: 'Member-1', password, ...await codes(email, phone) };
  assert.equal((await call('auth/upgrade', { ...payload, flowId: randomUUID() }, 400)).error.code, 'VERIFICATION_CODE_INVALID');
  await call('auth/upgrade', { ...payload, password: 'incorrect-password' }, 401);
  const upgraded = await call('auth/upgrade', payload, 200);
  assert.equal(upgraded.account.id, id);
  assert.equal(upgraded.account.displayName, 'Legacy name');
  assert.deepEqual(upgraded.workspaces, [{ id: workspaceId, name: 'Legacy business', kind: 'enterprise', role: 'admin' }]);
  const headers = { authorization: 'Bearer ' + priorToken };
  assert.equal((await call('auth/me', null, 200, headers)).account.id, id);
  const accepted = await call('invitations/accept', { token: invitation }, 200, headers);
  assert.ok(accepted.workspaces.some(w => w.id === invitationWorkspace && w.role === 'member'));
  assert.equal((await call('auth/login', await login('member-1'), 200)).account.id, id);
  assert.equal((await call('auth/upgrade', payload, 400)).error.code, 'VERIFICATION_CODE_INVALID');
});

test('upgrade of a completed account cannot issue another session even with fresh valid proofs', async () => {
  const email = 'upgraded@example.test';
  const phone = '+12025550183';
  const id = await legacyAccount(email);
  await db.query(`UPDATE accounts SET username='already-bound', phone='+12025550184',
    phone_verified_at=now(), email_verified_at=now() WHERE id=$1`, [id]);
  await call('auth/upgrade', { email, phone, password, username: 'replacement', ...await codes(email, phone) }, 401);
  assert.equal((await row(db, 'SELECT count(*)::int AS n FROM sessions WHERE account_id=$1', [id])).n, 0);
});

test('enterprise cutover keeps login identifiers, proofs and sessions in the control database', async () => {
  const email = 'business@example.test';
  const phone = '+12025550186';
  const payload = { email, phone, password, username: 'business', type: 'enterprise', ...await codes(email, phone) };
  await call('auth/register', payload, 400);
  const session = await call('auth/register', { ...payload, workspaceName: 'Test enterprise' }, 201);
  const target = new PGlite();
  try {
    await migrate(target);
    assert.equal((await cutoverWorkspace(db, target, session.workspaces[0].id, 'dedicated')).state, 'active');
    const directory = await row(target, 'SELECT username,phone,password_hash FROM accounts WHERE id=$1', [session.account.id]);
    assert.deepEqual(directory, { username: null, phone: null, password_hash: 'managed-by-control-database' });
    for (const table of ['auth_contact_codes', 'auth_captchas', 'sessions']) {
      assert.equal((await row(target, 'SELECT count(*)::int AS n FROM ' + table)).n, 0);
    }
  } finally {
    await target.close();
  }
});
