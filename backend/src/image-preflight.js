import { row } from './db.js';
import { ApiError, array, bool, choice, integer, invalid, notFound, object, route, uuid } from './http.js';
import { lockPlugin } from './plugin-policy.js';
import { decodeImage } from './raster.js';

const path='/v1/media/images/:id/preflight';
const options={tags:['Image studio'],params:object({id:uuid})};
const observations={personCount:integer(0,10000),occlusionPercent:{type:'number',minimum:0,maximum:100}};
const result=object({revision:integer(1,2147483647),width:integer(1,16000000),height:integer(1,16000000),
  ...observations,eligible:bool,reasons:array(choice('SHORT_SIDE','PERSON_COUNT','OCCLUSION'),3)});
const owned="workspace_id=$1 AND account_id=$2 AND id=$3 AND NOT rights_restricted AND media_type IN ('image/png','image/jpeg')";
const key=r=>[r.context.workspaceId,r.context.accountId,r.params.id];

export function needsImageReview(capability) {
  return capability.id==='image.try-on' || capability.id==='image.replace-product';
}

export function checkImageInputs(capability,orderedAssets) {
  for (const [index,asset] of orderedAssets.entries()) {
    const input='Image input '+(index+1);
    if (!['image/png','image/jpeg'].includes(asset.media_type)) {
      throw new ApiError(422,'IMAGE_TYPE_REQUIRED',input+' must be a PNG or JPEG');
    }
    const review=asset.image_source_review;
    if (!review) throw new ApiError(422,'IMAGE_PREFLIGHT_REQUIRED',input+' needs a source review');
    if (!review.eligible) throw new ApiError(422,'IMAGE_PREFLIGHT_FAILED',input+' failed: '+review.reasons.join(', '));
    if (index===0 && capability.id==='image.try-on' && review.personCount!==1) {
      throw new ApiError(422,'IMAGE_MODEL_REQUIRED','The first try-on image must show exactly one person');
    }
  }
}

export function registerImagePreflight(app,db) {
  route(app,'GET',path,{...options,summary:'Read the measured dimensions and reviewed subject observations of an owned image',
    response:{200:result}},async request=>{
    const asset=await row(db,'SELECT image_source_review AS review FROM assets WHERE '+owned,key(request));
    if (!asset?.review) throw notFound('Image source review');
    return asset.review;
  });
  route(app,'PUT',path,{...options,summary:'Measure an image and record its person count and clothing occlusion',
    body:object({revision:integer(0,2147483646),...observations}),response:{200:result}},request=>db.transaction(async tx=>{
    const ids=key(request);
    const {revision,personCount,occlusionPercent}=request.body;
    if (personCount===0 && occlusionPercent!==0) throw invalid('For a product-only image, use zero clothing occlusion');
    await lockPlugin(tx,ids[0],'image');
    const asset=await row(tx,`SELECT image_source_review AS review,CASE WHEN image_source_review IS NULL THEN data END AS data
      FROM assets WHERE ${owned} FOR UPDATE`,ids);
    if (!asset) throw notFound('Image');
    const current=asset.review;
    if ((current?.revision ?? 0)!==revision) {
      if (current?.revision===revision+1 && current.personCount===personCount && current.occlusionPercent===occlusionPercent) return current;
      throw new ApiError(409,'IMAGE_REVIEW_CHANGED','Reload the latest image review');
    }
    let dimensions=current;
    if (!dimensions) {
      try { dimensions=await decodeImage(asset.data); }
      catch { throw new ApiError(422,'IMAGE_DECODE_FAILED','Cannot decode the PNG or JPEG within the image size limit'); }
    }
    const {width,height}=dimensions;
    const reasons=[];
    if (Math.min(width,height)<1024) reasons.push('SHORT_SIDE');
    if (personCount>1) reasons.push('PERSON_COUNT');
    if (occlusionPercent>5) reasons.push('OCCLUSION');
    const review={revision:revision+1,width,height,personCount,occlusionPercent,eligible:reasons.length===0,reasons};
    await tx.query('UPDATE assets SET image_source_review=$4 WHERE '+owned,[...ids,review]);
    return review;
  }));
}
