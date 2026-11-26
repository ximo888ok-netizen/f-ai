import { randomUUID } from 'node:crypto';
import { catalog } from './catalog.js';
import { listingDraft } from './contracts.js';
import { row, rows } from './db.js';
import { ApiError, array, bool, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { applyDraftImages } from './listing-drafts.js';
import { modelIdSchema } from './models.js';
import { requireFeature } from './merchant-features.js';
import { imageDelivery, imageDeliveryFields, imagePlanRetryUrl, productImagePlanPath as root } from './product-image-contract.js';
import { eventCursor } from './task-events.js';
import { stableJson, submitInTransaction } from './tasks.js';

const tags = ['Product image plans'];
const generationCapability = 'image.main-image';
const maxImages = 8;
const revision = integer(1, 2147483647);
const position = integer(0, maxImages - 1);
const params = object({id:uuid});
const planKey = (context, id) => [context.workspaceId, context.accountId, id];
const ownedPlan = 'workspace_id=$1 AND account_id=$2 AND id=$3';
const ownedAttempts = 'a.workspace_id=$1 AND a.account_id=$2 AND a.plan_id=$3';
const planFields = 'id,source,layout,revision,confirmed_at AS "confirmedAt",requested_model_id AS "requestedModelId",updated_at AS "updatedAt"';
const imageSpec = object({role:choice('main','detail'),title:text(160),direction:text(1200)});
const editableLayout = object({designNotes:text(1300),images:array(imageSpec,maxImages,1)});
const brief = object({productName:text(200),requirements:text(1000),assetIds:array(uuid,6,1),detailCount:integer(0,7)});
const datetime = {type:'string',format:'date-time'};
const planSummary = {id:uuid,revision,confirmedAt:{type:['string','null'],format:'date-time'},updatedAt:datetime};
const planList = object({items:array(object({...planSummary,productName:{type:'string'}}),100)});
const planImage = object({
  ...imageSpec.properties,position,attempt:integer(0,2147483647),
  state:choice('planned','queued','running','succeeded','failed','cancelled','unavailable'),
  taskId:{type:['string','null'],format:'uuid'},errorCode:{type:['string','null']},
  eventCursor,canRetry:bool,retryUrl:{type:['string','null']},...imageDeliveryFields,
});
const planResponse = object({
  ...planSummary,source:brief,designNotes:text(1300),images:array(planImage,maxImages,1),
  state:choice('draft','generating','succeeded','partial','failed'),modelId:{type:['string','null']},
  estimatedCredits:integer(0,2147483647),
});
const retryResponse = object({position,attempt:integer(1,2147483647),taskId:uuid});
const detailIdeas = [
  ['主体细节','放大能够从参考图确认的产品细节，标出细节位置。'],
  ['使用场景','展示符合商品资料的一种使用场景，保持产品外观与参考图一致。'],
  ['卖点摘要','突出已提供的商品卖点，留出用于标题和短说明的空间。'],
  ['产品轮廓','用简洁构图展示已知轮廓，保留商品比例和外形。'],
  ['规格提示','只展示资料中明确的规格，留出后续编辑规格说明的空间。'],
  ['材质与色彩','展示图中可见的颜色和质感，只标注已经确认的材质。'],
  ['随附内容','按已知商品资料展示随附内容，未提供内容时采用主体特写。'],
];

function normalizeLayout(input) {
  const designNotes = input.designNotes.trim();
  const images = input.images.map(({role,title,direction}) => ({role,title:title.trim(),direction:direction.trim()}));
  if (!designNotes || images.some(image => !image.title || !image.direction)) throw invalid('Enter nonblank design notes, titles and directions');
  if (images[0].role !== 'main' || images.slice(1).some(image => image.role !== 'detail')) {
    throw invalid('Provide one main image first, followed by detail images');
  }
  return {designNotes,images};
}

function suggestLayout(source) {
  return {
    designNotes: '整组保持商品外观、颜色和画面风格一致。商品要求：' + source.requirements,
    images: [
      {role:'main',title:'商品主图',direction:'使用简洁背景呈现完整商品，突出主体，保留参考图中的外观与比例。'},
      ...detailIdeas.slice(0,source.detailCount).map(([title,direction]) => ({role:'detail',title,direction})),
    ],
  };
}

async function checkSources(db, key, ids) {
  const available = await rows(db, `SELECT octet_length(data) AS size FROM assets
    WHERE workspace_id=$1 AND account_id=$2 AND id=ANY($3::uuid[]) AND NOT rights_restricted
    AND media_type IN ('image/png','image/jpeg') ORDER BY id FOR SHARE`, [key[0],key[1],ids]);
  if (available.length !== ids.length) throw notFound('Available source image');
  if (available.reduce((total, asset) => total + asset.size, 0) > 20 * 1024 * 1024) {
    throw new ApiError(413, 'ASSET_LIMIT', 'Combined source images exceed 20 MiB');
  }
}

async function getPlan(db, key, lock = false) {
  const plan = await row(db, 'SELECT '+planFields+' FROM product_image_plans WHERE '+ownedPlan+(lock?' FOR UPDATE':''), key);
  if (!plan) throw notFound('Product image plan');
  return plan;
}

async function currentImages(db, key) {
  return rows(db, `SELECT DISTINCT ON (a.position) a.position,a.attempt,a.task_id AS "taskId",
    CASE WHEN t.state='succeeded' AND asset.id IS NULL THEN 'unavailable' ELSE t.state END AS state,
    CASE WHEN t.state='succeeded' AND asset.id IS NULL THEN 'IMAGE_RESULT_UNAVAILABLE' ELSE t.error_code END AS "errorCode",
    asset.id AS "assetId",
    COALESCE((SELECT MAX(e.id) FROM task_events e WHERE e.task_id=t.id),0)::text AS "eventCursor"
    FROM product_image_attempts a
    JOIN tasks t ON t.id=a.task_id AND t.workspace_id=a.workspace_id AND t.account_id=a.account_id
    LEFT JOIN assets asset ON t.state='succeeded'
      AND asset.id=CASE WHEN t.input->>'requireImageAsset'='true' THEN (t.result->>'assetId')::uuid END
      AND asset.workspace_id=a.workspace_id AND asset.account_id=a.account_id AND NOT asset.rights_restricted
    WHERE ${ownedAttempts} ORDER BY a.position,a.attempt DESC`, key);
}

async function describe(db, key, plan) {
  const {layout, requestedModelId, ...record} = plan;
  const attempts = plan.confirmedAt ? await currentImages(db, key) : [];
  const images = layout.images.map((image, index) => {
    const current = attempts[index] ?? {state:'planned',taskId:null,attempt:0,errorCode:null,assetId:null,eventCursor:'0'};
    const canRetry = ['failed','cancelled'].includes(current.state);
    return {...image,position:index,...current,canRetry,
      retryUrl:canRetry ? imagePlanRetryUrl(plan.id,index) : null,
      ...imageDelivery(current.assetId)};
  });
  const successes = attempts.filter(entry => entry.state === 'succeeded').length;
  let state = 'draft';
  if (plan.confirmedAt) {
    if (attempts.some(entry => ['queued','running'].includes(entry.state))) state = 'generating';
    else if (successes === images.length) state = 'succeeded';
    else state = successes ? 'partial' : 'failed';
  }
  return {...record,designNotes:layout.designNotes,images,state,
    modelId:requestedModelId,estimatedCredits:images.length * catalog.get(generationCapability).cost};
}

async function queueImage(db, providers, shops, context, plan, index, attempt, modelId, parentId = null) {
  const image = plan.layout.images[index];
  const prompt = [
    '生成一张独立的电商商品图片。保持参考商品的外观和比例。只使用已经提供的事实，不编造规格、认证、售价或承诺。',
    '商品名称：' + plan.source.productName,
    '商品要求：' + plan.source.requirements,
    '整体设计：' + plan.layout.designNotes,
    '图片用途：' + (image.role === 'main' ? '主图' : '详情图'),
    '图片标题：' + image.title,
    '本图方向：' + image.direction,
  ].join('\n');
  const {task} = await submitInTransaction(db, providers, shops, context, {
    capabilityId:generationCapability, mode:'workflow', modelId:modelId ?? undefined,
    idempotencyKey:'product-image:' + randomUUID(), parameters:{prompt,assetIds:plan.source.assetIds},
  }, parentId, {requireImageAsset:true});
  await db.query(`INSERT INTO product_image_attempts (workspace_id,account_id,plan_id,position,attempt,task_id)
     VALUES ($1,$2,$3,$4,$5,$6)`, [...planKey(context, plan.id),index,attempt,task.id]);
  return task;
}

export function registerProductImagePlans(app, db, providers, shops) {
  async function retryImage(context, planId, index, taskId) {
    const key = planKey(context, planId);
    return db.transaction(async tx => {
      const plan = await getPlan(tx, key, true);
      const previous = await row(tx, `SELECT a.attempt,a.task_id AS "taskId",t.state,t.input->>'modelId' AS "modelId",
        successor.task_id AS "retryTaskId" FROM product_image_attempts a
        JOIN tasks t ON t.id=a.task_id AND t.workspace_id=a.workspace_id AND t.account_id=a.account_id
        LEFT JOIN product_image_attempts successor ON successor.workspace_id=a.workspace_id AND successor.account_id=a.account_id
          AND successor.plan_id=a.plan_id AND successor.position=a.position AND successor.attempt=a.attempt+1
        WHERE ${ownedAttempts} AND a.position=$4 AND a.task_id=$5`, [...key,index,taskId]);
      if (!previous) throw notFound('Image attempt');
      const attempt = previous.attempt + 1;
      if (previous.retryTaskId) return {created:false,image:{position:index,attempt,taskId:previous.retryTaskId}};
      if (!['failed','cancelled'].includes(previous.state)) throw new ApiError(409,'IMAGE_RETRY_NOT_AVAILABLE','Only failed or cancelled images can be retried');
      const task = await queueImage(tx, providers, shops, context, plan, index, attempt, previous.modelId ?? plan.requestedModelId, previous.taskId);
      return {created:true,image:{position:index,attempt,taskId:task.id}};
    });
  }

  route(app, 'GET', root, {tags,querystring:page,summary:'List your product image plans',response:{200:planList}}, async request => ({
    items:await rows(db, `SELECT id,source->>'productName' AS "productName",revision,confirmed_at AS "confirmedAt",updated_at AS "updatedAt"
      FROM product_image_plans WHERE workspace_id=$1 AND account_id=$2 ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,
    [request.context.workspaceId,request.context.accountId,...paginate(request.query)]),
  }));

  route(app, 'POST', root, {tags,body:object({id:uuid,...brief.properties}),summary:'Create an editable product image plan from your brief',
    response:{200:{...planResponse,description:'Existing plan replay'},201:{...planResponse,description:'Plan created'}}}, async (request,reply) => {
    const {id,productName,requirements,assetIds,detailCount} = request.body;
    const source = {productName:productName.trim(),requirements:requirements.trim(),
      assetIds:assetIds.map(value => value.toLowerCase()),detailCount};
    if (!source.productName || !source.requirements || new Set(source.assetIds).size !== assetIds.length) {
      throw invalid('Enter a product name, requirements and distinct source images');
    }
    const key = planKey(request.context, id);
    return db.transaction(async tx => {
      const saved = await row(tx, `INSERT INTO product_image_plans (workspace_id,account_id,id,source,layout)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT DO NOTHING RETURNING ${planFields}`,
      [...key,JSON.stringify(source),JSON.stringify(suggestLayout(source))]);
      const plan = saved ?? await getPlan(tx, key);
      if (stableJson(plan.source) !== stableJson(source)) throw new ApiError(409,'IMAGE_PLAN_ID_CONFLICT','This plan ID belongs to another product brief');
      if (saved) {
        await requireFeature(tx, request.context, 'image', generationCapability, true);
        await checkSources(tx, key, source.assetIds);
        reply.code(201);
      }
      return describe(tx, key, plan);
    });
  });

  route(app, 'GET', root+'/:id', {tags,params,summary:'Read your image plan and current per-image results',response:{200:planResponse}}, async request => {
    const key = planKey(request.context, request.params.id);
    return describe(db, key, await getPlan(db, key));
  });

  route(app, 'PUT', root+'/:id', {tags,params,body:object({revision:integer(1,2147483646),...editableLayout.properties}),
    summary:'Edit design notes and image directions before confirmation',response:{200:planResponse}}, async request => {
    const key = planKey(request.context, request.params.id);
    const layout = normalizeLayout(request.body);
    return db.transaction(async tx => {
      const plan = await getPlan(tx, key, true);
      if (plan.confirmedAt) throw new ApiError(409,'IMAGE_PLAN_CONFIRMED','This plan has already been confirmed');
      if (plan.revision === request.body.revision + 1 && stableJson(plan.layout) === stableJson(layout)) return describe(tx, key, plan);
      if (plan.revision !== request.body.revision) throw new ApiError(409,'IMAGE_PLAN_CHANGED','Reload the edited image plan');
      await requireFeature(tx, request.context, 'image', generationCapability, true);
      const saved = await row(tx, `UPDATE product_image_plans SET layout=$4::jsonb,revision=revision+1,updated_at=now()
        WHERE ${ownedPlan} RETURNING ${planFields}`, [...key,JSON.stringify(layout)]);
      return describe(tx, key, saved);
    });
  });

  route(app, 'POST', root+'/:id/confirm', {tags,params,body:object({revision,modelId:modelIdSchema},['revision']),
    summary:'Confirm the saved revision and enqueue the full image set atomically',
    response:{200:{...planResponse,description:'Confirmation replay'},202:{...planResponse,description:'Image set queued'}}}, async (request,reply) => {
    const {context,body} = request;
    const key = planKey(context, request.params.id);
    const chosenModel = body.modelId ?? null;
    return db.transaction(async tx => {
      const plan = await getPlan(tx, key, true);
      if (plan.revision !== body.revision) throw new ApiError(409,'IMAGE_PLAN_CHANGED','Reload the edited image plan');
      if (plan.confirmedAt) {
        if (plan.requestedModelId !== chosenModel) throw new ApiError(409,'IMAGE_PLAN_CONFIRMED','This plan uses a different model selection');
        return describe(tx, key, plan);
      }
      // Acquire the wallet before the plugin and asset locks, using the task submission lock order.
      await row(tx, 'SELECT balance FROM wallets WHERE workspace_id=$1 AND account_id=$2 FOR UPDATE', key.slice(0,2));
      await requireFeature(tx, request.context, 'image', generationCapability, true);
      await checkSources(tx, key, plan.source.assetIds);
      for (const index of plan.layout.images.keys()) {
        await queueImage(tx, providers, shops, context, plan, index, 1, chosenModel);
      }
      const saved = await row(tx, `UPDATE product_image_plans SET confirmed_at=now(),requested_model_id=$4,updated_at=now()
        WHERE ${ownedPlan} RETURNING ${planFields}`, [...key,chosenModel]);
      reply.code(202);
      return describe(tx, key, saved);
    });
  });

  route(app, 'POST', root+'/:id/images/:position/retry', {
    tags,params:object({id:uuid,position}),body:object({taskId:uuid}),summary:'Retry one failed or cancelled image using its latest task ID',
    response:{200:{...retryResponse,description:'Retry replay'},202:{...retryResponse,description:'Image retry queued'}},
  }, async (request,reply) => {
    const result = await retryImage(request.context, request.params.id, request.params.position, request.body.taskId);
    return reply.code(result.created ? 202 : 200).send(result.image);
  });

  route(app, 'POST', root+'/:id/apply-to-draft', {
    tags,params,body:object({draftId:uuid,draftRevision:revision,detailPositions:{...array(integer(1,7),7),uniqueItems:true}}),
    summary:'Replace the main and selected detail images of an owned Pinduoduo draft',response:{200:listingDraft},
  }, async request => {
    const key = planKey(request.context, request.params.id);
    const {draftId,draftRevision,detailPositions} = request.body;
    return db.transaction(async tx => {
      await getPlan(tx, key, true);
      const results = new Map((await currentImages(tx, key)).map(image => [image.position,image]));
      const selected = [0,...detailPositions].map(index => results.get(index));
      if (selected.some(image => image?.state !== 'succeeded')) {
        throw new ApiError(409,'IMAGE_NOT_READY','Choose successfully generated images that are still available');
      }
      const [main,...details] = selected.map((image,index) => ({role:index === 0?'main':'detail',assetId:image.assetId}));
      return applyDraftImages(tx, planKey(request.context, draftId), draftRevision, {main,details});
    });
  });

  return retryImage;
}
