import { randomUUID } from 'node:crypto';
import { isUuid } from './config.js';
import { createTencentTemplateSender } from './tencent-sms.js';

export function createAuthDelivery(env = process.env, request = fetch) {
  const delivery = {};
  const apiKey = env.AUTH_EMAIL_RESEND_API_KEY?.trim();
  const from = env.AUTH_EMAIL_FROM?.trim();
  if (apiKey && from) {
    delivery.email = async (recipient, code) => {
      const response = await request('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [recipient], subject: 'F-AI 注册验证码',
          text: '您的注册验证码为 ' + code + '，5 分钟内有效。如非本人操作，请忽略此邮件。' }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('Email delivery rejected');
      }
      if (!isUuid((await response.json())?.id)) throw Error('Email delivery unconfirmed');
    };
  }
  const secretId = env.AUTH_SMS_SECRET_ID?.trim(), secretKey = env.AUTH_SMS_SECRET_KEY?.trim();
  const appId = env.AUTH_SMS_APP_ID?.trim(), signName = env.AUTH_SMS_SIGN_NAME?.trim();
  const templateId = env.AUTH_SMS_TEMPLATE_ID?.trim(), region = env.AUTH_SMS_REGION?.trim() || 'ap-guangzhou';
  if (secretId && secretKey && /^\d{1,20}$/.test(appId) && signName && signName.length <= 100 &&
      /^[1-9]\d{0,19}$/.test(templateId) && /^[a-z]{2}-[a-z0-9-]{1,32}$/.test(region)) {
    const send = createTencentTemplateSender({ secretId, secretKey, appId, signName, templateId, region }, request);
    delivery.sms = async (recipient, code) => {
      const response = await send(randomUUID(), { recipient, values: [code] });
      if (response.state !== 'accepted') throw Error('SMS delivery unconfirmed');
    };
  }
  return delivery;
}
