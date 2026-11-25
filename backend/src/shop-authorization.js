import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError, object, route, text, uuid } from './http.js';
import { row } from './db.js';

export function taobaoSettings(env = process.env) {
  const { FAI_TAOBAO_APP_KEY: appKey, FAI_TAOBAO_APP_SECRET: secret,
    FAI_TAOBAO_REDIRECT_URI: redirect, FAI_SHOP_GRANT_KEY: key } = env;
  if (![appKey,secret,redirect,key].some(Boolean)) return null;
  if (!appKey || !secret || !redirect || !/^[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('Incomplete Taobao authorization configuration');
  const uri = new URL(redirect);
  if (uri.pathname !== '/' || uri.search || uri.hash || uri.username || uri.password ||
    !(uri.protocol === 'https:' || (uri.protocol === 'http:' && uri.hostname === '127.0.0.1'))) throw new Error('Use the registered HTTPS studio root for Taobao callbacks');
  return { appKey,secret,redirect,key:Buffer.from(key,'hex') };
}

const digest = input => createHash('sha256').update(input).digest('hex');
function seal(settings, scope, token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',settings.key,iv);
  cipher.setAAD(Buffer.from(scope));
  return Buffer.concat([iv,cipher.update(token,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
}
export function readShopToken(settings, scope, value) {
  const data = Buffer.from(value,'base64');
  const decipher = createDecipheriv('aes-256-gcm',settings.key,data.subarray(0,12));
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]).toString('utf8');
}
async function exchange(settings, code) {
  const response = await fetch('https://oauth.taobao.com/token',{ method:'POST', redirect:'error',signal:AbortSignal.timeout(15000),
    body:new URLSearchParams({grant_type:'authorization_code',code,client_id:settings.appKey,client_secret:settings.secret,redirect_uri:settings.redirect}) });
  if (!response.ok) throw new Error('Exchange failed');
  return response.json();
}
export function registerShopAuth(app,db,settings,redeem=exchange) {
  const options = { manager:true, tags:['Shop authorization'] };
  const guard=req=>{
    if (req.context.role !== 'owner') throw new ApiError(403,'FORBIDDEN','店铺授权需要工作区所有者操作。');
    if (!settings) throw new ApiError(503,'AUTH_APP_UNCONFIGURED','请先配置淘宝开放平台应用与工作台回调地址。');
  };
  route(app,'POST','/v1/desk-shops/:id/authorize',{...options,params:object({id:uuid})},async req=>{
    guard(req);
    const state=randomBytes(32).toString('base64url');
    const {workspaceId,accountId}=req.context;
    const shop=await row(db,"UPDATE desk_shops SET auth_state=$3,auth_account=$4,auth_deadline=now()+interval '10 minutes',revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND enabled AND platform='taobao' RETURNING id",
      [workspaceId,req.params.id,digest(state),accountId]);
    if (!shop) throw new ApiError(409,'SHOP_NOT_AVAILABLE','请选择当前工作区已启用的淘宝店铺。');
    const url=new URL('https://oauth.taobao.com/authorize');
    url.search=new URLSearchParams({response_type:'code',client_id:settings.appKey,redirect_uri:settings.redirect,state,view:'web'});
    return {url:url.href};
  });
  route(app,'POST','/v1/desk-shops/authorization/complete',{...options,body:object({state:text(80),code:text(1024)})},async req=>{
    guard(req);
    const {workspaceId,accountId}=req.context;
    const shop=await row(db,'UPDATE desk_shops SET auth_state=NULL,auth_deadline=NULL WHERE workspace_id=$1 AND auth_account=$2 AND auth_state=$3 AND auth_deadline>now() AND enabled RETURNING id, seller_id, revision',
      [workspaceId,accountId,digest(req.body.state)]);
    if (!shop) throw new ApiError(409,'AUTH_STATE_INVALID','授权请求已过期或不属于当前账号。请从店铺管理重新发起。');
    let grant;
    try { grant=await redeem(settings,req.body.code); } catch { throw new ApiError(502,'SHOP_AUTH_FAILED','平台换取授权失败，请重新登录授权。'); }
    const seller=String(grant?.taobao_user_id ?? '');
    const seconds=Number(grant?.expires_in);
    if (!/^\d{1,32}$/.test(seller) || (typeof grant.taobao_user_id==='number' && !Number.isSafeInteger(grant.taobao_user_id)) ||
        typeof grant.access_token !== 'string' || !grant.access_token.trim() || !Number.isSafeInteger(seconds) || seconds<1 || seconds>315360000)
      throw new ApiError(502,'SHOP_AUTH_FAILED','平台未返回有效的店铺身份和授权。');
    if (shop.seller_id && shop.seller_id!==seller) throw new ApiError(409,'SHOP_ID_MISMATCH','平台登录店铺与原绑定不一致。');
    try {
      const saved=await row(db,'UPDATE desk_shops SET seller_id=$3,grant_cipher=$4,expires_at=$5,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND enabled AND revision=$6 AND auth_state IS NULL RETURNING id',
        [workspaceId,shop.id,seller,seal(settings,workspaceId.toLowerCase()+'/'+shop.id,grant.access_token),new Date(Date.now()+seconds*1000),shop.revision]);
      if (!saved) throw new ApiError(409,'SHOP_CHANGED','店铺设置已更新，请重新授权。');
      return {id:saved.id};
    } catch(e) { if (e.code==='23505') throw new ApiError(409,'SHOP_ALREADY_BOUND','这家淘宝店已绑定当前工作区内的其他档案。'); throw e; }
  });
}
