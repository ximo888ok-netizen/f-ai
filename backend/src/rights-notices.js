import { row, rows } from './db.js';
import { ApiError, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { notify } from './notifications.js';

const root='/v1/rights/notices';
const tags=['Rights notices'];
const idParams=object({id:uuid});
const revision=integer(1,2147483646);
const columns='id,asset_id AS "assetId",reporter_id AS "reporterId",affected_id AS "affectedId",statement,'+
  'evidence_reference AS "evidenceReference",state,revision,forwarded_at AS "forwardedAt",created_at AS "createdAt",updated_at AS "updatedAt"';
const manager=context=>context.role!=='member';
const conflict=()=>new ApiError(409,'RIGHTS_NOTICE_CONFLICT','The notice changed or the action is unavailable in its current state');
const transitions={
  forward:{from:['submitted'],to:'forwarded'},
  restrict:{from:['forwarded'],to:'restricted'},
  counter:{from:['restricted'],to:'counter_received'},
  'forward-counter':{from:['counter_received'],to:'counter_forwarded'},
  uphold:{from:['restricted','counter_forwarded'],to:'upheld'},
  restore:{from:['restricted','counter_forwarded','upheld'],to:'restored'},
  dismiss:{from:['submitted','forwarded'],to:'dismissed'},
};
const heldStates=['restricted','counter_received','counter_forwarded','upheld'];

function nonblank(value) {
  const clean=value.trim();
  if (!clean) throw invalid('A statement and supporting reference cannot be blank');
  return clean;
}

async function notice(db,context,id,lock=false) {
  const item=await row(db,`SELECT ${columns} FROM rights_notices WHERE workspace_id=$1 AND id=$2
    AND ($4::bool OR reporter_id=$3 OR (affected_id=$3 AND forwarded_at IS NOT NULL)) ${lock?'FOR UPDATE':''}`,
    [context.workspaceId,id,context.accountId,manager(context)]);
  if (!item) throw notFound('Rights notice');
  return item;
}

function view(item,context) {
  if (manager(context)) return item;
  const {reporterId,affectedId,...fields}=item;
  return {...fields,reportedByMe:reporterId===context.accountId,affectsMyAsset:affectedId===context.accountId};
}

async function refreshAssetHold(tx,workspaceId,assetId,state) {
  const asset=await row(tx,'SELECT id FROM assets WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,assetId]);
  if (!asset && state==='restricted') throw notFound('Asset');
  if (!asset) return;
  await tx.query(`UPDATE assets SET rights_restricted=EXISTS(
    SELECT 1 FROM rights_notices WHERE workspace_id=$1 AND asset_id=$2 AND state=ANY($3::text[])
    ) WHERE workspace_id=$1 AND id=$2`,[workspaceId,assetId,heldStates]);
}

async function inform(tx,workspaceId,item,action) {
  const targets=action==='forward'?[item.affectedId]
    : action==='forward-counter' || action==='dismiss'?[item.reporterId]
      : action==='counter'?[]:[item.reporterId,item.affectedId];
  for (const account of new Set(targets)) {
    await notify(tx,workspaceId,account,'rights','rights.'+action,
      'rights:'+item.id+':'+item.revision,{noticeId:item.id,state:item.state});
  }
}

export function registerRightsNotices(app,db) {
  route(app,'GET',root,{tags,summary:'List rights notices visible to the current participant',querystring:page},async request=>{
    const {context}=request;
    const result=await rows(db,`SELECT ${columns} FROM rights_notices WHERE workspace_id=$1
      AND ($3::bool OR reporter_id=$2 OR (affected_id=$2 AND forwarded_at IS NOT NULL))
      ORDER BY updated_at DESC,id LIMIT $4 OFFSET $5`,
      [context.workspaceId,context.accountId,manager(context),...paginate(request.query)]);
    return {items:result.map(item=>view(item,context))};
  });
  route(app,'POST',root,{tags,summary:'Submit a rights notice about a workspace asset',
    body:object({id:uuid,assetId:uuid,statement:text(3000),evidenceReference:text(800)})},async (request,reply)=>{
    const {context,body}=request;
    const {workspaceId,accountId}=context;
    const statement=nonblank(body.statement);
    const evidence=nonblank(body.evidenceReference);
    const assetId=body.assetId.toLowerCase();
    const result=await db.transaction(async tx=>{
      const previous=await row(tx,`SELECT ${columns} FROM rights_notices WHERE workspace_id=$1 AND id=$2`,
        [workspaceId,body.id]);
      if (previous) {
        if (previous.reporterId!==accountId || previous.assetId!==assetId
          || previous.statement!==statement || previous.evidenceReference!==evidence) throw conflict();
        return {item:previous,created:false};
      }
      const asset=await row(tx,'SELECT account_id FROM assets WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE',[workspaceId,assetId]);
      if (!asset) throw notFound('Asset');
      const item=await row(tx,`INSERT INTO rights_notices(workspace_id,id,reporter_id,asset_id,affected_id,statement,evidence_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,id) DO NOTHING RETURNING ${columns}`,
        [workspaceId,body.id,accountId,assetId,asset.account_id,statement,evidence]);
      if (item) return {item,created:true};
      const match=await notice(tx,context,body.id);
      if (match.reporterId!==accountId || match.assetId!==assetId
        || match.statement!==statement || match.evidenceReference!==evidence) throw conflict();
      return {item:match,created:false};
    });
    return reply.code(result.created?201:200).send(view(result.item,context));
  });

  route(app,'GET',root+'/:id',{tags,params:idParams,summary:'Read a notice and its permitted audit events'},async request=>{
    const {context}=request;
    const item=await notice(db,context,request.params.id);
    const includeCounter=manager(context) || item.affectedId===context.accountId;
    const events=await rows(db,`SELECT event_id AS "eventId",action,revision,explanation,created_at AS "createdAt"
      FROM rights_notice_events e WHERE e.workspace_id=$1 AND e.notice_id=$2
      AND ($3::bool OR e.action<>'counter' OR EXISTS(SELECT 1 FROM rights_notice_events f
        WHERE f.workspace_id=e.workspace_id AND f.notice_id=e.notice_id AND f.action='forward-counter'))
      ORDER BY revision`,[context.workspaceId,item.id,includeCounter]);
    return {notice:view(item,context),events};
  });

  route(app,'POST',root+'/:id/actions',{tags,params:idParams,summary:'Forward, restrict, reply to or resolve a rights notice',
    body:object({eventId:uuid,revision,action:choice(...Object.keys(transitions)),explanation:text(3000)})},async request=>{
    const {context,body}=request;
    const {workspaceId,accountId}=context;
    const {eventId,action}=body;
    const explanation=nonblank(body.explanation);
    return db.transaction(async tx=>{
      const item=await notice(tx,context,request.params.id,true);
      if (action==='counter'?item.affectedId!==accountId:!manager(context)) {
        throw new ApiError(403,'FORBIDDEN','This participant cannot perform the notice action');
      }
      const prior=await row(tx,`SELECT revision,action,actor_id,explanation FROM rights_notice_events
        WHERE workspace_id=$1 AND notice_id=$2 AND event_id=$3`,[workspaceId,item.id,eventId]);
      if (prior) {
        if (prior.action!==action || prior.actor_id!==accountId || prior.explanation!==explanation
          || prior.revision!==body.revision+1) throw conflict();
        return view(item,context);
      }
      const step=transitions[action];
      if (item.revision!==body.revision || !step.from.includes(item.state)) throw conflict();
      const next=await row(tx,`UPDATE rights_notices SET state=$3,revision=revision+1,updated_at=now(),
        forwarded_at=CASE WHEN $3='forwarded' THEN now() ELSE forwarded_at END
        WHERE workspace_id=$1 AND id=$2 RETURNING ${columns}`,[workspaceId,item.id,step.to]);
      await tx.query(`INSERT INTO rights_notice_events(workspace_id,notice_id,event_id,revision,action,actor_id,explanation)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[workspaceId,item.id,eventId,next.revision,action,accountId,explanation]);
      if (action==='restrict' || action==='restore') await refreshAssetHold(tx,workspaceId,item.assetId,next.state);
      await inform(tx,workspaceId,next,action);
      return view(next,context);
    });
  });
}
