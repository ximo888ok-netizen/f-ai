import { generatedAsset } from './ai-export-mark.js';
import { ApiError, bool, choice, integer, invalid, notFound, object, route, uuid } from './http.js';
import { row } from './db.js';
import { videoFormats, videoProfiles } from './video-renderer.js';

export { createVideoDelivery } from './video-renderer.js';
const mp4='video/mp4';
const idParams=object({id:uuid});
const unavailable=()=>new ApiError(503,'VIDEO_EXPORT_UNAVAILABLE','Video processing is not configured on this server');

export function videoAttachment(reply,bytes,id,format) {
  return reply.header('content-disposition','attachment; filename="'+id+'.'+format+'"')
    .type(videoFormats[format]).send(bytes);
}

export async function sendVideoDelivery(render,asset,id,reply) {
  if (!render) throw unavailable();
  if (asset.media_type!==mp4) throw new ApiError(422,'VIDEO_EXPORT_MP4_REQUIRED','Select an MP4 asset');
  const bytes=await render(asset.data);
  return videoAttachment(reply,bytes,'ai-delivery-'+id,'mp4');
}

async function source(db,request) {
  const {workspaceId,accountId}=request.context;
  const {id}=request.params;
  const asset=await row(db,`SELECT a.media_type,a.data,${generatedAsset('a')} AS generated
    FROM assets a WHERE a.workspace_id=$1 AND a.account_id=$2 AND a.id=$3 AND NOT a.rights_restricted`,
    [workspaceId,accountId,id]);
  if (!asset) throw notFound('Asset');
  if (asset.media_type!==mp4) throw new ApiError(422,'VIDEO_EXPORT_MP4_REQUIRED','Select an MP4 asset');
  return asset;
}

export function registerVideoDelivery(app,db,render) {
  const tags=['Video delivery'];
  route(app,'GET','/v1/video-export/status',{tags,summary:'Check if marked MP4 export is enabled',
    response:{200:object({available:bool})}},async ()=>({available:Boolean(render)}));
  route(app,'POST','/v1/assets/:id/video-export',{tags,params:idParams,
    summary:'Export an owned MP4 explicitly declared to be AI-generated',produces:[mp4],
    body:object({aiGenerated:{const:true}})},async (request,reply)=>{
    return sendVideoDelivery(render,await source(db,request),request.params.id,reply);
  });
  route(app,'POST','/v1/media/videos/:id/export',{tags,params:idParams,
    summary:'Reframe an owned MP4, extract a still, mute it or export its audio',
    produces:Object.values(videoFormats),
    body:object({format:choice(...Object.keys(videoFormats)),ratio:choice('original',...Object.keys(videoProfiles)),
      frameMs:integer(0,59999),keepAudio:bool,aiGenerated:{const:true}},['format']),
  },async (request,reply)=>{
    const {format,ratio='original',frameMs,keepAudio,aiGenerated}=request.body;
    if ((format==='mp3' && ratio!=='original') || (format!=='mp4' && keepAudio!==undefined)
      || (['mp3','mp4'].includes(format) && frameMs!==undefined)) throw invalid('Select options supported by this export format');
    const asset=await source(db,request);
    if (!render?.process) throw unavailable();
    const bytes=await render.process(asset.data,{format,ratio,frameMs,keepAudio,mark:asset.generated || aiGenerated===true});
    return videoAttachment(reply,bytes,'video-'+request.params.id,format);
  });
}
