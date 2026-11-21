import { Worker } from 'node:worker_threads';
import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { generatedAsset } from './ai-export-mark.js';

const root = '/v1/studio/psd-documents';
const tags = ['Studio PSD'];
const params = object({id:uuid});
const timestamps = { type:'string',format:'date-time' };
const dimension = integer(1,2048);
const offset = integer(0,2047);
const rgb = {...text(7,7),pattern:'^#[0-9a-fA-F]{6}$'};
const layout = object({
  width:integer(64,2048), height:integer(64,2048), backgroundColor:rgb,
  placement:object({x:offset,y:offset,width:dimension,height:dimension}),
  caption:object({text:{...text(140),pattern:'^[^\\u0000-\\u001f\\u007f]+$'},x:offset,y:dimension,
    size:integer(8,256),color:rgb,font:choice('sans','chinese')}),
});
const dataFields = { title:text(120),layout,subjectAssetId:uuid,backgroundAssetId:{type:['string','null'],format:'uuid'} };
const revision = integer(0,2147483646);
const brief = {id:uuid,title:text(120),revision,updatedAt:timestamps};
const summary = 'id,title,revision,updated_at AS "updatedAt"';
const fields = summary + ',layout,subject_asset_id AS "subjectAssetId",background_asset_id AS "backgroundAssetId"';
const record = object({...dataFields,...brief});
const saveBody = object({...dataFields,revision},['title','layout','subjectAssetId','revision']);
const invalidSource = () => new ApiError(422,'PSD_SOURCE_INVALID','Use decodable PNG or JPEG images within the pixel limit');
const conflict = () => new ApiError(409,'PSD_DOCUMENT_CHANGED','Reload the document before saving again');

function verify(layout) {
  const {width,height,placement,caption} = layout;
  if (width*height > 3_000_000 || placement.x+placement.width > width || placement.y+placement.height > height
      || caption.x >= width || caption.y > height || !caption.text.trim()) {
    throw invalid('Fit the subject and caption inside the canvas and enter nonblank caption text');
  }
}

function render(data) {
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL('./psd-render-worker.js',import.meta.url),{workerData:data});
    const expires = setTimeout(() => {
      void worker.terminate();
      reject(new ApiError(503,'PSD_RENDER_TIMEOUT','PSD rendering exceeded the time limit'));
    },25000);
    worker.once('message', message => {
      clearTimeout(expires);
      if (message.error) reject(invalidSource());
      else resolve(Buffer.from(message.bytes));
    });
    worker.once('error', () => {
      clearTimeout(expires);
      reject(new ApiError(500,'PSD_RENDER_FAILED','PSD renderer could not start'));
    });
    worker.once('exit', () => {
      clearTimeout(expires);
      reject(new ApiError(500,'PSD_RENDER_FAILED','PSD renderer exited without a result'));
    });
  });
}

export function registerStudioPsd(app, db) {
  let active = 0;
  route(app,'GET',root,{tags,summary:'List your layered design documents',querystring:page,
    response:{200:object({items:array(object(brief),100)})}},async request=>({
    items:await rows(db,`SELECT ${summary} FROM studio_psd_documents WHERE workspace_id=$1 AND account_id=$2
      ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,[request.context.workspaceId,request.context.accountId,...paginate(request.query)]),
  }));

  route(app,'GET',root+'/:id',{tags,summary:'Read a design for continued editing',params,response:{200:record}},async request => {
    const document = await row(db,`SELECT ${fields} FROM studio_psd_documents WHERE workspace_id=$1 AND account_id=$2 AND id=$3`,
      [request.context.workspaceId,request.context.accountId,request.params.id]);
    if (!document) throw notFound('PSD document');
    return document;
  });

  route(app,'PUT',root+'/:id',{tags,summary:'Save a layered design at the specified revision (zero for new)',params,body:saveBody,
    response:{200:record}},request=>db.transaction(async tx=>{
    const {workspaceId,accountId}=request.context;
    const {id}=request.params;
    const {title,layout,subjectAssetId,backgroundAssetId,revision}=request.body;
    if (!title.trim()) throw invalid('Design title cannot be blank');
    verify(layout);
    const ids=[...new Set([subjectAssetId,backgroundAssetId].filter(Boolean).map(v=>v.toLowerCase()))];
    const assets=await rows(tx,`SELECT id,media_type FROM assets WHERE workspace_id=$1 AND account_id=$2
      AND id=ANY($3::uuid[]) ORDER BY id FOR KEY SHARE`,[workspaceId,accountId,ids]);
    if (assets.length!==ids.length) throw notFound('Asset');
    if (assets.some(asset=>!['image/png','image/jpeg'].includes(asset.media_type))) throw invalidSource();

    const values=[workspaceId,accountId,id,title.trim(),layout,subjectAssetId,backgroundAssetId ?? null];
    const saved = revision === 0
      ? await row(tx,`INSERT INTO studio_psd_documents(workspace_id,account_id,id,title,layout,subject_asset_id,background_asset_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING ${fields}`,values)
      : await row(tx,`UPDATE studio_psd_documents SET title=$4,layout=$5,subject_asset_id=$6,background_asset_id=$7,
        revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND account_id=$2 AND id=$3 AND revision=$8 RETURNING ${fields}`,
      [...values,revision]);
    if (saved) return saved;
    const current=await row(tx,`SELECT ${fields}, (title=$4 AND layout=$5 AND subject_asset_id=$6 AND background_asset_id IS NOT DISTINCT FROM $7) AS matches
      FROM studio_psd_documents WHERE workspace_id=$1 AND account_id=$2 AND id=$3`,values);
    if (!current) throw notFound('PSD document');
    if (current?.revision===revision+1 && current.matches) {
      const {matches,...same}=current;
      return same;
    }
    throw conflict();
  }));

  route(app,'DELETE',root+'/:id',{tags,summary:'Remove a saved design and release its source references',params,
    response:{204:{type:'null'}}},async (request,reply)=>{
    const deleted=await row(db,'DELETE FROM studio_psd_documents WHERE workspace_id=$1 AND account_id=$2 AND id=$3 RETURNING id',
      [request.context.workspaceId,request.context.accountId,request.params.id]);
    if (!deleted) throw notFound('PSD document');
    reply.code(204).send();
  });

  route(app,'GET','/v1/assets/:id/delivery',{tags,params,summary:'Export an AI-generated image with visible and embedded provenance',
    produces:['image/png','image/jpeg']},async (request,reply)=>{
    if (active>=2) throw new ApiError(503,'PSD_RENDER_BUSY','The renderer is busy; retry in a moment');
    active++;
    try {
      const key=[request.context.workspaceId,request.context.accountId,request.params.id];
      const owned=await row(db,`SELECT a.data,a.media_type,${generatedAsset('a')} AS generated
        FROM assets a WHERE a.workspace_id=$1 AND a.account_id=$2 AND a.id=$3`,key);
      if (!owned) throw notFound('Asset');
      if (!owned.generated || !['image/png','image/jpeg'].includes(owned.media_type)) {
        throw new ApiError(422,'AI_IMAGE_REQUIRED','Choose a previously generated PNG or JPEG image');
      }
      const bytes=await render({format:'marked-source',mime:owned.media_type,subject:owned.data});
      const suffix=owned.media_type==='image/jpeg'?'.jpg':'.png';
      return reply.header('content-disposition','attachment; filename="delivery-'+request.params.id+suffix+'"')
        .type(owned.media_type).send(bytes);
    } finally {active--;}
  });

  for (const format of ['png','psd']) {
    const extension = format==='png' ? 'preview' : 'export';
    const mime = format==='png' ? 'image/png' : 'application/vnd.adobe.photoshop';
    route(app,'GET',root+'/:id/'+extension,{tags,summary:'Render design '+extension,params,
      produces:[mime]},async (request,reply)=>{
      if (active>=2) throw new ApiError(503,'PSD_RENDER_BUSY','The renderer is busy; retry in a moment');
      active++;
      try {
        const doc=await row(db,`SELECT d.layout,s.data AS subject,b.data AS background,
          (${generatedAsset('s')} OR ${generatedAsset('b')}) AS "aiGenerated" FROM studio_psd_documents d
          JOIN assets s ON s.id=d.subject_asset_id AND s.workspace_id=d.workspace_id AND s.account_id=d.account_id
          LEFT JOIN assets b ON b.id=d.background_asset_id AND b.workspace_id=d.workspace_id AND b.account_id=d.account_id
          WHERE d.workspace_id=$1 AND d.account_id=$2 AND d.id=$3`,
        [request.context.workspaceId,request.context.accountId,request.params.id]);
        if (!doc) throw notFound('PSD document');
        const bytes=await render({...doc,format});
        if (format==='psd') reply.header('content-disposition','attachment; filename="design-'+request.params.id+'.psd"');
        return reply.type(mime).send(bytes);
      } finally {active--;}
    });
  }
}
