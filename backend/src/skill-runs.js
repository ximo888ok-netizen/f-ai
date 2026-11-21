import { detectTerms } from './catalog.js';
import { row } from './db.js';
import { integer, invalid, object, route, text, uuid } from './http.js';
import { readDraft, variantCheck } from './listing-drafts.js';
import { modelIdSchema } from './models.js';
import { submitInTransaction } from './tasks.js';
import { executableSkill } from './workspace-library.js';

function reviewCopy(content) {
  const {matches,offsetUnit}=detectTerms({content});
  let preview=content;
  for (const {start,end,suggestion} of [...matches].reverse()) {
    preview=preview.slice(0,start)+suggestion+preview.slice(end);
  }
  return {matches,offsetUnit,preview};
}

async function reviewSkus(db,context,id) {
  const draft=await readDraft(db,[context.workspaceId,context.accountId,id]);
  const variants=[draft,...draft.variants].map((variant,index)=>({
    position:index,sku:variant.sku,...variantCheck(variant),
  }));
  return {draftId:draft.id,draftRevision:draft.revision,variants,ready:variants.every(variant=>!variant.missing.length)};
}

export function registerSkillRuns(app,db,providers,shops) {
  route(app,'POST','/v1/library/:id/runs',{
    tags:['Expert and skill library'],summary:'Run a workspace skill at a specified revision',params:object({id:uuid}),
    body:object({revision:integer(1,2147483646),content:text(8000),draftId:uuid,idempotencyKey:text(120),
      projectId:uuid,modelId:modelIdSchema},['revision']),
  },async (request,reply)=>{
    const {context,body}=request;
    const {workspaceId}=context;
    const result=await db.transaction(async tx=>{
      await row(tx,'SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[workspaceId]);
      const entry=await executableSkill(tx,workspaceId,request.params.id,body.revision);
      const action=entry.skillAction ?? 'model-chat';
      const run={skillId:entry.id,revision:entry.revision,action};
      if (action==='sku-review') {
        if (!body.draftId || Object.keys(body).length!==2) throw invalid('Supply an owned draft ID for SKU review');
        return {...run,result:await reviewSkus(tx,context,body.draftId)};
      }
      const content=body.content?.trim();
      if (!content || body.draftId) throw invalid('Supply text for the selected skill');
      if (action==='copy-review') {
        if (Object.keys(body).length!==2) throw invalid('Supply text for copy review');
        return {...run,result:reviewCopy(content)};
      }
      if (!body.idempotencyKey?.trim()) throw invalid('Model skills require an idempotency key');
      const {task,created}=await submitInTransaction(tx,providers,shops,context,{
        capabilityId:'model.chat',mode:'chat',modelId:body.modelId,projectId:body.projectId,idempotencyKey:body.idempotencyKey,
        parameters:{messages:[{role:'user',content}],guidanceIds:[entry.id]},
      });
      return {...run,task,created};
    });
    const {created,...response}=result;
    return reply.code(created?202:200).send(response);
  });
}
