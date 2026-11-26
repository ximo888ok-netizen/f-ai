import { randomUUID } from 'node:crypto';
import { ApiError, bool, choice, integer, notFound, object, route, text, uuid } from './http.js';
import { row, rows } from './db.js';
import { commercePlatforms } from './integration-config.js';
import { connectionEnabled } from './merchant-connections.js';
import { isUuid } from './config.js';
import { readShopToken } from './shop-authorization.js';

const columns='id,name,platform,enabled,revision,expires_at AS "expiresAt",grant_cipher IS NOT NULL AS granted';
const keyFor=(workspace,id)=>workspace.toLowerCase()+'/'+id;
export async function localShop(db,workspace,id) {
  return isUuid(id) ? row(db,'SELECT '+columns+' FROM desk_shops WHERE workspace_id=$1 AND id=$2',[workspace,id]) : null;
}
export async function managedCommerceShop(db,workspace,id,settings) {
  if (!isUuid(id)) return null;
  const shop=await row(db,'SELECT '+columns+', grant_cipher FROM desk_shops WHERE workspace_id=$1 AND id=$2',[workspace,id]);
  if (!shop) return null;
  if (!shop.enabled) throw new ApiError(409,'CONNECTION_DISABLED','店铺已停用。');
  if (shop.platform==='taobao' && settings && shop.granted && new Date(shop.expiresAt)>new Date()) {
    try { shop.credentials={app_key:settings.appKey,app_secret:settings.secret,access_token:readShopToken(settings,keyFor(workspace,shop.id),shop.grant_cipher)}; }
    catch { throw new ApiError(503,'SHOP_KEY_UNAVAILABLE','无法读取店铺授权，请核对服务密钥。'); }
  }
  return shop;
}
export async function requireServiceShop(db,workspace,id,config) {
  const local=await localShop(db,workspace,id);
  if (!local && !config.customer?.shops.has(keyFor(workspace,id))) throw notFound('Shop');
  if (local?.enabled===false || !(await connectionEnabled(db,workspace,'shop',id))) throw new ApiError(409,'CONNECTION_DISABLED','店铺已停用。');
}
export async function deskShopEnabled(db,workspace,id) {
  const local=await localShop(db,workspace,id);
  return local?.enabled!==false && await connectionEnabled(db,workspace,'shop',id);
}
export function registerDeskShops(app,db,config,auth) {
  const base='/v1/desk-shops', options={ manager:true,tags:['Workspace shops'] };
  route(app,'GET',base,options,async req=>{
    const {workspaceId}=req.context;
    const stored=await rows(db,'SELECT '+columns+' FROM desk_shops WHERE workspace_id=$1 ORDER BY name,id',[workspaceId]);
    const shops=new Map(stored.map(s=>[s.id,{...s,source:'managed',customer:false,commerce:s.enabled && !!auth && s.granted && Date.parse(s.expiresAt)>Date.now()}]));
    for (const kind of ['customer','commerce']) for (const s of config[kind]?.shops.values() ?? []) {
      if (s.workspaceId!==workspaceId.toLowerCase()) continue;
      const record=shops.get(s.id) ?? {id:s.id,name:s.name,platform:s.platform,customer:false,commerce:false,source:'configured',
        enabled:await connectionEnabled(db,workspaceId,'shop',s.id)};
      record.enabled=record.enabled && await connectionEnabled(db,workspaceId,'shop',s.id);
      if(kind==='customer') { record.customer=record.enabled; record.allowHandoff=record.enabled && s.allowHandoff===true; }
      else { record.expiresAt=s.expiresAt; record.granted=!!s.credentials;
        record.commerce=record.enabled && !!s.credentials && (!s.expiresAt || Date.parse(s.expiresAt)>Date.now()); }
      shops.set(s.id,record);
    }
    return {items:[...shops.values()],taobaoOAuth:!!auth};
  });
  const owner=req=>{ if (req.context.role!=='owner') throw new ApiError(403,'FORBIDDEN','请由工作区所有者管理店铺。'); };
  route(app,'POST',base,{...options,body:object({name:text(100),platform:choice(...commercePlatforms)})},async(req,reply)=>{
    owner(req);
    if (!req.body.name.trim()) throw new ApiError(400,'INVALID_INPUT','请输入店铺名称。');
    const created=await row(db,'INSERT INTO desk_shops(workspace_id,id,name,platform) VALUES($1,$2,$3,$4) RETURNING '+columns,
      [req.context.workspaceId,randomUUID(),req.body.name.trim(),req.body.platform]);
    reply.code(201); return created;
  });
  route(app,'PATCH',base+'/:id',{...options,params:object({id:uuid}),body:object({revision:integer(0,2147483646),enabled:bool,name:text(100)},['revision','enabled','name'])},async req=>{
    owner(req);
    if (!req.body.name.trim()) throw new ApiError(400,'INVALID_INPUT','请输入店铺名称。');
    const saved=await row(db,'UPDATE desk_shops SET name=$3,enabled=$4,revision=revision+1,auth_state=NULL,auth_deadline=NULL,grant_cipher=CASE WHEN $4 THEN grant_cipher ELSE NULL END, expires_at=CASE WHEN $4 THEN expires_at ELSE NULL END WHERE workspace_id=$1 AND id=$2 AND revision=$5 RETURNING '+columns,
      [req.context.workspaceId,req.params.id,req.body.name.trim(),req.body.enabled,req.body.revision]);
    if (!saved) throw new ApiError(409,'SHOP_CHANGED','店铺信息已变更，请刷新后重试。');
    return saved;
  });
}
