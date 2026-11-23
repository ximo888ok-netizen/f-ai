import { connectionEnabled, requireConnection } from './merchant-connections.js';
import { row, rows } from './db.js';
import { ApiError, array, bool, choice, integer, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { validMedia } from './assets.js';
import { checksum } from './webdav.js';

const root='/v1/cloud-assets';
const tags=['Cloud assets'];
const idParams=object({id:uuid});
const fields='asset_id AS id,name,media_type AS "mediaType",sha256,size_bytes AS "sizeBytes",state,created_at AS "createdAt"';
const details=object({id:uuid,name:text(200),mediaType:text(100),sha256:text(64,64),sizeBytes:integer(1,10*1024*1024),
  state:choice('pending','ready'),createdAt:{type:'string',format:'date-time'}});
const confirm=object({confirmed:{type:'boolean',const:true}});
const keyOf=request=>[request.context.workspaceId.toLowerCase(),request.context.accountId,request.params.id.toLowerCase()];
const remoteName=key=>'fai-'+key.join('-');

async function bindingFor(db,bindings,workspace) {
  await requireConnection(db,workspace,'webdav','workspace');
  const store=bindings.get(workspace.toLowerCase());
  if (!store) throw new ApiError(503,'WEBDAV_NOT_CONFIGURED','No file store is configured for this workspace');
  return store;
}

async function copyFor(db,key,store) {
  const record=await row(db,`SELECT * FROM asset_cloud_copies WHERE workspace_id=$1 AND account_id=$2 AND asset_id=$3
    AND NOT EXISTS(SELECT 1 FROM assets WHERE workspace_id=$1 AND account_id=$2 AND id=$3 AND rights_restricted)`,key);
  if (!record) throw notFound('Cloud copy');
  if (record.binding_hash!==store.fingerprint) throw new ApiError(409,'WEBDAV_BINDING_CHANGED','This copy belongs to a different file store');
  return record;
}

async function markReady(db,key) {
  return row(db,`UPDATE asset_cloud_copies SET state='ready' WHERE workspace_id=$1 AND account_id=$2 AND asset_id=$3 RETURNING ${fields}`,key);
}

export function registerCloudAssets(app,db,bindings) {
  route(app,'GET',root+'/status',{tags,summary:'Check whether a file store is bound to the workspace',
    response:{200:object({available:bool})}},async request=>({available:bindings.has(request.context.workspaceId.toLowerCase()) &&
      await connectionEnabled(db,request.context.workspaceId,'webdav','workspace')}));

  route(app,'GET',root,{tags,summary:'List the current member’s backup copies',querystring:page,
    response:{200:object({items:array(details,100)})}},async request=>({
    items:await rows(db,`SELECT ${fields} FROM asset_cloud_copies WHERE workspace_id=$1 AND account_id=$2
      ORDER BY created_at DESC,asset_id LIMIT $3 OFFSET $4`,[request.context.workspaceId,request.context.accountId,...paginate(request.query)]),
  }));

  route(app,'PUT',root+'/:id',{tags,params:idParams,body:confirm,summary:'Explicitly copy an owned asset to its workspace WebDAV store',
    response:{200:details}},async request=>{
    const key=keyOf(request);
    const store=await bindingFor(db,bindings,key[0]);
    const asset=await row(db,`SELECT * FROM assets WHERE workspace_id=$1 AND account_id=$2 AND id=$3`,key);
    if (!asset) {
      const prepared=await copyFor(db,key,store);
      await store.read(remoteName(key),prepared.size_bytes,prepared.sha256);
      return markReady(db,key);
    }
    if (asset.rights_restricted) throw notFound('Asset');
    const bytes=Buffer.from(asset.data);
    const digest=checksum(bytes);
    await db.query(`INSERT INTO asset_cloud_copies(workspace_id,account_id,asset_id,binding_hash,name,media_type,source,purpose,
      consent_reference,consent_expires_at,sha256,size_bytes,state,derived_ai)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13) ON CONFLICT DO NOTHING`,
    [...key,store.fingerprint,asset.name,asset.media_type,asset.source,asset.purpose,asset.consent_reference,asset.consent_expires_at,digest,bytes.length,asset.derived_ai]);
    const prepared=await copyFor(db,key,store);
    if (prepared.sha256!==digest) throw new ApiError(409,'CLOUD_COPY_MISMATCH','The local asset differs from the original copy');
    await store.write(remoteName(key),bytes,asset.media_type,digest);
    return markReady(db,key);
  });

  route(app,'GET',root+'/:id/content',{tags,params:idParams,summary:'Download and verify an owned WebDAV backup'},async (request,reply)=>{
    const key=keyOf(request);
    const store=await bindingFor(db,bindings,key[0]);
    const copy=await copyFor(db,key,store);
    const bytes=await store.read(remoteName(key),copy.size_bytes,copy.sha256);
    if (copy.state==='pending') await markReady(db,key);
    return reply.header('content-disposition','attachment').header('x-content-sha256',copy.sha256).type(copy.media_type).send(bytes);
  });

  route(app,'POST',root+'/:id/restore',{tags,params:idParams,body:confirm,summary:'Restore a verified backup to the original asset ID',
    response:{200:details}},async request=>{
    const key=keyOf(request);
    const store=await bindingFor(db,bindings,key[0]);
    const copy=await copyFor(db,key,store);
    const bytes=await store.read(remoteName(key),copy.size_bytes,copy.sha256);
    if (!validMedia(bytes,copy.media_type)) throw new ApiError(422,'ASSET_CONTENT_INVALID','The stored bytes do not match the media type');
    return db.transaction(async tx=>{
      await tx.query(`INSERT INTO assets(workspace_id,account_id,id,name,media_type,source,purpose,consent_reference,consent_expires_at,data,derived_ai)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [...key,copy.name,copy.media_type,copy.source,copy.purpose,copy.consent_reference,copy.consent_expires_at,bytes,copy.derived_ai]);
      const local=await row(tx,`SELECT encode(sha256(data),'hex') AS sha FROM assets
        WHERE workspace_id=$1 AND account_id=$2 AND id=$3 AND NOT rights_restricted`,key);
      if (local?.sha!==copy.sha256) throw new ApiError(409,'CLOUD_COPY_MISMATCH','The original asset ID already contains other content');
      return markReady(tx,key);
    });
  });
}
