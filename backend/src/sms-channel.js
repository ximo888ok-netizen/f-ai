import { createHash, randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const root='/v1/channels/sms';
const options={manager:true,tags:['SMS notifications']};
const alias={...text(40),pattern:'^[a-z][a-z0-9_-]{0,39}$'};
const stamp={type:'string',format:'date-time'};
const record=object({id:uuid,template:alias,maskedRecipient:text(16),state:choice('queued','sending','accepted','failed','uncertain'),
  attempts:integer(0,3),providerReference:{type:['string','null']},errorCode:{type:['string','null']},createdAt:stamp,updatedAt:stamp});
const fields='id,template,masked_recipient AS "maskedRecipient",state,attempts,provider_reference AS "providerReference",'+
  'error_code AS "errorCode",created_at AS "createdAt",updated_at AS "updatedAt"';

export function registerSmsChannel(app,db,sms) {
  route(app,'GET',root+'/options',{...options,summary:'List enabled SMS template aliases and parameter counts',
    response:{200:object({templates:array(object({alias,params:integer(0,12)}),200)})}},async request=>({
      templates:Array.from(sms.get(request.context.workspaceId.toLowerCase()) ?? [],([alias,{params}])=>({alias,params})),
    }));
  route(app,'GET',root+'/messages',{...options,querystring:page,summary:'List masked workspace SMS submissions',
    response:{200:object({items:array(record,100)})}},async request=>({items:await rows(db,'SELECT '+fields+
      ' FROM sms_messages WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',[request.context.workspaceId,...paginate(request.query)])}));
  const path=root+'/messages/:id';
  const params=object({id:uuid});
  route(app,'GET',path,{...options,params,summary:'Read SMS submission status and provider reference',response:{200:record}},async request=>{
    const message=await row(db,'SELECT '+fields+' FROM sms_messages WHERE workspace_id=$1 AND id=$2',[request.context.workspaceId,request.params.id]);
    if (!message) throw notFound('SMS message');
    return message;
  });
  route(app,'PUT',path,{...options,params,summary:'Queue a single template SMS with a client-assigned request ID',
    body:object({recipient:{...text(16),pattern:'^\\+[1-9][0-9]{6,14}$'},template:alias,values:array(text(128),12)}),
    response:{200:record,202:record}},async (request,reply)=>{
    const {workspaceId,accountId}=request.context;
    const {template,recipient,values}=request.body;
    const key=[workspaceId,request.params.id];
    const hash=createHash('sha256').update(JSON.stringify([accountId,template,recipient,values])).digest('hex');
    const prior=async ()=>{
      const existing=await row(db,'SELECT '+fields+',request_hash FROM sms_messages WHERE workspace_id=$1 AND id=$2',key);
      if (!existing) return null;
      const {request_hash,...message}=existing;
      if (request_hash!==hash) throw new ApiError(409,'SMS_ID_CONFLICT','Message ID already belongs to another request');
      return message;
    };
    const replay=await prior();
    if (replay) return replay;
    const binding=sms.get(workspaceId.toLowerCase())?.get(template);
    if (!binding) throw new ApiError(422,'SMS_TEMPLATE_UNAVAILABLE','Select a configured SMS template');
    if (values.length!==binding.params || values.some(v=>!v.trim())) throw invalid('Supply the configured template parameters');
    const inserted=await row(db,`INSERT INTO sms_messages(workspace_id,id,account_id,template,masked_recipient,payload,request_hash,binding_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING ${fields}`,
      [...key,accountId,template,'***'+recipient.slice(-4),{recipient,values},hash,binding.fingerprint]);
    if (!inserted) return prior();
    reply.code(202);
    return inserted;
  });
}

async function claim(db) {
  return db.transaction(async tx=>{
    const message=await row(tx,`SELECT * FROM sms_messages q WHERE ((q.state='queued' AND q.available_at<=now())
      OR (q.state='sending' AND q.lease_until<=now())) AND NOT EXISTS (
        SELECT 1 FROM workspace_database_routes r WHERE r.workspace_id=q.workspace_id)
      ORDER BY q.available_at,q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED`);
    if (!message) return null;
    const key=[message.workspace_id,message.id];
    // Tencent's SessionContext is a correlation ID, not a provider-side deduplication key.
    if (message.state==='sending') {
      await tx.query(`UPDATE sms_messages SET state='uncertain',error_code='SMS_ACCEPTANCE_UNKNOWN',payload=NULL,
        lease_id=NULL,lease_until=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2`,key);
      return {expired:true};
    }
    const lease=randomUUID();
    await tx.query(`UPDATE sms_messages SET lease_id=$3,lease_until=now()+interval '45 seconds',state='sending',
      attempts=attempts+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[...key,lease]);
    return {...message,attempts:message.attempts+1,lease};
  });
}

export async function dispatchSms({db,sms,identityDb=db}) {
  const message=await claim(db);
  if (!message || message.expired) return Boolean(message);
  let result;
  const binding=sms.get(message.workspace_id)?.get(message.template);
  if (binding?.fingerprint!==message.binding_hash) result={state:'failed',code:'SMS_BINDING_CHANGED'};
  else {
    // Identity lookup can be retried safely until a provider request has started.
    let member;
    try {member=await row(identityDb,'SELECT role FROM memberships WHERE workspace_id=$1 AND account_id=$2',[message.workspace_id,message.account_id]);}
    catch {result={state:'retry',code:'SMS_IDENTITY_UNAVAILABLE'};}
    if (!result) {
      if (!member || member.role==='member') result={state:'failed',code:'SMS_PERMISSION_CHANGED'};
      else result=await binding.send(message.id,message.payload);
    }
  }
  const state=result.state==='retry' ? (message.attempts<3?'queued':'failed') : result.state;
  await db.query(`UPDATE sms_messages SET state=$4,error_code=$5,provider_reference=$6,updated_at=now(),
    lease_id=NULL,lease_until=NULL,available_at=now()+$7::integer*interval '1 second',
    payload=CASE WHEN $4='queued' THEN payload ELSE NULL END WHERE workspace_id=$1 AND id=$2 AND lease_id=$3`,
    [message.workspace_id,message.id,message.lease,state,result.code ?? null,result.reference ?? null,Math.max(30*message.attempts,result.delay ?? 0)]);
  return true;
}
