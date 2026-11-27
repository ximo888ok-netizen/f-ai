import { randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { createAuthDelivery } from './auth-delivery.js';
import { canonicalEmail, canonicalPhone } from './auth-identifiers.js';
import { isUuid } from './config.js';
import { row, rows } from './db.js';
import { ApiError, choice, integer, object, route, text, uuid } from './http.js';

const derive = promisify(scrypt);
const digits = length => String(randomInt(10 ** length)).padStart(length, '0');
const captchaError = () => new ApiError(400, 'CAPTCHA_INVALID', 'The image code is invalid or expired');
const codeError = () => new ApiError(400, 'VERIFICATION_CODE_INVALID', 'A contact verification code is invalid or expired');
const hash = async (value, id) => (await derive(value, id, 32)).toString('hex');
const matches = async (value, id, stored) => timingSafeEqual(await derive(value, id, 32), Buffer.from(stored, 'hex'));

function renderCaptcha(answer) {
  const canvas = createCanvas(148, 50);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f4f3';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#b5b5b2';
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, randomInt(50));
    ctx.bezierCurveTo(40, randomInt(50), 105, randomInt(50), 148, randomInt(50));
    ctx.stroke();
  }
  ctx.font = 'bold 34px Arial, "Liberation Sans", sans-serif';
  ctx.fillStyle = '#272725';
  for (let i = 0; i < answer.length; i++) {
    ctx.save();
    ctx.translate(8 + 27*i + randomInt(4), 35 + randomInt(6));
    ctx.rotate(randomInt(-13, 14) * Math.PI / 180);
    ctx.fillText(answer[i], 0, 0);
    ctx.restore();
  }
  return canvas.toDataURL('image/png');
}

export async function consumeCaptcha(db, id, answer) {
  if (!isUuid(id)) throw captchaError();
  // Removing first also consumes incorrect guesses, including concurrent guesses.
  const challenge = await row(db, 'DELETE FROM auth_captchas WHERE id=$1 AND expires_at>now() RETURNING answer_hash', [id]);
  if (!challenge || typeof answer !== 'string' || !/^\d{5}$/.test(answer) ||
      !await matches(answer, id.toLowerCase(), challenge.answer_hash)) throw captchaError();
}

async function setRetryAfter(db, channel, recipient, reply) {
  const remaining = await row(db, `SELECT ceil(extract(epoch from (resend_at-now()))) AS seconds
    FROM auth_contact_codes WHERE channel=$1 AND target=$2`, [channel, recipient]);
  reply.header('retry-after', Math.max(0, Number(remaining?.seconds) || 0));
}

async function deliverCode(db, delivery, { channel, target, flowId }, reply) {
  const recipient = channel === 'sms' ? canonicalPhone(target) : canonicalEmail(target);
  if (!delivery[channel]) throw new ApiError(503, 'VERIFICATION_UNAVAILABLE', 'Verification delivery is not configured for this channel');
  await db.query('DELETE FROM auth_contact_codes WHERE expires_at<=now()');
  const id = randomUUID();
  // Commit the cooldown before calling the provider so competing processes cannot send twice.
  const reservation = await row(db, `INSERT INTO auth_contact_codes(channel,target,id,flow_id,resend_at,expires_at)
    VALUES ($1,$2,$3,$4,now()+interval '60 seconds',now()+interval '5 minutes')
    ON CONFLICT (channel,target) DO UPDATE SET id=excluded.id,flow_id=excluded.flow_id,code_hash=NULL,
    attempts=0,resend_at=excluded.resend_at,expires_at=excluded.expires_at
    WHERE auth_contact_codes.resend_at<=now() RETURNING id`, [channel, recipient, id, flowId]);
  if (!reservation) {
    await setRetryAfter(db, channel, recipient, reply);
    throw new ApiError(429, 'VERIFICATION_COOLDOWN', 'Please wait before requesting another code');
  }
  const code = digits(6);
  const digest = await hash(code, id);
  try {
    await delivery[channel](recipient, code);
  } catch {
    await setRetryAfter(db, channel, recipient, reply);
    throw new ApiError(502, 'VERIFICATION_DELIVERY_FAILED', 'The verification provider did not confirm acceptance');
  }
  const activated = await row(db, `UPDATE auth_contact_codes SET code_hash=$2, expires_at=now()+interval '5 minutes'
    WHERE id=$1 RETURNING id`, [id, digest]);
  if (!activated) throw codeError();
  return { resendAfter: 60, expiresIn: 300 };
}

export async function verifyContactCodes(db, { flowId, email, phone, emailCode, phoneCode }, complete) {
  if (!isUuid(flowId)) throw codeError();
  const result = await db.transaction(async tx => {
    // Lock in channel order so concurrent registrations and redemptions see a consistent pair.
    const codes = await rows(tx, `SELECT id,channel,code_hash FROM auth_contact_codes
      WHERE flow_id=$1 AND ((channel='email' AND target=$2) OR (channel='sms' AND target=$3))
      AND code_hash IS NOT NULL AND expires_at>now() AND attempts<5 ORDER BY channel FOR UPDATE`,
    [flowId, canonicalEmail(email), canonicalPhone(phone)]);
    let accepted = codes.length === 2;
    for (const entry of codes) {
      const value = entry.channel === 'email' ? emailCode : phoneCode;
      if (typeof value !== 'string' || !/^\d{6}$/.test(value) || !await matches(value, entry.id, entry.code_hash)) {
        accepted = false;
        await tx.query('UPDATE auth_contact_codes SET attempts=attempts+1 WHERE id=$1', [entry.id]);
      }
    }
    // Return normally here so attempt increments commit even when verification fails.
    if (!accepted) return { accepted: false };
    await tx.query('UPDATE auth_contact_codes SET code_hash=NULL WHERE id IN ($1,$2)', codes.map(entry => entry.id));
    return { accepted: true, value: await complete(tx) };
  });
  if (!result.accepted) throw codeError();
  return result.value;
}

export function registerAuthVerification(app, db, verification = createAuthDelivery()) {
  const tags = ['Identity'];
  route(app, 'GET', '/v1/auth/captcha', {
    auth: false, tags, summary: 'Request a single-use image challenge',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    response: { 200: object({ id: uuid, image: text(65536), expiresIn: integer(1,180) }) },
  }, async () => {
    await db.query('DELETE FROM auth_captchas WHERE expires_at<=now()');
    const id = randomUUID();
    const answer = verification.captchaAnswer?.() ?? digits(5);
    const image = renderCaptcha(answer);
    await db.query("INSERT INTO auth_captchas (id,answer_hash,expires_at) VALUES ($1,$2,now()+interval '3 minutes')", [id, await hash(answer, id)]);
    return { id, image, expiresIn: 180 };
  });
  route(app, 'POST', '/v1/auth/verification-codes', {
    auth: false, tags, summary: 'Send a registration code to a phone or email address',
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    body: object({ channel: choice('sms','email'), target: text(254), flowId: uuid }),
    response: { 200: object({ resendAfter: integer(1,60), expiresIn: integer(1,300) }) },
  }, (request, reply) => deliverCode(db, verification, request.body, reply));
}
