import { row, rows } from './db.js';
import { ApiError, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { lockPlugin } from './plugin-policy.js';
import { stableJson } from './tasks.js';

const root = '/v1/media/images/series-presets';
const tags = ['Image processing'];
const params = object({id:uuid});
const version = integer(1,2147483647);
export const seriesPresetRef = object({id:uuid,revision:version});
const color = {...text(7,7),pattern:'^#[a-fA-F0-9]{6}$'};
const configuration = object({
  productAssetId:uuid, modelAssetId:{anyOf:[uuid,{type:'null'}]},
  background:color, font:choice('sans','chinese'), fontSizePercent:integer(2,20), textColor:color,
  subjectBox:object({x:integer(0,99),y:integer(0,99),width:integer(1,100),height:integer(1,100)}),
},['productAssetId','modelAssetId','background','font','textColor','subjectBox']);
const fields = 'id,revision,name,configuration';
const owned = 'workspace_id=$1 AND account_id=$2 AND id=$3';
const key = (context,id) => [context.workspaceId, context.accountId, id.toLowerCase()];
export const activeModelConsent = "consent_reference IS NOT NULL AND consent_expires_at > clock_timestamp()";

export async function readSeriesPreset(db,context,ref) {
  const record = await row(db,'SELECT '+fields+' FROM image_series_presets WHERE '+owned+' AND revision=$4',
    [...key(context,ref.id),ref.revision]);
  if (!record) throw notFound('Image series preset revision');
  return record;
}

export function registerSeriesPresets(app,db) {
  route(app,'GET',root,{tags,querystring:page,summary:'List your current reusable image series presets'},async request=>({
    items:await rows(db,'SELECT DISTINCT ON (id) '+fields+' FROM image_series_presets WHERE workspace_id=$1 AND account_id=$2 ORDER BY id,revision DESC LIMIT $3 OFFSET $4',
      [request.context.workspaceId,request.context.accountId,...paginate(request.query)]),
  }));
  route(app,'GET',root+'/:id',{tags,params,querystring:object({revision:version}),summary:'Read a saved image series revision'},
    request=>readSeriesPreset(db,request.context,{id:request.params.id,revision:request.query.revision}));
  route(app,'PUT',root+'/:id',{tags,params,summary:'Save a reusable image series revision',
    body:object({revision:integer(0,2147483646),name:text(100),configuration})},request=>db.transaction(async tx=>{
    const {revision}=request.body;
    const name=request.body.name.trim();
    const cfg={...request.body.configuration};
    cfg.productAssetId=cfg.productAssetId.toLowerCase();
    cfg.modelAssetId=cfg.modelAssetId?.toLowerCase() ?? null;
    cfg.fontSizePercent ??= 7;
    cfg.background=cfg.background.toLowerCase();
    cfg.textColor=cfg.textColor.toLowerCase();
    const box=cfg.subjectBox;
    if (!name || box.x+box.width>100 || box.y+box.height>100 || cfg.productAssetId===cfg.modelAssetId)
      throw invalid('Provide a name, distinct references and a box within the canvas');
    const ids=key(request.context,request.params.id);
    await lockPlugin(tx,ids[0],'image');
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['image-series',ids[2]]);
    const latest=await row(tx,'SELECT max(revision) AS revision FROM image_series_presets WHERE '+owned,ids);
    if ((latest.revision ?? 0)!==revision) {
      const prior=await row(tx,'SELECT '+fields+' FROM image_series_presets WHERE '+owned+' AND revision=$4',[...ids,revision+1]);
      if (prior?.name===name && stableJson(prior.configuration)===stableJson(cfg)) return prior;
      throw new ApiError(409,'IMAGE_SERIES_CHANGED','Reload the current series preset');
    }
    const refs=[cfg.productAssetId,cfg.modelAssetId].filter(Boolean);
    const available=await rows(tx,"SELECT id FROM assets WHERE workspace_id=$1 AND account_id=$2 AND id=ANY($3::uuid[]) AND NOT rights_restricted AND media_type IN ('image/png','image/jpeg') AND (id IS DISTINCT FROM $4::uuid OR ("+activeModelConsent+')) ORDER BY id FOR SHARE',
      [ids[0],ids[1],refs,cfg.modelAssetId]);
    if (available.length!==refs.length) throw invalid('Select available owned images with current consent for the model');
    return row(tx,'INSERT INTO image_series_presets(workspace_id,account_id,id,revision,name,configuration) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING '+fields,
      [...ids,revision+1,name,JSON.stringify(cfg)]);
  }));
}
