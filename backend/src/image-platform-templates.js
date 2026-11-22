import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, route } from './http.js';
import { lockPlugin } from './plugin-policy.js';

const root='/v1/media/images/platform-templates';
const platform=choice('taobao','pinduoduo','douyin');
const dimensions={width:integer(32,1920),height:integer(32,6144),fit:choice('contain','cover'),format:choice('png','jpeg')};
export const platformTemplateRef=object({platform,revision:integer(1,2147483647)});
const template=object({...platformTemplateRef.properties,...dimensions});
const fields='platform,revision,width,height,fit,format';

export function registerPlatformTemplates(app,db) {
  route(app,'GET',root,{tags:['Image processing'],summary:'List the current image export specifications approved by this workspace',
    response:{200:object({items:array(template,3)})}},async request=>({
    items:await rows(db,'SELECT DISTINCT ON (platform) '+fields+' FROM image_platform_templates WHERE workspace_id=$1 ORDER BY platform,revision DESC',
      [request.context.workspaceId]),
  }));
  route(app,'PUT',root+'/:platform',{tags:['Image processing'],manager:true,params:object({platform}),
    summary:'Publish a new immutable revision of a workspace image export specification',
    body:object({revision:integer(0,2147483646),...dimensions}),response:{200:template}},request=>db.transaction(async tx=>{
    const {revision,width,height,fit,format}=request.body;
    if (width*height>4000000) throw invalid('Canvas exceeds four million pixels');
    const key=[request.context.workspaceId,request.params.platform];
    await lockPlugin(tx,key[0],'image');
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text),hashtext($2))',[key[0],'image-template:'+key[1]]);
    const latest=await row(tx,'SELECT max(revision) AS revision FROM image_platform_templates WHERE workspace_id=$1 AND platform=$2',key);
    if ((latest.revision ?? 0)!==revision) {
      const prior=await row(tx,'SELECT '+fields+' FROM image_platform_templates WHERE workspace_id=$1 AND platform=$2 AND revision=$3',
        [...key,revision+1]);
      if (prior && prior.width===width && prior.height===height && prior.fit===fit && prior.format===format) return prior;
      throw new ApiError(409,'IMAGE_TEMPLATE_CHANGED','Reload the current platform template');
    }
    return row(tx,'INSERT INTO image_platform_templates(workspace_id,platform,revision,width,height,fit,format) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING '+fields,
      [...key,revision+1,width,height,fit,format]);
  }));
}

export async function resolvePlatformTemplates(db,workspaceId,items) {
  const refs=items.map(item=>item.platformTemplate).filter(Boolean);
  if (!refs.length) return items;
  const available=await rows(db,'SELECT '+fields+' FROM image_platform_templates WHERE workspace_id=$1 AND (platform,revision) IN '+
    '(SELECT platform,revision FROM jsonb_to_recordset($2::jsonb) AS r(platform text,revision integer))',[workspaceId,JSON.stringify(refs)]);
  return items.map(item=>{
    const ref=item.platformTemplate;
    if (!ref) return item;
    if (['width','height','fit','format','scale','profile'].some(key=>Object.hasOwn(item,key))) {
      throw invalid('The selected platform template supplies dimensions, fit and format');
    }
    const spec=available.find(t=>t.platform===ref.platform && t.revision===ref.revision);
    if (!spec) throw notFound('Platform image template revision');
    return {...item,width:spec.width,height:spec.height,fit:spec.fit,format:spec.format};
  });
}
