import { connectionEnabled, requireConnection } from './merchant-connections.js';
import { randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, array, bool, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { connectorPattern, eventPattern } from './feishu.js';
import { ProviderError } from './model-http.js';

const root='/v1/channels/feishu';
const options={tags:['Feishu'],manager:true};
const connector={...text(40),pattern:connectorPattern};
const eventId={...text(128),pattern:eventPattern};
const params=object({connector,eventId});
const stamp={type:'string',format:'date-time'};
const nullableText={type:['string','null']};
const replyRecord=object({id:uuid,content:text(4000),state:choice('queued','sending','sent','failed','uncertain'),
  attempts:integer(0,3),remoteMessageId:nullableText,errorCode:nullableText,createdAt:stamp});
const details=object({connector,eventId,content:text(4000),peer:text(128),createdAt:stamp});
const inboxFields='connector_id AS connector,event_id AS "eventId",content,chat_id AS peer,created_at AS "createdAt"';
const replyFields='id,content,state,attempts,remote_message_id AS "remoteMessageId",error_code AS "errorCode",created_at AS "createdAt"';
const parentKey=request=>[request.context.workspaceId,request.params.connector,request.params.eventId];

async function lookup(db,key) {
  const received=await row(db,'SELECT * FROM feishu_messages WHERE workspace_id=$1 AND connector_id=$2 AND event_id=$3',key);
  if (!received) throw notFound('Feishu message');
  return received;
}

export function registerFeishuChannel(app,db,bindings) {
  app.register(async api=>{
    api.removeContentTypeParser('application/json');
    api.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,callback)=>callback(null,body));
    api.post(root+'/:connector/events',{bodyLimit:65536,schema:{hide:true,params:object({connector})}},async request=>{
      const binding=bindings.get(request.params.connector);
      if (!binding) throw notFound('Feishu connector');
      const message=binding.verify(request.headers,request.body);
      if (!message) return {};
      if (Object.hasOwn(message,'challenge')) return message;
      const tenantDb=await app.workspaceDatabaseRouter.forWorkspace(binding.workspaceId);
      if (!await connectionEnabled(tenantDb,binding.workspaceId,'feishu',binding.id)) return { code: 0 };
      const owner=await row(tenantDb,'SELECT id FROM workspaces WHERE id=$1',[binding.workspaceId]);
      if (!owner) throw notFound('Workspace');
      await tenantDb.query(`INSERT INTO feishu_messages(workspace_id,connector_id,event_id,binding_hash,chat_id,remote_message_id,content)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [binding.workspaceId,binding.id,message.eventId,binding.fingerprint,message.chatId,message.remoteMessageId,message.content]);
      return {};
    });
  });

  route(app,'GET',root,{...options,summary:'List authenticated Feishu inbox messages',querystring:page,
    response:{200:object({available:bool,items:array(details,100)})}},async request=>{
    const {workspaceId}=request.context;
    const binding = [...bindings.values()].find(item=>item.workspaceId===workspaceId.toLowerCase());
    return {available:Boolean(binding && await connectionEnabled(db,workspaceId,'feishu',binding.id)),
      items:await rows(db,`SELECT ${inboxFields} FROM feishu_messages WHERE workspace_id=$1
        ORDER BY created_at DESC,event_id LIMIT $2 OFFSET $3`,[workspaceId,...paginate(request.query)])};
  });

  route(app,'GET',root+'/:connector/inbox/:eventId',{...options,params,querystring:page,summary:'Open an inbox message and its reply statuses',
    response:{200:object({message:details,items:array(replyRecord,100)})}},async request=>{
    const key=parentKey(request);
    const message=await row(db,'SELECT '+inboxFields+' FROM feishu_messages WHERE workspace_id=$1 AND connector_id=$2 AND event_id=$3',key);
    if (!message) throw notFound('Feishu message');
    return {message,items:await rows(db,`SELECT ${replyFields} FROM feishu_replies WHERE workspace_id=$1 AND connector_id=$2 AND event_id=$3
      ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,[...key,...paginate(request.query)])};
  });

  route(app,'PUT',root+'/:connector/inbox/:eventId/replies/:id',{
    ...options,params:object({...params.properties,id:uuid}),summary:'Queue an explicit operator reply with an idempotency ID',
    body:object({content:text(4000),confirmed:{type:'boolean',const:true}}),
    response:{200:replyRecord},
  },async request=>{
    const [workspace,id,event]=parentKey(request);
    const {accountId}=request.context;
    const received=await lookup(db,[workspace,id,event]);
    await requireConnection(db, workspace, 'feishu', id);
    const binding=bindings.get(id);
    if (!binding || binding.fingerprint!==received.binding_hash || binding.workspaceId!==workspace.toLowerCase()) {
      throw new ApiError(409,'FEISHU_BINDING_CHANGED','The corresponding Feishu connector is unavailable');
    }
    const content=request.body.content.trim();
    if (!content) throw invalid('Enter the reply text');
    const key=[workspace,request.params.id];
    const created=await row(db,`INSERT INTO feishu_replies(workspace_id,id,account_id,connector_id,event_id,content,state)
      VALUES($1,$2,$3,$4,$5,$6,'queued') ON CONFLICT DO NOTHING RETURNING ${replyFields}`,
    [...key,accountId,id,event,content]);
    if (created) return created;
    const existing=await row(db,`SELECT ${replyFields} FROM feishu_replies WHERE workspace_id=$1 AND id=$2
      AND account_id=$3 AND connector_id=$4 AND event_id=$5 AND content=$6`,[...key,accountId,id,event,content]);
    if (existing) return existing;
    throw new ApiError(409,'FEISHU_REPLY_CONFLICT','This reply ID already belongs to another submission');
  });
}

const attemptsMax=3;
const dedupWindow=30*60*1000;

async function claimReply(db) {
  return db.transaction(async tx=>{
    const next=await row(tx,`SELECT q.*,m.chat_id,m.binding_hash FROM feishu_replies q
      JOIN feishu_messages m ON m.workspace_id=q.workspace_id AND m.connector_id=q.connector_id AND m.event_id=q.event_id
      WHERE ((q.state='queued' AND q.available_at<=now()) OR (q.state='sending' AND q.lease_until<=now()))
        AND NOT EXISTS (SELECT 1 FROM workspace_database_routes r WHERE r.workspace_id=q.workspace_id)
      ORDER BY q.available_at,q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED`);
    if (!next) return null;
    const key=[next.workspace_id,next.id];
    if (next.attempts>=attemptsMax || (next.first_attempt_at && Date.now()-Date.parse(next.first_attempt_at)>=dedupWindow)) {
      await tx.query(`UPDATE feishu_replies SET state='uncertain',error_code='FEISHU_RETRY_WINDOW_CLOSED',lease_id=NULL,lease_until=NULL
        WHERE workspace_id=$1 AND id=$2`,key);
      return {expired:true};
    }
    const lease=randomUUID();
    await tx.query(`UPDATE feishu_replies SET state='sending',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,now()),
      lease_id=$3,lease_until=now()+interval '45 seconds' WHERE workspace_id=$1 AND id=$2`,[...key,lease]);
    return {...next,lease,attempts:next.attempts+1};
  });
}

export async function dispatchFeishuReply({db,feishu,identityDb=db}) {
  const task=await claimReply(db);
  if (!task || task.expired) return Boolean(task);
  let remoteId=null;
  let errorCode=null;
  let state='sent';
  try {
    const account=await row(identityDb,'SELECT role FROM memberships WHERE workspace_id=$1 AND account_id=$2 AND state=\'active\'',
      [task.workspace_id,task.account_id]);
    if (!account || account.role==='member') throw new ProviderError('FEISHU_PERMISSION_CHANGED');
    if (!await connectionEnabled(db,task.workspace_id,'feishu',task.connector_id)) throw new ProviderError('CONNECTION_DISABLED');
    const binding=feishu.get(task.connector_id);
    if (!binding || binding.workspaceId!==task.workspace_id || binding.fingerprint!==task.binding_hash) {
      throw new ProviderError('FEISHU_BINDING_CHANGED');
    }
    remoteId=await binding.send(task.chat_id,task.content,task.id);
  } catch (error) {
    const retry=!(error instanceof ProviderError) || error.retryable;
    errorCode=error instanceof ProviderError ? error.code : 'FEISHU_SEND_UNCONFIRMED';
    state=retry && task.attempts<attemptsMax ? 'queued' : (retry || task.attempts>1 ? 'uncertain' : 'failed');
  }
  await db.query(`UPDATE feishu_replies SET state=$4,error_code=$5,remote_message_id=$6,
    lease_id=NULL,lease_until=NULL,available_at=now()+interval '10 seconds' WHERE workspace_id=$1 AND id=$2 AND lease_id=$3`,
  [task.workspace_id,task.id,task.lease,state,errorCode,remoteId]);
  return true;
}
