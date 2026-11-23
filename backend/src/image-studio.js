import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { generatedAsset } from './ai-export-mark.js';
import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, route, text, uuid } from './http.js';
import { stableJson } from './tasks.js';

const profiles={
  square:[800,800],portrait:[900,1200],story:[720,1280],wide:[1280,720],detail:[800,4800],
};
const rgb={...text(7,7),pattern:'^#[a-fA-F0-9]{6}$'};
const editSchema={oneOf:[
  object({method:choice('cutout'),maskAssetId:uuid}),
  object({method:choice('tint'),maskAssetId:uuid,color:rgb}),
  object({method:choice('replace-region'),maskAssetId:uuid,replacementAssetId:uuid}),
]};
const jobSchema=object({key:text(100),assetIds:array(uuid,6,1),profile:choice(...Object.keys(profiles)),
  width:integer(32,1920),height:integer(32,6144),scale:integer(2,4),fit:choice('contain','cover'),
  background:{anyOf:[rgb,choice('transparent')]},backgroundAssetId:uuid,edit:editSchema,format:choice('png','jpeg')},
  ['key','assetIds']);
const busy=()=>new ApiError(503,'IMAGE_RENDER_BUSY','The image renderer is busy. Retry in a moment');
const failure=()=>new ApiError(503,'IMAGE_RENDER_FAILED','The image worker did not complete');
const conflict=()=>new ApiError(409,'IDEMPOTENCY_CONFLICT','This batch ID belongs to a different image request');

function normalize(jobs) {
  const keys=new Set();
  return jobs.map(({key,assetIds,profile,width,height,scale,fit='contain',background,backgroundAssetId,edit,format='png'})=>{
    const label=key.trim();
    if (!label || keys.has(label.toLowerCase())) throw invalid('Use distinct nonblank image job keys');
    keys.add(label.toLowerCase());
    if (((profile || scale) && (width!==undefined || height!==undefined)) || (profile && scale)) {
      throw invalid('Use a preset, a scale factor or custom dimensions');
    }
    if ((scale || edit || backgroundAssetId) && assetIds.length!==1) throw invalid('Use one subject for scaling, editing or background replacement');
    if (profile) [width,height]=profiles[profile];
    if (!scale && (!width || !height || width*height>4_000_000 || height/assetIds.length<32)) {
      throw invalid('Fit all image panels within the canvas limit');
    }
    background ??=edit?.method==='cutout'?'transparent':'#ffffff';
    if (background==='transparent' && format==='jpeg') throw invalid('Choose PNG or an opaque background');
    const identifiers=assetIds.map(id=>id.toLowerCase());
    const backdrop=backgroundAssetId?.toLowerCase();
    const mask=edit?.maskAssetId.toLowerCase();
    const replacement=edit?.replacementAssetId?.toLowerCase();
    const inputs=[...identifiers,...[backdrop,mask,replacement].filter(Boolean)];
    return {key:label,assetIds:identifiers,inputs,width,height,scale,fit,background,backdrop,
      edit:edit && {...edit,maskAssetId:mask,replacementAssetId:replacement},mediaType:'image/'+format,format};
  });
}

function render(jobs) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./image-studio-worker.js',import.meta.url),{workerData:jobs});
    const timeout=setTimeout(()=>{
      void worker.terminate();
      reject(new ApiError(503,'IMAGE_RENDER_TIMEOUT','The image batch exceeded the rendering time limit'));
    },35000);
    worker.once('message',result=>{clearTimeout(timeout);resolve(result);});
    worker.once('error',()=>{clearTimeout(timeout);reject(failure());});
    worker.once('exit',()=>{clearTimeout(timeout);reject(failure());});
  });
}

async function existing(db,key,hash) {
  const batch=await row(db,`SELECT request_hash,result FROM studio_image_batches WHERE workspace_id=$1 AND account_id=$2 AND id=$3`,key);
  if (batch && batch.request_hash!==hash) throw conflict();
  return batch?.result;
}

export function registerImageStudio(app,db) {
  let active=0;
  route(app,'GET','/v1/media/images/batches/:id',{
    tags:['Image processing'],summary:'Read a completed owned image batch',params:object({id:uuid}),
  },async request=>{
    const batch=await row(db,`SELECT result FROM studio_image_batches WHERE workspace_id=$1 AND account_id=$2 AND id=$3`,
      [request.context.workspaceId,request.context.accountId,request.params.id]);
    if (!batch) throw notFound('Image batch');
    return batch.result;
  });
  route(app,'POST','/v1/media/images/batches',{ feature: 'image',
    tags:['Image processing'],summary:'Render and save owned images per SKU or as a stacked detail sheet',
    body:object({id:uuid,items:array(jobSchema,8,1)}),
  },async (request,reply)=>{
    const {workspaceId,accountId}=request.context;
    const {id}=request.body;
    const jobs=normalize(request.body.items);
    const key=[workspaceId,accountId,id];
    const hash=createHash('sha256').update(stableJson(JSON.parse(JSON.stringify(jobs)))).digest('hex');
    const prior=await existing(db,key,hash);
    if (prior) return prior;
    if (active>=2) throw busy();
    active++;
    try {
      const ids=[...new Set(jobs.flatMap(job=>job.inputs))];
      const allowed=await rows(db,`SELECT id,octet_length(data) AS size FROM assets WHERE workspace_id=$1 AND account_id=$2
        AND id=ANY($3::uuid[]) AND NOT rights_restricted AND media_type IN ('image/png','image/jpeg')`,[workspaceId,accountId,ids]);
      if (allowed.reduce((sum,asset)=>sum+asset.size,0)>24*1024*1024) {
        throw new ApiError(413,'IMAGE_BATCH_LIMIT','Combined batch source size exceeds 24 MiB');
      }
      const assets=await rows(db,`SELECT a.id,a.data,${generatedAsset('a')} AS generated FROM assets a
        WHERE a.workspace_id=$1 AND a.account_id=$2 AND a.id=ANY($3::uuid[]) AND NOT a.rights_restricted`,
        [workspaceId,accountId,allowed.map(asset=>asset.id)]);
      const byId=new Map(assets.map(asset=>[asset.id,asset]));
      const outputs=await render(jobs.map(job=>({job,sources:job.inputs.map(id=>byId.get(id))})));
      const saved=await db.transaction(async tx=>{
        const created=await row(tx,`INSERT INTO studio_image_batches(workspace_id,account_id,id,request_hash,result)
          VALUES($1,$2,$3,$4,'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[...key,hash]);
        if (!created) return {result:await existing(tx,key,hash),created:false};
        const allowedNow=new Set((await rows(tx,`SELECT id FROM assets WHERE workspace_id=$1 AND account_id=$2
          AND id=ANY($3::uuid[]) AND NOT rights_restricted ORDER BY id FOR SHARE`,
          [workspaceId,accountId,assets.map(asset=>asset.id)])).map(asset=>asset.id));
        const items=[];
        for (const [index,job] of jobs.entries()) {
          const output=outputs[index];
          const error=output.error ?? (job.inputs.some(source=>!allowedNow.has(source))?'SOURCE_UNAVAILABLE':null);
          if (error) {items.push({key:job.key,state:'failed',error});continue;}
          const assetId=randomUUID();
          const suffix=job.format==='jpeg'?'jpg':job.format;
          await tx.query(`INSERT INTO assets(id,workspace_id,account_id,name,media_type,source,purpose,data,derived_ai)
            VALUES($1,$2,$3,$4,$5,'studio-image','image-render',$6,$7)`,
            [assetId,workspaceId,accountId,assetId+'.'+suffix,job.mediaType,Buffer.from(output.bytes),output.aiGenerated]);
          items.push({key:job.key,state:'succeeded',assetId,mediaType:job.mediaType,width:output.width,height:output.height,aiGenerated:output.aiGenerated});
        }
        const result={id:created.id,items};
        await tx.query('UPDATE studio_image_batches SET result=$4::jsonb WHERE workspace_id=$1 AND account_id=$2 AND id=$3',[...key,JSON.stringify(result)]);
        return {result,created:true};
      });
      return reply.code(saved.created?201:200).send(saved.result);
    } finally {active--;}
  });
}
