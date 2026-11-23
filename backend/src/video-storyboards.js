import { generatedAsset } from './ai-export-mark.js';
import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { stableJson } from './tasks.js';
import { videoAttachment } from './video-delivery.js';
import { videoProfiles } from './video-renderer.js';

const root='/v1/media/storyboards';
const tags=['Video storyboards'];
const params=object({id:uuid});
const fields='id,title,configuration,revision,updated_at AS "updatedAt"';
const templates={
  'product-showcase':'Show the product and preserve its color and proportions.',
  'feature-details':'Draw attention to a visible product feature without changing the product.',
  'steps':'Show the current step and make its sequence clear.',
};
const shot=object({assetId:uuid,durationMs:integer(500,10000),caption:text(120,0),prompt:text(600,0)},
  ['assetId','durationMs']);
const body=object({revision:integer(0,2147483646),title:text(120),ratio:choice(...Object.keys(videoProfiles)),
  template:choice(...Object.keys(templates)),shots:array(shot,12,1),audioAssetId:{anyOf:[uuid,{type:'null'}]}},
  ['revision','title','ratio','template','shots']);
const keyOf=request=>[request.context.workspaceId,request.context.accountId,request.params.id];
const conflict=()=>new ApiError(409,'STORYBOARD_CHANGED','Reload the storyboard before saving or exporting');

async function load(db,key) {
  const item=await row(db,`SELECT ${fields} FROM studio_video_storyboards WHERE workspace_id=$1 AND account_id=$2 AND id=$3`,key);
  if (!item) throw notFound('Storyboard');
  return item;
}

function takeConfiguration(input) {
  const {ratio,template}=input;
  const shots=input.shots.map(({assetId,durationMs,caption='',prompt=''})=>({
    assetId:assetId.toLowerCase(),durationMs,caption:caption.trim(),prompt:prompt.trim(),
  }));
  if (shots.reduce((total,shot)=>total+shot.durationMs,0)>60000) throw invalid('Storyboards are limited to 60 seconds');
  return {ratio,template,shots,audioAssetId:input.audioAssetId?.toLowerCase() ?? null};
}

async function sources(db,[workspaceId,accountId],configuration,withBytes=false) {
  const images=new Set(configuration.shots.map(shot=>shot.assetId));
  const track=configuration.audioAssetId;
  if (track && images.has(track)) throw invalid('The audio track must be an MP3 asset');
  const ids=[...images,...(track?[track]:[])];
  const assets=await rows(db,`SELECT id,media_type,octet_length(data) AS size FROM assets
    WHERE workspace_id=$1 AND account_id=$2 AND id=ANY($3::uuid[]) AND NOT rights_restricted`,[workspaceId,accountId,ids]);
  if (assets.length!==ids.length) throw notFound('Storyboard asset');
  if (assets.some(asset=>!(asset.id===track?['audio/mpeg']:['image/png','image/jpeg']).includes(asset.media_type))) {
    throw invalid('Use JPEG or PNG for shots and MP3 for the audio track');
  }
  if (assets.reduce((sum,asset)=>sum+asset.size,0)>24*1024*1024) {
    throw new ApiError(413,'STORYBOARD_ASSET_LIMIT','Combined storyboard source size exceeds 24 MiB');
  }
  if (!withBytes) return;
  const content=await rows(db,`SELECT a.id,a.data,${generatedAsset('a')} AS generated FROM assets a WHERE a.workspace_id=$1
    AND a.account_id=$2 AND a.id=ANY($3::uuid[]) AND NOT a.rights_restricted`,[workspaceId,accountId,ids]);
  if (content.length!==ids.length) throw notFound('Storyboard asset');
  const byId=new Map(content.map(asset=>[asset.id,asset]));
  return {shots:configuration.shots.map(shot=>({...shot,bytes:byId.get(shot.assetId).data})),
    ratio:configuration.ratio,mark:content.some(asset=>asset.generated),audio:byId.get(track)?.data};
}

export function registerStoryboards(app,db,renderer) {
  route(app,'GET',root,{tags,summary:'List owned video storyboards',querystring:page},async request=>({
    items:await rows(db,`SELECT ${fields} FROM studio_video_storyboards WHERE workspace_id=$1 AND account_id=$2
      ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,
      [request.context.workspaceId,request.context.accountId,...paginate(request.query)]),
  }));
  route(app,'GET',root+'/:id',{tags,params,summary:'Read an editable video storyboard'},request=>load(db,keyOf(request)));
  route(app,'PUT',root+'/:id',{ feature: 'video.storyboard',tags,params,body,summary:'Save an editable storyboard at the requested revision'},async request=>{
    const key=keyOf(request);
    const title=request.body.title.trim();
    if (!title) throw invalid('Enter a storyboard title');
    const configuration=takeConfiguration(request.body);
    const {revision}=request.body;
    return db.transaction(async tx=>{
      await sources(tx,key,configuration);
      const values=[...key,title,JSON.stringify(configuration)];
      const saved=revision===0
        ? await row(tx,`INSERT INTO studio_video_storyboards(workspace_id,account_id,id,title,configuration)
            VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING ${fields}`,values)
        : await row(tx,`UPDATE studio_video_storyboards SET title=$4,configuration=$5::jsonb,revision=revision+1,updated_at=now()
            WHERE workspace_id=$1 AND account_id=$2 AND id=$3 AND revision=$6 RETURNING ${fields}`,[...values,revision]);
      if (saved) return saved;
      const current=await load(tx,key);
      if (current.revision===revision+1 && current.title===title
        && stableJson(current.configuration)===stableJson(configuration)) return current;
      throw conflict();
    });
  });
  route(app,'DELETE',root+'/:id',{tags,params,summary:'Delete an owned storyboard',querystring:object({revision:integer(1,2147483646)})},
    async (request,reply)=>{
      const key=keyOf(request);
      const deleted=await row(db,`DELETE FROM studio_video_storyboards WHERE workspace_id=$1 AND account_id=$2 AND id=$3
        AND revision=$4 RETURNING id`,[...key,request.query.revision]);
      if (!deleted) {await load(db,key);throw conflict();}
      return reply.code(204).send();
    });
  route(app,'GET',root+'/:id/prompts',{tags,params,summary:'Extract the editable shot prompts from a saved storyboard'},async request=>{
    const item=await load(db,keyOf(request));
    const {template,shots}=item.configuration;
    return {revision:item.revision,items:shots.map(({prompt,caption,durationMs},index)=>({
      position:index,durationMs,prompt:prompt || [templates[template],caption].filter(Boolean).join(' '),
    }))};
  });
  route(app,'POST',root+'/:id/export',{ feature: 'video.export',tags,params,summary:'Render a saved sequence of images and optional audio to MP4',
    body:object({revision:integer(1,2147483646)}),produces:['video/mp4']},async (request,reply)=>{
    const key=keyOf(request);
    const saved=await load(db,key);
    if (saved.revision!==request.body.revision) throw conflict();
    if (!renderer?.storyboard) throw new ApiError(503,'VIDEO_EXPORT_UNAVAILABLE','Video processing is not configured on this server');
    const bytes=await renderer.storyboard(await sources(db,key,saved.configuration,true));
    const current=await load(db,key);
    if (current.revision!==saved.revision) throw conflict();
    await sources(db,key,saved.configuration);
    return videoAttachment(reply,bytes,'storyboard-'+saved.id,'mp4');
  });
}
