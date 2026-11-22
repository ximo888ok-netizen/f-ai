import { rows } from './db.js';
import { array, choice, invalid, object, route, uuid } from './http.js';

const tags=['Studio Operations'];
const root='/v1/studio/pinduoduo/books/:book/report';
const day={type:'string',format:'date'};
const period=choice('day','week','month');
const querystring=object({from:day,to:day,period});
const numberString={type:'string',pattern:'^[0-9]+$'};
const nullable=value=>({anyOf:[value,{type:'null'}]});
const channelNames=['搜索','推荐','活动','其他'];
const trafficColumns=channelNames.map((_,index)=>{
  const parameter='$'+(index+5);
  return `${parameter}::text,(sum((details->>'views')::bigint) FILTER (WHERE kind='traffic' AND details->>'channel'=${parameter}))::text`;
}).join(',');
const fields={
  start:day, orders:nullable(numberString),units:nullable(numberString),paidOrders:nullable(numberString),
  paidMinor:nullable(numberString),views:nullable(numberString),visitors:nullable(numberString),buyers:nullable(numberString),
  salesMinor:nullable(numberString),conversionPercent:nullable({type:'number'}),traffic:object(Object.fromEntries(
    channelNames.map(label=>[label,nullable(numberString)]))),updatedAt:{type:'string',format:'date-time'},
};
const params=object({book:uuid});
const options={manager:true,tags,params,querystring};

async function report(db,book,{from,to,period}) {
  const span=(Date.parse(to)-Date.parse(from))/86400000;
  if (span<0 || span>365) throw invalid('Select a range of 1 to 366 calendar days');
  const records=await rows(db,`WITH sample AS (
    SELECT date_trunc($4::text,(details->>'day')::date::timestamp)::date AS bucket,kind,details,updated_at
    FROM operation_records WHERE book_id=$1 AND kind IN ('orders','performance','traffic')
      AND details->>'day' BETWEEN $2 AND $3
  ) SELECT bucket::text AS start,
    CASE WHEN count(*) FILTER (WHERE kind='orders')>0 THEN (count(*) FILTER (WHERE kind='orders' AND details->>'status'<>'已取消'))::text END AS orders,
    CASE WHEN count(*) FILTER (WHERE kind='orders')>0 THEN coalesce(sum((details->>'units')::bigint) FILTER (WHERE kind='orders' AND details->>'status'<>'已取消'),0)::text END AS units,
    CASE WHEN count(*) FILTER (WHERE kind='orders')>0 THEN (count(details->>'paidMinor') FILTER (WHERE kind='orders' AND details->>'status'<>'已取消'))::text END AS "paidOrders",
    (sum((details->>'paidMinor')::bigint) FILTER (WHERE kind='orders' AND details->>'status'<>'已取消'))::text AS "paidMinor",
    (sum((details->>'views')::bigint) FILTER (WHERE kind='performance'))::text AS views,
    sum((details->>'visitors')::bigint)::text AS visitors,sum((details->>'buyers')::bigint)::text AS buyers,
    sum((details->>'salesMinor')::bigint)::text AS "salesMinor",
    round(sum((details->>'buyers')::bigint)*100/nullif(sum((details->>'visitors')::bigint),0),2)::float8 AS "conversionPercent",
    jsonb_build_object(${trafficColumns}) AS traffic,
    max(updated_at) AS "updatedAt" FROM sample GROUP BY bucket ORDER BY bucket`,[book,from,to,period,...channelNames]);
  return {source:'local-ledger',timezone:'Asia/Shanghai',period,from,to,items:records};
}

export function registerLedgerReport(app,db,requireBook) {
  const load=async request=>report(db,await requireBook(db,request),request.query);
  route(app,'GET',root,{...options,summary:'Aggregate recorded orders, SKU performance and traffic by calendar period',
    response:{200:object({source:choice('local-ledger'),timezone:choice('Asia/Shanghai'),period,from:day,to:day,items:array(object(fields),366)})}},load);
  route(app,'GET',root+'/export',{...options,summary:'Export the complete selected ledger report as UTF-8 CSV',produces:['text/csv']},
    async (request,reply)=>{
      const {from,to,period,items}=await load(request);
      const lines=[['区间开始','有效订单数','件数','已填实付订单数','已填实付合计（分）','SKU浏览次数','SKU访客人次','SKU买家人次',
        'SKU成交金额（分）','SKU支付转化率（%）',...channelNames.map(label=>label+'浏览次数'),'最近录入时间（UTC）']];
      for (const item of items) lines.push([item.start,item.orders,item.units,item.paidOrders,item.paidMinor,item.views,item.visitors,
        item.buyers,item.salesMinor,item.conversionPercent,...channelNames.map(label=>item.traffic[label]),new Date(item.updatedAt).toISOString()]);
      return reply.header('content-disposition','attachment; filename="ledger-'+from+'-'+to+'-'+period+'.csv"')
        .type('text/csv; charset=utf-8').send(Buffer.from('\uFEFF'+lines.map(line=>line.join(',')).join('\r\n')+'\r\n'));
    });
}
