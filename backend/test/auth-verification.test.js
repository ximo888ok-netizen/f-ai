import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { createAuthDelivery } from '../src/auth-delivery.js';
import { consumeCaptcha, verifyContactCodes } from '../src/auth-verification.js';
import { migrate } from '../src/db.js';

const db = new PGlite();
const delivered = new Map();
const delayed = { started: Promise.withResolvers(), acceptance: Promise.withResolvers() };
const phone = '+8613800138000';
const email = 'first@example.test';
const flowId = randomUUID();
let app;

before(async () => {
  await migrate(db);
  app = await buildApp({ db, authVerification: {
    captchaAnswer: () => '08347',
    sms: async (target, code) => delivered.set(target, code),
    email: async (target, code) => {
      delivered.set(target, code);
      if (target === 'unavailable@example.test') throw Error('private gateway detail');
      if (target === 'pending@example.test') {
        delayed.started.resolve();
        await delayed.acceptance.promise;
      }
    },
  } });
});
after(async () => { await app?.close(); await db.close(); });

function send(channel, target, flow = flowId, remoteAddress = '192.0.2.1') {
  return app.inject({ method: 'POST', url: '/v1/auth/verification-codes',
    payload: { channel, target, flowId: flow }, remoteAddress });
}
const invalid = { code: 'VERIFICATION_CODE_INVALID' };

test('CAPTCHA response is a one-use raster challenge and failed and expired answers cannot be retried', async () => {
  const issue = async () => {
    const result = await app.inject({ method: 'GET', url: '/v1/auth/captcha' });
    assert.equal(result.statusCode, 200, result.body.slice(0, 150));
    const challenge = result.json();
    assert.deepEqual(Object.keys(challenge).sort(), ['expiresIn', 'id', 'image']);
    assert.equal(challenge.expiresIn, 180);
    assert.match(challenge.image, /^data:image\/png;base64,iVBORw0KGgo/);
    return challenge.id;
  };
  const first = await issue();
  const bad = { code: 'CAPTCHA_INVALID' };
  await assert.rejects(consumeCaptcha(db, first, '00000'), bad);
  await assert.rejects(consumeCaptcha(db, first, '08347'), bad);
  const second = await issue();
  const results = await Promise.allSettled([consumeCaptcha(db, second, '08347'), consumeCaptcha(db, second, '08347')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CAPTCHA_INVALID');
  const expired = await issue();
  await db.query("UPDATE auth_captchas SET expires_at=now()-interval '1 second' WHERE id=$1", [expired]);
  await assert.rejects(consumeCaptcha(db, expired, '08347'), bad);
});

test('concurrent requests share recipient cooldown across flows and contact proofs commit with the account', async () => {
  const [sent, duplicate] = await Promise.all([send('sms', phone), send('sms', '13800138000', flowId)]);
  const responses = [sent, duplicate].sort((a,b) => a.statusCode - b.statusCode);
  assert.equal(responses[0].statusCode, 200, responses[0].body);
  assert.equal(responses[1].statusCode, 429, responses[1].body);
  assert.deepEqual(responses[0].json(), { resendAfter: 60, expiresIn: 300 });
  const acrossFlows = await send('sms', phone, randomUUID());
  assert.equal(acrossFlows.json().error.code, 'VERIFICATION_COOLDOWN');
  assert.ok(Number(acrossFlows.headers['retry-after']) > 0);
  assert.equal((await send('email', email.toUpperCase())).statusCode, 200);
  assert.match(delivered.get(phone), /^\d{6}$/);
  assert.match(delivered.get(email), /^\d{6}$/);
  const input = { flowId, phone, email, phoneCode: delivered.get(phone), emailCode: delivered.get(email) };
  const verify = (change = {}, done = () => 'created') => verifyContactCodes(db, { ...input, ...change }, done);
  await assert.rejects(verify({ flowId: randomUUID() }), invalid);
  await assert.rejects(verify({ email: 'other@example.test' }), invalid);
  await assert.rejects(verify({}, async () => { throw Error('duplicate account'); }), /duplicate account/);
  const results = await Promise.allSettled([verify(), verify()]);
  assert.equal(results.find(r => r.status === 'fulfilled').value, 'created');
  assert.equal(results.find(r => r.status === 'rejected').reason.code, invalid.code);
  assert.equal((await send('email', email, randomUUID())).statusCode, 429);
});

test('incorrect attempts persist across failed transactions and an expired OTP is refused', async () => {
  const email = 'attempts@example.test', phone = '+8613800138001', address = '192.0.2.2';
  assert.equal((await send('sms', phone, flowId, address)).statusCode, 200);
  assert.equal((await send('email', email, flowId, address)).statusCode, 200);
  const input = { flowId, email, phone, phoneCode: delivered.get(phone), emailCode: delivered.get(email) };
  const wrong = input.phoneCode === '000000' ? '111111' : '000000';
  const verify = changes => verifyContactCodes(db, { ...input, ...changes }, () => 'created');
  for (let i = 0; i < 5; i++) await assert.rejects(verify({ phoneCode: wrong }), invalid);
  await assert.rejects(verify({}), invalid);
  const alternate = '+8613800138002';
  assert.equal((await send('sms', alternate, flowId, address)).statusCode, 200);
  await db.query("UPDATE auth_contact_codes SET expires_at=now()-interval '1 second' WHERE target=$1", [alternate]);
  await assert.rejects(verify({ phone: alternate, phoneCode: delivered.get(alternate) }), invalid);
});

test('an upstream failure is explicit and limits apply per IP across recipients', async () => {
  const result = await send('email', 'unavailable@example.test', flowId, '192.0.2.3');
  assert.equal(result.statusCode, 502, result.body);
  assert.equal(result.json().error.code, 'VERIFICATION_DELIVERY_FAILED');
  assert.ok(!result.body.includes('private gateway detail'));
  const retryAfter = Number(result.headers['retry-after']);
  assert.ok(retryAfter > 0 && retryAfter <= 60, 'failed delivery must communicate its active cooldown');
  const immediateRetry = await send('email', 'unavailable@example.test', flowId, '192.0.2.3');
  assert.equal(immediateRetry.statusCode, 429);
  assert.ok(Number(immediateRetry.headers['retry-after']) <= retryAfter);
  const rejectedPhone = '+8613800138003';
  assert.equal((await send('sms', rejectedPhone, flowId, '192.0.2.3')).statusCode, 200);
  const rejectedEmail = 'unavailable@example.test';
  await assert.rejects(verifyContactCodes(db, { flowId, email: rejectedEmail, phone: rejectedPhone,
    emailCode: delivered.get(rejectedEmail), phoneCode: delivered.get(rejectedPhone) }, () => 'created'), invalid);
  for (let i = 0; i < 10; i++) {
    const r = await send('email', 'limit'+i+'@example.test', flowId, '192.0.2.4');
    assert.equal(r.statusCode, 200, r.body);
  }
  const limited = await send('email', 'limit10@example.test', flowId, '192.0.2.4');
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(delivered.has('limit10@example.test'), false);
});

test('pending deliveries cannot prove ownership and reissue after cooldown binds the new flow', async () => {
  const email = 'pending@example.test', phone = '+8613800138010', address = '192.0.2.5';
  const next = randomUUID();
  await send('sms', phone, flowId, address);
  const pending = send('email', email, flowId, address);
  const verify = flow => verifyContactCodes(db, { flowId: flow, email, phone,
    phoneCode: delivered.get(phone), emailCode: delivered.get(email) }, () => 'created');
  try {
    await Promise.race([delayed.started.promise, pending.then(() => assert.fail('delivery returned before acceptance'))]);
    await assert.rejects(verify(flowId), invalid);
    assert.equal((await send('email', email, next, address)).statusCode, 429);
  } finally { delayed.acceptance.resolve(); }
  assert.equal((await pending).statusCode, 200);
  await db.query("UPDATE auth_contact_codes SET resend_at=now()-interval '1 second' WHERE target IN ($1,$2)", [email, phone]);
  assert.equal((await send('sms', phone, next, address)).statusCode, 200);
  assert.equal((await send('email', email, next, address)).statusCode, 200);
  await assert.rejects(verify(flowId), invalid);
  assert.equal(await verify(next), 'created');
});

test('account transports require dedicated credentials and positive acknowledgements from both providers', async () => {
  const empty = createAuthDelivery({ SMS_BINDINGS_JSON: '[]' }, () => assert.fail('unexpected network request'));
  const unconfigured = await buildApp({ db, authVerification: empty });
  try {
    for (const [channel, target] of [['email', email], ['sms', phone]]) {
      const r = await unconfigured.inject({ method: 'POST', url: '/v1/auth/verification-codes', payload: { channel, target, flowId } });
      assert.equal(r.statusCode, 503, r.body);
      assert.equal(r.json().error.code, 'VERIFICATION_UNAVAILABLE');
    }
  } finally { await unconfigured.close(); }
  const env = { AUTH_EMAIL_RESEND_API_KEY: 'private-api-key', AUTH_EMAIL_FROM: 'accounts@example.test',
    AUTH_SMS_SECRET_ID: 'key-id', AUTH_SMS_SECRET_KEY: 'private-sms-key', AUTH_SMS_APP_ID: '1400000000',
    AUTH_SMS_SIGN_NAME: 'Approved', AUTH_SMS_TEMPLATE_ID: '1234' };
  const seen = [];
  let accepted = true;
  const delivery = createAuthDelivery(env, async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, init, body });
    if (!accepted) return Response.json({});
    if (url === 'https://api.resend.com/emails') return Response.json({ id: randomUUID() });
    return Response.json({ Response: { SendStatusSet: [{ Code: 'Ok', SerialNo: 'test:1',
      PhoneNumber: phone, SessionContext: body.SessionContext }] } });
  });
  await delivery.email(email, '630219');
  await delivery.sms(phone, '739201');
  assert.equal(seen[0].url, 'https://api.resend.com/emails');
  assert.equal(seen[0].init.headers.authorization, 'Bearer private-api-key');
  assert.deepEqual(seen[0].body.to, [email]);
  assert.equal(seen[0].body.from, env.AUTH_EMAIL_FROM);
  assert.match(seen[0].body.text, /630219/);
  assert.equal(seen[1].url, 'https://sms.tencentcloudapi.com/');
  assert.match(seen[1].init.headers.authorization, /^TC3-HMAC-SHA256 Credential=key-id\//);
  assert.deepEqual(seen[1].body.TemplateParamSet, ['739201']);
  assert.equal(seen[1].body.TemplateId, '1234');
  accepted = false;
  await assert.rejects(delivery.email(email, '630219'));
  await assert.rejects(delivery.sms(phone, '739201'));
});
