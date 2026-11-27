import { createHash, createHmac } from 'node:crypto';
import { isUuid } from './config.js';

const host='sms.tencentcloudapi.com';
const endpoint='https://'+host+'/';
const mime='application/json; charset=utf-8';
const signed='content-type;host;x-tc-action';
const sha=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const unknown={state:'uncertain',code:'SMS_ACCEPTANCE_UNKNOWN'};
const throttled={state:'retry',code:'SMS_RATE_LIMITED'};

function headers(secretId,secretKey,region,body) {
  const timestamp=Math.floor(Date.now()/1000).toString();
  const day=new Date(Number(timestamp)*1000).toISOString().slice(0,10);
  const scope=day+'/sms/tc3_request';
  const canonical=`POST\n/\n\ncontent-type:${mime}\nhost:${host}\nx-tc-action:sendsms\n\n${signed}\n${sha(body)}`;
  const signing=hmac(hmac(hmac('TC3'+secretKey,day),'sms'),'tc3_request');
  const signature=hmac(signing,['TC3-HMAC-SHA256',timestamp,scope,sha(canonical)].join('\n')).toString('hex');
  return {'content-type':mime,'x-tc-action':'SendSms','x-tc-region':region,'x-tc-timestamp':timestamp,'x-tc-version':'2021-01-11',
    authorization:`TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`};
}

function rejection(code) {
  if (['RequestLimitExceeded','LimitExceeded.GlobalSmsSendingRateLimit','LimitExceeded.PhoneNumberThirtySecondLimit'].includes(code)) return throttled;
  if (typeof code==='string' && (/^(AuthFailure|UnauthorizedOperation|InvalidParameter(?:Value)?|MissingParameter|LimitExceeded|UnsupportedOperation)(\.|$)/.test(code) ||
      /^FailedOperation\.(Template|Sign|PhoneNumberInBlacklist)/.test(code))) {
    return {state:'failed',code:'SMS_REJECTED'};
  }
  return unknown;
}

async function send(request,auth,body,recipient,context) {
  try {
    const response=await request(endpoint,{method:'POST',headers:auth,body,redirect:'error',signal:AbortSignal.timeout(10000)});
    if (response.status===429) {
      await response.body?.cancel();
      const after=response.headers.get('retry-after') ?? '';
      const seconds=/^\d+$/.test(after)?Number(after):(Date.parse(after)-Date.now())/1000;
      return {...throttled,delay:Number.isFinite(seconds)?Math.max(0,Math.min(86400,Math.ceil(seconds))):0};
    }
    const packet=(await response.json())?.Response;
    if (packet?.Error) return rejection(packet.Error.Code);
    if (!response.ok || packet?.SendStatusSet?.length!==1) return unknown;
    const item=packet.SendStatusSet[0];
    if (item?.PhoneNumber!==recipient || item.SessionContext!==context) return unknown;
    if (item.Code!=='Ok') return rejection(item.Code);
    if (typeof item.SerialNo!=='string' || !/^[\w:-]{1,128}$/.test(item.SerialNo)) return unknown;
    return {state:'accepted',reference:item.SerialNo};
  } catch (error) {
    if (['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code)) {
      return {state:'retry',code:'SMS_CONNECT_FAILED'};
    }
    return unknown;
  }
}

export function createTencentTemplateSender({secretId,secretKey,region,appId,signName,templateId},request=fetch) {
  return async (id,{recipient,values}) => {
    const body=JSON.stringify({SmsSdkAppId:appId,SignName:signName,TemplateId:templateId,
      PhoneNumberSet:[recipient],TemplateParamSet:values,SessionContext:id});
    return send(request,headers(secretId,secretKey,region,body),body,recipient,id);
  };
}

export function createSmsBindings(env=process.env,request=fetch) {
  const config=JSON.parse(env.SMS_BINDINGS_JSON || '[]');
  if (!Array.isArray(config)) throw new Error('SMS_BINDINGS_JSON must be an array');
  const result=new Map();
  for (const item of config) {
    const workspace=item?.workspaceId?.toLowerCase();
    const region=item?.region ?? 'ap-guangzhou';
    const secret=name=>typeof name==='string' && /^[A-Z][A-Z0-9_]*$/.test(name) && env[name]?.trim();
    const secretId=secret(item?.secretIdEnv), secretKey=secret(item?.secretKeyEnv);
    if (!isUuid(workspace) || result.has(workspace) || !secretId || !secretKey || !/^\d{1,20}$/.test(item.appId) ||
        typeof item.appId!=='string' || typeof item.signName!=='string' || !item.signName.trim() || item.signName.length>100 ||
        !/^[a-z]{2}-[a-z0-9-]{1,32}$/.test(region) || !Array.isArray(item.templates) || !item.templates.length || item.templates.length>200) {
      throw new Error('Invalid SMS workspace binding');
    }
    const templates=new Map();
    for (const entry of item.templates) {
      if (typeof entry?.alias!=='string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(entry.alias) || templates.has(entry.alias) ||
          typeof entry.id!=='string' || !/^[1-9]\d{0,19}$/.test(entry.id) ||
          !Number.isInteger(entry.params) || entry.params<0 || entry.params>12) throw new Error('Invalid SMS template');
      templates.set(entry.alias,{
        params:entry.params,fingerprint:sha(JSON.stringify([workspace,item.appId,item.signName,region,entry.id,entry.params])),
        send:createTencentTemplateSender({secretId,secretKey,region,appId:item.appId,signName:item.signName,templateId:entry.id},request),
      });
    }
    result.set(workspace,templates);
  }
  return result;
}
