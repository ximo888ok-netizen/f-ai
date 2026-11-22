import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const root='/v1/agency';
const options={enterprise:true,tags:['Agency ledger']};
const manager={...options,manager:true};
const ref={...text(100),pattern:'^[A-Za-z0-9][A-Za-z0-9_.-]*$'};
const day={type:'string',format:'date'};
const minor=integer(1,1000000000);
const bps=integer(0,10000);
const revision=integer(1,2147483647);
const nullableId={anyOf:[uuid,{type:'null'}]};
const partner=object({accountId:uuid,parentId:nullableId,tier:integer(1,2)});
const rates=object({directBps:bps,managementBps:bps,revision});
const receipt=object({reference:ref,agentId:uuid,parentId:nullableId,bookedOn:day,paidMinor:minor,
  reversedMinor:integer(0,1000000000),rateRevision:revision,directBps:bps,managementBps:bps});
const reasons=choice('refund','return','chargeback');
const reversal=object({reference:ref,receiptReference:ref,bookedOn:day,amountMinor:minor,reason:reasons});
const partnerFields='account_id AS "accountId",parent_id AS "parentId",tier';
const rateFields='direct_bps AS "directBps",management_bps AS "managementBps",revision';
const receiptFields='reference,agent_id AS "agentId",parent_id AS "parentId",booked_on::text AS "bookedOn",paid_minor AS "paidMinor",'+
  'reversed_minor AS "reversedMinor",rate_revision AS "rateRevision",direct_bps AS "directBps",management_bps AS "managementBps"';
const reversalFields='reference,receipt_reference AS "receiptReference",booked_on::text AS "bookedOn",amount_minor AS "amountMinor",reason';
const conflict=message=>new ApiError(409,'AGENCY_CONFLICT',message);
const workspace=request=>request.context.workspaceId;

async function getRates(db,id,lock=false) {
  const value=await row(db,'SELECT '+rateFields+' FROM agency_rates WHERE workspace_id=$1'+(lock?' FOR SHARE':''),[id]);
  if (!value) throw notFound('Commission rate configuration');
  return value;
}

async function getReceipt(db,key,lock=false) {
  return row(db,'SELECT '+receiptFields+' FROM agency_receipts WHERE workspace_id=$1 AND reference=$2'+(lock?' FOR UPDATE':''),key);
}

function checkReceipt(value,input) {
  if (value.agentId!==input.agentId.toLowerCase() || value.paidMinor!==input.paidMinor ||
      value.bookedOn!==input.bookedOn || value.rateRevision!==input.rateRevision) throw conflict('Receipt reference already used with different data');
  return value;
}

async function recordReceipt(tx,request) {
  const {agentId,bookedOn,paidMinor,rateRevision}=request.body;
  const key=[workspace(request),request.params.reference];
  const prior=await getReceipt(tx,key);
  if (prior) return checkReceipt(prior,request.body);
  const rate=await getRates(tx,key[0],true);
  if (rate.revision!==rateRevision) throw conflict('Reload the commission rates before recording a receipt');
  const agent=await row(tx,'SELECT parent_id FROM agency_partners WHERE workspace_id=$1 AND account_id=$2',[key[0],agentId]);
  if (!agent) throw notFound('Approved agent');
  const saved=await row(tx,`INSERT INTO agency_receipts(workspace_id,reference,agent_id,parent_id,booked_on,paid_minor,
    rate_revision,direct_bps,management_bps,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT DO NOTHING RETURNING ${receiptFields}`,[...key,agentId,agent.parent_id,bookedOn,paidMinor,
    rateRevision,rate.directBps,agent.parent_id?rate.managementBps:0,request.context.accountId]);
  return saved ?? checkReceipt(await getReceipt(tx,key),request.body);
}

async function reverse(tx,request) {
  const {reference,event}=request.params;
  const key=[workspace(request),reference];
  const source=await getReceipt(tx,key,true);
  if (!source) throw notFound('Receipt');
  const {amountMinor,bookedOn,reason}=request.body;
  const find=()=>row(tx,'SELECT '+reversalFields+' FROM agency_reversals WHERE workspace_id=$1 AND reference=$2',[key[0],event]);
  function replay(value) {
    if (value.receiptReference!==reference || value.amountMinor!==amountMinor || value.bookedOn!==bookedOn || value.reason!==reason) {
      throw conflict('Reversal reference already used with different data');
    }
    return value;
  }
  const prior=await find();
  if (prior) return replay(prior);
  const before=source.paidMinor-source.reversedMinor;
  if (amountMinor>before) throw conflict('Reversal exceeds the remaining paid amount');
  const last=await row(tx,'SELECT max(booked_on)::text AS day FROM agency_reversals WHERE workspace_id=$1 AND receipt_reference=$2',key);
  if (bookedOn<(last.day ?? source.bookedOn)) throw invalid('Record receipt adjustments in accounting date order');
  const saved=await row(tx,`INSERT INTO agency_reversals(workspace_id,receipt_reference,reference,amount_minor,booked_on,reason,before_minor,recorded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING ${reversalFields}`,
    [...key,event,amountMinor,bookedOn,reason,before,request.context.accountId]);
  if (!saved) return replay(await find());
  await tx.query('UPDATE agency_receipts SET reversed_minor=reversed_minor+$3 WHERE workspace_id=$1 AND reference=$2',[...key,amountMinor]);
  return saved;
}

// Both endpoints use the same sums. Each reversal removes the difference between the two rounded entitlements.
async function statement(db,request,paged) {
  const {role,workspaceId,accountId}=request.context;
  if (role==='member' && !(await row(db,'SELECT 1 FROM agency_partners WHERE workspace_id=$1 AND account_id=$2',[workspaceId,accountId]))) {
    throw new ApiError(403,'AGENCY_REQUIRED','Approved workspace agent required');
  }
  const args=[workspaceId,request.query.month+'-01',role==='member'?accountId:null];
  if (paged) args.push(...paginate(request.query));
  return rows(db,`WITH events AS (
    SELECT agent_id,parent_id,direct_bps,management_bps,0 AS before,paid_minor AS after,false AS reversed
    FROM agency_receipts WHERE workspace_id=$1 AND booked_on>=$2::date AND booked_on<$2::date+interval '1 month'
    UNION ALL SELECT r.agent_id,r.parent_id,r.direct_bps,r.management_bps,v.before_minor,v.before_minor-v.amount_minor,true
    FROM agency_reversals v JOIN agency_receipts r ON (r.workspace_id,r.reference)=(v.workspace_id,v.receipt_reference)
    WHERE v.workspace_id=$1 AND v.booked_on>=$2::date AND v.booked_on<$2::date+interval '1 month'
  ), entries AS (
    SELECT partner,management,reversed,after::bigint*rate/10000-before::bigint*rate/10000 AS amount
    FROM events CROSS JOIN LATERAL (VALUES(agent_id,direct_bps,false),(parent_id,management_bps,true)) AS payee(partner,rate,management)
    WHERE partner IS NOT NULL AND ($3::uuid IS NULL OR partner=$3)
  ) SELECT partner AS "accountId",coalesce(sum(amount) FILTER(WHERE NOT management AND NOT reversed),0)::text AS "directMinor",
    coalesce(sum(amount) FILTER(WHERE management AND NOT reversed),0)::text AS "managementMinor",
    coalesce(sum(amount) FILTER(WHERE reversed),0)::text AS "adjustmentMinor",sum(amount)::text AS "netMinor"
    FROM entries GROUP BY partner ORDER BY partner`+(paged?' LIMIT $4 OFFSET $5':''),args);
}

export function registerAgency(app,db) {
  route(app,'GET',root+'/me',{...options,summary:'Find this member’s enterprise agent approval',
    response:{200:object({partner:{anyOf:[partner,{type:'null'}]}})}},async request=>({
      partner:await row(db,'SELECT '+partnerFields+' FROM agency_partners WHERE workspace_id=$1 AND account_id=$2',
        [workspace(request),request.context.accountId]) ?? null,
    }));
  route(app,'GET',root+'/partners',{...manager,summary:'List approved enterprise agency relationships',querystring:page,
    response:{200:object({items:array(partner,100)})}},async request=>({items:await rows(db,'SELECT '+partnerFields+
      ' FROM agency_partners WHERE workspace_id=$1 ORDER BY tier,account_id LIMIT $2 OFFSET $3',[workspace(request),...paginate(request.query)])}));
  route(app,'PUT',root+'/partners/:id',{...manager,summary:'Approve a member as a first- or second-tier agent',params:object({id:uuid}),
    body:object({parentId:nullableId}),response:{200:partner}},request=>db.transaction(async tx=>{
    const key=[workspace(request),request.params.id.toLowerCase()];
    const parent=request.body.parentId?.toLowerCase() ?? null;
    if (!(await row(tx,'SELECT 1 FROM memberships WHERE workspace_id=$1 AND account_id=$2',key))) throw notFound('Enterprise member');
    if (parent && (parent===key[1] || !(await row(tx,'SELECT 1 FROM agency_partners WHERE workspace_id=$1 AND account_id=$2 AND tier=1',[key[0],parent])))) {
      throw conflict('The parent must be a different first-tier agent in this enterprise');
    }
    const saved=await row(tx,'INSERT INTO agency_partners(workspace_id,account_id,parent_id,tier) VALUES($1,$2,$3,$4) '+
      'ON CONFLICT DO NOTHING RETURNING '+partnerFields,[...key,parent,parent?2:1]);
    if (saved) return saved;
    const current=await row(tx,'SELECT '+partnerFields+' FROM agency_partners WHERE workspace_id=$1 AND account_id=$2',key);
    if (current.parentId!==parent) throw conflict('An approved agent already has a recorded relationship');
    return current;
  }));
  route(app,'GET',root+'/rates',{...manager,summary:'Read configured agency commission rates',response:{200:rates}},r=>getRates(db,workspace(r)));
  route(app,'PUT',root+'/rates',{...manager,summary:'Set commission rates in basis points at the expected revision',
    body:object({revision:integer(0,2147483646),directBps:bps,managementBps:bps}),response:{200:rates}},async request=>{
    const {revision,directBps,managementBps}=request.body;
    if (directBps+managementBps>10000) throw invalid('Total rates exceed the payment amount');
    const args=[workspace(request),directBps,managementBps];
    const saved=revision===0
      ? await row(db,'INSERT INTO agency_rates(workspace_id,direct_bps,management_bps) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING '+rateFields,args)
      : await row(db,'UPDATE agency_rates SET direct_bps=$2,management_bps=$3,revision=revision+1 WHERE workspace_id=$1 AND revision=$4 RETURNING '+rateFields,[...args,revision]);
    if (saved) return saved;
    const current=await getRates(db,args[0]);
    if (current.revision===revision+1 && current.directBps===directBps && current.managementBps===managementBps) return current;
    throw conflict('Reload the latest rates');
  });
  const receipts=root+'/receipts/:reference';
  route(app,'GET',root+'/receipts',{...manager,summary:'List recorded enterprise receipts',querystring:page,
    response:{200:object({items:array(receipt,100)})}},async request=>({
      items:await rows(db,'SELECT '+receiptFields+' FROM agency_receipts WHERE workspace_id=$1 ORDER BY booked_on DESC,reference LIMIT $2 OFFSET $3',
        [workspace(request),...paginate(request.query)]),
    }));
  route(app,'PUT',receipts,{...manager,summary:'Record a verified CNY receipt for commission accounting',params:object({reference:ref}),
    body:object({agentId:uuid,bookedOn:day,paidMinor:minor,rateRevision:revision}),response:{200:receipt}},
    request=>db.transaction(tx=>recordReceipt(tx,request)));
  route(app,'GET',receipts,{...manager,summary:'Read recorded receipt and cumulative adjustments',params:object({reference:ref}),
    response:{200:receipt}},async request=>{
    const value=await getReceipt(db,[workspace(request),request.params.reference]);
    if (!value) throw notFound('Receipt');
    return value;
  });
  route(app,'PUT',receipts+'/reversals/:event',{...manager,summary:'Record an evidenced refund, return or chargeback',
    params:object({reference:ref,event:ref}),body:object({amountMinor:minor,bookedOn:day,reason:reasons}),response:{200:reversal}},
    request=>db.transaction(tx=>reverse(tx,request)));
  route(app,'GET',receipts+'/reversals',{...manager,summary:'Audit individual adjustments to a recorded receipt',
    params:object({reference:ref}),querystring:page,response:{200:object({items:array(reversal,100)})}},async request=>{
    const key=[workspace(request),request.params.reference];
    if (!(await getReceipt(db,key))) throw notFound('Receipt');
    return {items:await rows(db,'SELECT '+reversalFields+' FROM agency_reversals WHERE workspace_id=$1 AND receipt_reference=$2 '+
      'ORDER BY booked_on DESC,reference LIMIT $3 OFFSET $4',[...key,...paginate(request.query)])};
  });
  const month={type:'string',pattern:'^[1-9][0-9]{3}-(0[1-9]|1[0-2])$'};
  const amount={type:'string',pattern:'^-?[0-9]+$'};
  const line=object({accountId:uuid,directMinor:amount,managementMinor:amount,adjustmentMinor:amount,netMinor:amount});
  route(app,'GET',root+'/statements',{...options,summary:'Read monthly agency totals in CNY minor units',
    querystring:object({month,...page.properties},['month']),response:{200:object({month,items:array(line,100)})}},
    async request=>({month:request.query.month,items:await statement(db,request,true)}));
  route(app,'GET',root+'/statements/export',{...options,summary:'Download the full authorized monthly agency statement',
    querystring:object({month}),produces:['text/csv']},async (request,reply)=>{
      const items=await statement(db,request,false);
      const lines=items.map(i=>[i.accountId,i.directMinor,i.managementMinor,i.adjustmentMinor,i.netMinor].join(','));
      return reply.header('content-disposition','attachment; filename="agency-'+request.query.month+'.csv"').type('text/csv; charset=utf-8')
        .send(Buffer.from('\uFEFF代理成员,直佣（分）,管理佣金（分）,冲减（分）,应计净额（分）\r\n'+lines.map(l=>l+'\r\n').join('')));
    });
}
