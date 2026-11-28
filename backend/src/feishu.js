import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { isUuid } from './config.js';
import { ApiError } from './http.js';
import { ProviderError, requestUpstream } from './model-http.js';

const endpoint='https://open.feishu.cn/open-apis/';
export const connectorPattern='^[a-z][a-z0-9_-]{0,39}$';
export const eventPattern='^[A-Za-z0-9_-]{1,128}$';
const validId=new RegExp(eventPattern);
const validConnector=new RegExp(connectorPattern);
const unauthorized=()=>new ApiError(401,'FEISHU_EVENT_UNVERIFIED','The Feishu event could not be verified');
const sha=value=>createHash('sha256').update(value).digest();

function decrypt(raw,key) {
  try {
    const body=JSON.parse(raw);
    if (typeof body?.encrypt!=='string' || !/^[a-zA-Z0-9+/]+={0,2}$/.test(body.encrypt)) return null;
    const bytes=Buffer.from(body.encrypt,'base64');
    if (bytes.length<32 || bytes.length%16) return null;
    const decipher=createDecipheriv('aes-256-cbc',sha(key),bytes.subarray(0,16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)),decipher.final()]).toString('utf8'));
  } catch { return null; }
}

function same(left,right) {
  return typeof left==='string' && timingSafeEqual(sha(left),sha(right));
}

function hasSignature(headers,raw,key) {
  const time=headers['x-lark-request-timestamp'];
  const nonce=headers['x-lark-request-nonce'];
  const signature=headers['x-lark-signature'];
  if (typeof time!=='string' || !/^\d{10}$/.test(time) || Math.abs(Date.now()-Number(time)*1000)>300000 ||
      typeof nonce!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(nonce) ||
      typeof signature!=='string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const digest=createHash('sha256').update(time+nonce+key).update(raw).digest();
  return timingSafeEqual(digest,Buffer.from(signature,'hex'));
}

function verify(binding,headers,raw,nonces) {
  const signed=hasSignature(headers,raw,binding.encryptKey);
  if (!signed && headers['x-lark-signature'] !== undefined) throw unauthorized();
  if (signed) {
    const nonce=headers['x-lark-request-nonce'];
    const payloadHash=sha(raw).toString('hex');
    const now=Date.now();
    for (const [key, entry] of nonces) {
      if (entry.expires > now) break;
      nonces.delete(key);
    }
    const prior=nonces.get(nonce);
    if (prior && prior.payloadHash!==payloadHash) throw unauthorized();
    if (!prior) {
      if (nonces.size>=4096) nonces.delete(nonces.keys().next().value);
      // A signed timestamp can be up to five minutes ahead. Keep its nonce
      // through the entire acceptance window and allow identical vendor retries.
      nonces.set(nonce,{payloadHash,expires:now+600000});
    }
  }
  const body=decrypt(raw,binding.encryptKey);
  // The URL-verification envelope proves the Encrypt Key and Verification Token.
  if (body?.type==='url_verification' && same(body.token,binding.verificationToken) &&
      typeof body.challenge==='string' && body.challenge.length<=256) return {challenge:body.challenge};
  const meta=body?.header;
  if (!signed || body?.schema!=='2.0' || !same(meta?.token,binding.verificationToken) ||
      meta.app_id!==binding.appId || meta.tenant_key!==binding.tenantKey) throw unauthorized();
  const msg=body.event?.message;
  if (meta.event_type!=='im.message.receive_v1' || body.event?.sender?.sender_type!=='user' ||
      msg?.chat_type!=='p2p' || msg?.message_type!=='text') return null;
  if (typeof meta.event_id!=='string' || !validId.test(meta.event_id) ||
      typeof msg.chat_id!=='string' || !/^oc_[A-Za-z0-9_-]{1,124}$/.test(msg.chat_id) ||
      typeof msg.message_id!=='string' || !/^om_[A-Za-z0-9_-]{1,124}$/.test(msg.message_id) ||
      typeof msg.content!=='string') return null;
  let content;
  try { content=JSON.parse(msg.content)?.text; } catch { return null; }
  if (typeof content!=='string' || !content.trim() || content.includes('\0') || Array.from(content).length>4000) return null;
  return {eventId:meta.event_id,chatId:msg.chat_id,remoteMessageId:msg.message_id,content:content.trim()};
}

function sender(binding, request) {
  let credential;
  async function token(force = false) {
    if (!force && credential?.expires>Date.now()) return credential.value;
    const result=await request(new URL('auth/v3/tenant_access_token/internal',endpoint),{
      body:{app_id:binding.appId,app_secret:binding.appSecret},timeout:8000,
    });
    if (result?.code!==0 || typeof result.tenant_access_token!=='string' || !/^[a-zA-Z0-9_.-]{8,512}$/.test(result.tenant_access_token)) {
      throw new ProviderError('FEISHU_TOKEN_REJECTED');
    }
    const seconds=Number.isFinite(result.expire)? Math.min(result.expire,7200):300;
    credential={value:result.tenant_access_token,expires:Date.now()+Math.max(0,seconds-60)*1000};
    return credential.value;
  }
  const send = async (chatId,content,id)=>{
    const accessToken=await token();
    const response=await request(new URL('im/v1/messages?receive_id_type=chat_id',endpoint),{
      headers:{authorization:'Bearer '+accessToken},timeout:10000,repeatable:true,
      body:{receive_id:chatId,msg_type:'text',content:JSON.stringify({text:content}),uuid:id},
    });
    if (response?.code!==0) throw new ProviderError('FEISHU_SEND_REJECTED');
    const message=response.data?.message_id;
    if (typeof message!=='string' || !validId.test(message)) throw new ProviderError('FEISHU_SEND_UNCONFIRMED',true);
    return message;
  };
  return { send, check: async () => { await token(true); } };
}

function readSecret(env,name) {
  if (typeof name!=='string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      typeof env[name]!=='string' || !env[name].trim() || env[name].length>512) throw new Error('Missing Feishu connector secret');
  return env[name];
}

export function createFeishuBindings(env=process.env,request=requestUpstream) {
  const inputs=JSON.parse(env.FEISHU_BINDINGS_JSON || '[]');
  if (!Array.isArray(inputs)) throw new Error('FEISHU_BINDINGS_JSON must contain an array');
  const bindings=new Map();
  const workspaces=new Set();
  for (const data of inputs) {
    if (!data || typeof data.id!=='string' || !validConnector.test(data.id) || !isUuid(data.workspaceId) ||
        typeof data.appId!=='string' || !/^cli_[A-Za-z0-9_-]{1,100}$/.test(data.appId) ||
        typeof data.tenantKey!=='string' || !validId.test(data.tenantKey)) throw new Error('Invalid Feishu connector configuration');
    const workspaceId=data.workspaceId.toLowerCase();
    if (bindings.has(data.id) || workspaces.has(workspaceId)) throw new Error('Duplicate Feishu connector or workspace');
    workspaces.add(workspaceId);
    const binding={id:data.id,workspaceId,appId:data.appId,tenantKey:data.tenantKey,
      encryptKey:readSecret(env,data.encryptKeyEnv),verificationToken:readSecret(env,data.verificationTokenEnv),
      appSecret:readSecret(env,data.appSecretEnv)};
    const nonces=new Map();
    bindings.set(data.id,{id:data.id,workspaceId,fingerprint:sha(JSON.stringify([data.id,workspaceId,data.appId,data.tenantKey])).toString('hex'),
      verify:(headers,raw)=>verify(binding,headers,raw,nonces),...sender(binding,request)});
  }
  return bindings;
}
