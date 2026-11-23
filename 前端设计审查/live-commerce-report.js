import { action, field, form, h, heading, input, item, link, list, notice, panel, path, select } from './live-ui.js';

const periods={day:'日',week:'周',month:'月'};
function bucket(day,period) {
  if(period==='month')return day.slice(0,7);
  if(period==='day')return day;
  const start=new Date(day+'T00:00:00Z');
  start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);
  return start.toISOString().slice(0,10);
}
export function groupOrders(days,period) {
  const groups=new Map();
  for(const d of days){
    const key=bucket(d.day,period);
    const group=groups.get(key)??{period:key,orders:0,known:0,units:0n,paid:0n};
    group.orders+=d.orders;group.known+=d.withAmount;group.units+=BigInt(d.units??0);group.paid+=BigInt(d.paidMinor??0);
    groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>b.period.localeCompare(a.period));
}
const currency=minor=>(minor/100n).toString()+'.'+(minor%100n).toString().padStart(2,'0');
export async function commerceReport(ctx,book,queryText) {
  const values=new URLSearchParams(queryText?decodeURIComponent(queryText):'');
  const period=Object.hasOwn(periods,values.get('period'))?values.get('period'):'week';
  const range=new URLSearchParams();
  for(const k of ['from','to'])if(values.get(k))range.set(k,values.get(k));
  const days=await ctx.all('/v1/studio/pinduoduo/books/'+path(book.id)+'/analytics?'+range);
  const rows=groupOrders(days,period);
  ctx.html(heading('订单经营报表',book.name+' · 本台账非取消订单')+link('返回运营总览','commerce/'+book.id)+
    panel('统计范围',form('report-range',field('汇总周期',select('period',Object.entries(periods),period))+
      ['from','to'].map((k,i)=>field(i?'结束日期':'开始日期',input(k,'type="date" value="'+h(range.get(k))+'"'))).join(''),'查询'))+
    panel('按'+periods[period]+'汇总',(period==='week'?notice('周从周一开始，跨周查询仅统计所选日期。'):'')+
      list(rows,r=>item(r.period,r.orders+' 笔订单 · '+r.units+' 件 · '+r.known+' 笔有金额 · 已知实付 '+(r.known?'¥'+currency(r.paid):'暂无')))+
      (rows.length?action('导出当前报表 CSV','report-csv'):'')));
  ctx.submit('report-range',async data=>{
    if(data.get('from')&&data.get('to')&&data.get('from')>data.get('to'))throw new Error('开始日期不能晚于结束日期。');
    ctx.go('commerce/'+book.id+'/report/'+path(new URLSearchParams(data).toString()));
  });
  ctx.click('report-csv',()=>{
    const lines=[['期间','非取消订单','件数','有实付金额的订单','已知实付（元）'],...rows.map(r=>[r.period,r.orders,String(r.units),r.known,r.known?currency(r.paid):''])];
    const url=URL.createObjectURL(new Blob(['\uFEFF'+lines.map(r=>r.join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='订单经营'+periods[period]+'报.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
  });
}
