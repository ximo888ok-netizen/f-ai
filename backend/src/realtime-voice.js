import { createHash } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, bool, choice, integer, invalid, notFound, object, route, text, uuid } from './http.js';
import { isVoiceSdp, maxSdpBytes } from './realtime-provider.js';
import { finishCredits, reserveCredits } from './wallet.js';

const root = '/v1/voice/realtime';
const collection = root + '/sessions/:id';
const tags = ['Realtime voice'];
const params = object({id:uuid});
const owned = 'workspace_id=$1 AND account_id=$2 AND id=$3';
const options = {model:text(256),voice:text(64),credits:integer(1,1000000),durationSeconds:integer(10,3600)};
const session = object({
  id:uuid,state:choice('opening','active','closing','closed','failed'),...options,
  expiresAt:{type:['string','null'],format:'date-time'},errorCode:{type:['string','null']},answerSdp:text(maxSdpBytes),
}, ['id','state',...Object.keys(options),'expiresAt','errorCode']);
const responses = {200:session,201:session,202:session};
const memberKey = request => [request.context.workspaceId.toLowerCase(), request.context.accountId, request.params.id.toLowerCase()];
const creditRef = id => 'realtime:' + id;
const creditTask = record => ({...record,id:creditRef(record.id)});
const findOwned = (db,key,lock=false) => row(db,'SELECT * FROM realtime_voice_sessions WHERE ' + owned +
  (lock ? ' FOR UPDATE' : ''),key);

function view(record, withAnswer = false) {
  const expired = record.state === 'active' && new Date(record.expires_at).getTime() <= Date.now();
  const state = (record.state === 'opening' && record.close_requested) || expired ? 'closing' : record.state;
  return {id:record.id,state,model:record.model,voice:record.voice,credits:record.cost,
    durationSeconds:record.duration_seconds,expiresAt:record.expires_at,errorCode:record.error_code,
    ...(withAnswer && state === 'active' ? {answerSdp:record.answer_sdp} : {})};
}

async function reserve(db,key,offerHash,binding) {
  return db.transaction(async tx => {
    // Serialize new calls for the same member across API processes.
    await tx.query('SELECT 1 FROM wallets WHERE workspace_id=$1 AND account_id=$2 FOR UPDATE',key.slice(0,2));
    const existing = await findOwned(tx,key);
    if (existing) {
      if (existing.offer_hash !== offerHash) throw new ApiError(409,'VOICE_OFFER_CHANGED','Use the original offer for this session ID');
      return {record:existing,created:false};
    }
    if (!binding) throw new ApiError(422,'REALTIME_VOICE_UNAVAILABLE','Realtime voice is unavailable for this workspace');
    const busy = await row(tx,`SELECT 1 FROM realtime_voice_sessions WHERE workspace_id=$1 AND account_id=$2
      AND state IN ('opening','active','closing') LIMIT 1`,key.slice(0,2));
    if (busy) throw new ApiError(409,'VOICE_SESSION_BUSY','Finish the current voice session first');
    await reserveCredits(tx,key[0],key[1],creditRef(key[2]),binding.credits);
    const record = await row(tx,`INSERT INTO realtime_voice_sessions
      (workspace_id,account_id,id,offer_hash,binding_hash,model,voice,cost,duration_seconds,state,next_action_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'opening',now()+interval '45 seconds') RETURNING *`,
    [...key,offerHash,binding.fingerprint,binding.model,binding.voice,binding.credits,binding.durationSeconds]);
    return {record,created:true};
  });
}

async function finishOpening(db,key,outcome) {
  return db.transaction(async tx => {
    const record = await findOwned(tx,key,true);
    if (!record) throw notFound('Voice session');
    // Recovery may already have released the reservation. A late known call
    // still needs to be closed, without creating another ledger entry.
    const recovered = record.state === 'failed' && record.error_code === 'PROVIDER_OUTCOME_UNKNOWN';
    if (record.state !== 'opening' && !(recovered && outcome.callId)) return record;
    const active = record.state === 'opening' && !record.close_requested && Boolean(outcome.answer);
    if (record.state === 'opening') await finishCredits(tx,creditTask(record),active);
    const state = active ? 'active' : outcome.callId ? 'closing' : record.close_requested ? 'closed' : 'failed';
    return row(tx,`UPDATE realtime_voice_sessions SET state=$4,provider_call_id=$5,answer_sdp=$6,
      error_code=COALESCE($7,error_code),
      expires_at=CASE WHEN $4='active' THEN now()+duration_seconds*interval '1 second' ELSE NULL END,
      next_action_at=CASE WHEN $4='active' THEN now()+duration_seconds*interval '1 second' WHEN $4='closing' THEN now() ELSE NULL END
      WHERE ${owned} RETURNING *`,[...key,state,outcome.callId ?? null,active ? outcome.answer : null,outcome.error ?? null]);
  });
}

// Claim before contacting the provider. A process exit leaves the hangup
// retryable by another worker, including after an enterprise database cutover.
export async function maintainRealtimeVoice(db,bindings,key) {
  const hangups = await db.transaction(async tx => {
    const scope = key ? ' AND ' + owned :
      ' AND NOT EXISTS (SELECT 1 FROM workspace_database_routes r WHERE r.workspace_id=v.workspace_id)';
    const due = await rows(tx,`SELECT * FROM realtime_voice_sessions v WHERE next_action_at<=now()${scope}
      ORDER BY next_action_at,id LIMIT 8 FOR UPDATE OF v SKIP LOCKED`,key ?? []);
    const claimed = [];
    for (const record of due) {
      const owner = [record.workspace_id,record.account_id,record.id];
      if (record.state === 'opening') {
        await finishCredits(tx,creditTask(record),false);
        await tx.query(`UPDATE realtime_voice_sessions SET state='failed',error_code='PROVIDER_OUTCOME_UNKNOWN',
          next_action_at=NULL WHERE ${owned}`,owner);
      } else {
        await tx.query(`UPDATE realtime_voice_sessions SET state='closing',answer_sdp=NULL,
          next_action_at=now()+interval '20 seconds' WHERE ${owned}`,owner);
        claimed.push(record);
      }
    }
    return claimed;
  });
  const results = await Promise.allSettled(hangups.map(record=>finishHangup(db,bindings,record)));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function finishHangup(db,bindings,record) {
  const binding = bindings.get(record.workspace_id);
  const owner = [record.workspace_id,record.account_id,record.id];
  const sameProvider = binding?.fingerprint === record.binding_hash;
  let closed = false;
  if (sameProvider) {
    try { closed = await binding.hangup(record.provider_call_id); } catch { /* Retry the durable hangup. */ }
  }
  if (closed) {
    await db.query(`UPDATE realtime_voice_sessions SET state='closed',next_action_at=NULL,provider_call_id=NULL,
      error_code=CASE WHEN error_code IN ('VOICE_HANGUP_PENDING','VOICE_BINDING_CHANGED') THEN NULL ELSE error_code END
      WHERE ${owned} AND state='closing'`,owner);
  } else {
    await db.query(`UPDATE realtime_voice_sessions SET error_code=CASE WHEN error_code IS NULL OR
      error_code IN ('VOICE_HANGUP_PENDING','VOICE_BINDING_CHANGED') THEN $4 ELSE error_code END
      WHERE ${owned} AND state='closing'`,[...owner,sameProvider ? 'VOICE_HANGUP_PENDING' : 'VOICE_BINDING_CHANGED']);
  }
}

export function registerRealtimeVoice(app,db,bindings) {
  route(app,'GET',root + '/options',{tags,summary:'Read WebRTC availability and the configured session price',
    response:{200:object({available:bool,...options},['available'])}}, async request => {
    const binding = bindings.get(request.context.workspaceId.toLowerCase());
    if (!binding) return {available:false};
    const {model,voice,credits,durationSeconds} = binding;
    return {available:true,model,voice,credits,durationSeconds};
  });
  route(app,'GET',root + '/sessions/current',{tags,summary:'Find this member’s outstanding voice session after a page reload',
    response:{200:object({session:{anyOf:[session,{type:'null'}]}})}}, async request => {
    const current = await row(db,`SELECT * FROM realtime_voice_sessions WHERE workspace_id=$1 AND account_id=$2
      AND state IN ('opening','active','closing') ORDER BY created_at DESC,id LIMIT 1`,[request.context.workspaceId,request.context.accountId]);
    return {session:current ? view(current) : null};
  });
  route(app,'PUT',collection,{tags,params,summary:'Negotiate an owned WebRTC voice session using a stable client ID',
    body:object({offerSdp:text(maxSdpBytes)}),response:responses}, async (request,reply) => {
    const key = memberKey(request);
    const {offerSdp} = request.body;
    if (!isVoiceSdp(offerSdp)) throw invalid('Supply a WebRTC audio offer with ICE and DTLS');
    const offerHash = createHash('sha256').update(offerSdp).digest('hex');
    const binding = bindings.get(key[0]);
    const claim = await reserve(db,key,offerHash,binding);
    let record = claim.record;
    if (claim.created) {
      let outcome;
      try { outcome = await binding.open(offerSdp,key[1]); }
      catch (error) { outcome = {error:error.code === 'PROVIDER_REJECTED' ? error.code : 'PROVIDER_OUTCOME_UNKNOWN'}; }
      // Only retry persistence. A connection may have lost the commit reply
      // after the wallet and session were already updated.
      try { record = await finishOpening(db,key,outcome); }
      catch (error) {
        if (error instanceof ApiError) throw error;
        record = await finishOpening(db,key,outcome);
      }
      if (record.state === 'closing') {
        await maintainRealtimeVoice(db,bindings,key);
        record = await findOwned(db,key);
      }
    }
    const result = view(record,true);
    if (['opening','closing'].includes(result.state)) reply.code(202);
    else if (result.state === 'active' && claim.created) reply.code(201);
    return result;
  });
  route(app,'GET',collection,{tags,params,summary:'Read owned voice session status',response:{200:session}},async request => {
    const record = await findOwned(db,memberKey(request));
    if (!record) throw notFound('Voice session');
    return view(record);
  });
  route(app,'DELETE',collection,{tags,params,summary:'Cancel negotiation or hang up the owned voice session',
    response:{200:session,202:session}}, async (request,reply) => {
    const key = memberKey(request);
    const requested = await row(db,`UPDATE realtime_voice_sessions SET close_requested=true,
      answer_sdp=NULL,state=CASE WHEN state='active' THEN 'closing' ELSE state END,
      next_action_at=CASE WHEN state='active' THEN now() ELSE next_action_at END
      WHERE ${owned} AND state IN ('opening','active') RETURNING *`,key);
    if (requested?.state !== 'opening') await maintainRealtimeVoice(db,bindings,key);
    const record = await findOwned(db,key);
    if (!record) throw notFound('Voice session');
    const result = view(record);
    if (result.state === 'closing') reply.code(202);
    return result;
  });
}
