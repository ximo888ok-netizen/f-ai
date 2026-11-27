import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

// Only test processes receive the delivery adapters; the served auth routes remain unchanged.
const inboxes = new WeakMap();
export const fixtureCaptchaAnswer = '48275';

export function fixtureIdentity(email) {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return { username:'qa_'+hash.slice(0,20), phone:'+1'+String(BigInt('0x'+hash.slice(0,12)) % 10000000000n).padStart(10,'0') };
}

export async function buildAuthTestApp(options, candidateBuildApp) {
  const buildApp = candidateBuildApp ?? (await import('../src/app.js')).buildApp;
  const inbox = new Map();
  const app = await buildApp({ ...options, authVerification:{
    sms:async (target,code)=>inbox.set('sms:'+target,code),
    email:async (target,code)=>inbox.set('email:'+target,code),
    captchaAnswer:()=>fixtureCaptchaAnswer,
  } });
  inboxes.set(app,inbox);
  return app;
}

export function deliveredCode(app,channel,target) {
  const code = inboxes.get(app)?.get(channel+':'+target);
  assert.match(code ?? '',/^\d{6}$/,'verification delivery did not reach the fixture recipient');
  return code;
}

export async function registrationPayload(app,details) {
  const {username,phone}=fixtureIdentity(details.email);
  const email=details.email.trim().toLowerCase(), flowId=randomUUID();
  for(const [channel,target] of [['sms',phone],['email',email]]) {
    const remoteAddress='192.0.2.'+(1+parseInt(username.slice(3,7),16)%254);
    const result=await app.inject({method:'POST',url:'/v1/auth/verification-codes',remoteAddress,payload:{flowId,channel,target}});
    assert.equal(result.statusCode,200,result.body);
  }
  return {...details,username,phone,flowId,phoneCode:deliveredCode(app,'sms',phone),emailCode:deliveredCode(app,'email',email)};
}

export async function loginPayload(app,{email,password}) {
  const challenge=await app.inject({method:'GET',url:'/v1/auth/captcha'});
  assert.equal(challenge.statusCode,200,challenge.body);
  return {identifier:fixtureIdentity(email).username,password,captchaId:challenge.json().id,captchaAnswer:fixtureCaptchaAnswer};
}
