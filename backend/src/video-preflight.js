import { row } from './db.js';
import { ApiError, array, bool, choice, integer, notFound, object, route, uuid } from './http.js';
import { lockPlugin, requirePlugin } from './plugin-policy.js';

const path='/v1/media/videos/:id/preflight';
const options={tags:['Video delivery'],params:object({id:uuid})};
const observations={shotCount:integer(1,10000),personCount:integer(0,10000),maxFacingAngle:{type:'number',minimum:0,maximum:180}};
const reasons=choice('DURATION','RESOLUTION','MULTIPLE_SHOTS','PERSON_COUNT','FACING_ANGLE');
const result=object({revision:integer(1,2147483647),width:integer(1,1920),height:integer(1,1920),
  durationSeconds:{type:'number'},containerSeconds:{type:'number'},...observations,eligible:bool,reasons:array(reasons,5)});
const owned="workspace_id=$1 AND account_id=$2 AND id=$3 AND NOT rights_restricted AND media_type='video/mp4'";
const key=r=>[r.context.workspaceId,r.context.accountId,r.params.id];
const conflict=()=>new ApiError(409,'VIDEO_REVIEW_CHANGED','Reload the latest source review');

export function registerVideoPreflight(app,db,renderer) {
  route(app,'GET',path,{...options,summary:'Read the technical and human source review of an owned MP4',
    response:{200:result}},async request=>{
    const asset=await row(db,'SELECT video_source_review FROM assets WHERE '+owned,key(request));
    if (!asset?.video_source_review) throw notFound('Video source review');
    return asset.video_source_review;
  });
  route(app,'PUT',path,{...options,summary:'Measure an MP4 and record shot, person and maximum facing angle observations',
    body:object({revision:integer(0,2147483646),...observations}),response:{200:result}},async request=>{
    const ids=key(request);
    await requirePlugin(db,ids[0],'video');
    const asset=await row(db,'SELECT data FROM assets WHERE '+owned,ids);
    if (!asset) throw notFound('Video asset');
    if (!renderer?.measure) throw new ApiError(503,'VIDEO_PREFLIGHT_UNAVAILABLE','Video inspection is not configured');
    const measured=await renderer.measure(asset.data);
    const {revision,shotCount,personCount,maxFacingAngle}=request.body;
    const {width,height,durationSeconds,containerSeconds}=measured;
    const shortSide=Math.min(width,height);
    const problems=[];
    if (durationSeconds<1 || durationSeconds>10 || containerSeconds>10) problems.push('DURATION');
    if (shortSide<720 || shortSide>1080) problems.push('RESOLUTION');
    if (shotCount!==1) problems.push('MULTIPLE_SHOTS');
    if (personCount!==1) problems.push('PERSON_COUNT');
    if (maxFacingAngle>60) problems.push('FACING_ANGLE');
    const review={revision:revision+1,...measured,shotCount,personCount,maxFacingAngle,reasons:problems,eligible:!problems.length};
    return db.transaction(async tx=>{
      await lockPlugin(tx,ids[0],'video');
      const current=await row(tx,'SELECT video_source_review AS review FROM assets WHERE '+owned+' FOR UPDATE',ids);
      if (!current) throw notFound('Video asset');
      if ((current.review?.revision ?? 0)!==revision) {
        if (current.review?.revision===revision+1 && current.review.shotCount===shotCount &&
            current.review.personCount===personCount && current.review.maxFacingAngle===maxFacingAngle) return current.review;
        throw conflict();
      }
      await tx.query('UPDATE assets SET video_source_review=$4::jsonb WHERE '+owned,[...ids,JSON.stringify(review)]);
      return review;
    });
  });
}
