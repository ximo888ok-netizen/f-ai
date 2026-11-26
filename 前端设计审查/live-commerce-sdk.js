import { field, form, h, input, notice, select } from './live-ui.js';
import { blankResult, integrationStatus, paneTitle } from './live-agent-integrations.js';
import { platformNames, rememberedShop, rememberShop } from './desk-shops.js';
import { describeError } from './studio-errors.js';
import { studioIcon } from './studio-icons.js';

const names={get_order_list:'订单列表',get_order_detail:'订单详情',get_increment_orders:'增量订单',get_refund_list:'退款列表',get_refund_detail:'退款详情',
  get_shop_info:'店铺资料',get_account_balance:'账户余额',get_advertiser_info:'广告主信息',get_aftersale_list:'售后列表',get_aftersale_refund_detail:'售后退款详情'};
const money=n=>n==null?'未知':new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(n/100);
const metrics=entries=>'<dl class="report-metrics">'+entries.map(([label,value])=>'<div><dt>'+h(label)+'</dt><dd>'+h(value)+'</dd></div>').join('')+'</dl>';
const details=data=>'<details class="scene-fold"><summary>查看完整返回数据</summary><pre class="live-result">'+h(JSON.stringify(data,null,2))+'</pre></details>';
const shopButton='<button type="button" class="primary" data-open-shops>登录与管理店铺</button>';

function reportForm(box,ctx) {
  box.innerHTML='<div class="scene-split"><section class="scene-editor">'+paneTitle('tasks','导入经营数据')+
    form('commerce-report-file','<label class="report-drop">'+studioIcon('data')+'<strong>选择经营数据文件</strong><small>Core 日报 JSON · 最大 512 KiB</small>'+input('source','type="file" accept=".json,application/json" required')+'</label>'+
    '<p class="scene-hint">按上海时区汇总。文件需包含 date、shops 和订单、退款的覆盖范围。</p>','生成文件日报')+
    '</section><section class="scene-output">'+paneTitle('operations','日报预览')+'<div data-import-report role="status">'+blankResult('operations','等待导入日报','有完整覆盖记录的日期才会统计金额和订单数。')+'</div></section></div>';
  ctx.submit('commerce-report-file',async f=>{
    const target=box.querySelector('[data-import-report]');
    target.textContent='正在汇总…';
    try{
      const file=f.get('source');
      if(!file?.size||file.size>512*1024)throw new Error('请选择 512 KiB 以内的 JSON 文件。');
      const {date,shops}=JSON.parse((await file.text()).replace(/^\uFEFF/,''));
      const r=await ctx.api('/v1/integrations/mcp-cn-commerce/report',{method:'POST',body:{date,shops}});
      if(!ctx.active())return;
      target.innerHTML='<p>'+h(r.date)+' · '+r.shops.length+' 家店铺 · '+(r.complete?'覆盖完整':'覆盖不完整')+'</p>'+
        (r.shops.length>1?field('查看范围',select('reportShop',[['','所有导入店铺'],...r.shops.map((s,i)=>[String(i),s.shop_name])])):'')+
        '<div data-metrics></div>'+details(r);
      const chooser=target.querySelector('[name=reportShop]');
      const paint=()=>{
        const one=chooser?.value?r.shops[Number(chooser.value)]:null, m=one?one.summary:r.total_summary;
        const previous=one?one.yesterday:r.yesterday_summary;
        const compare=previous?.gmv!=null && m.gmv!=null?'<p class="scene-hint">较昨日支付金额 '+(m.gmv>=previous.gmv?'+':'')+h(money(m.gmv-previous.gmv))+'</p>':'';
        const entries=one?[one]:r.shops, max=Math.max(0,...entries.map(s=>s.summary.gmv??0));
        const breakdown='<div class="shop-breakdown"><h3>分店支付金额</h3>'+entries.map(s=>'<div><span>'+h(s.shop_name)+'</span><span>'+h(money(s.summary.gmv))+'</span>'+
          (max>0 && s.summary.gmv!=null?'<progress aria-label="'+h(s.shop_name)+'支付金额占最高值的比例" value="'+h(s.summary.gmv)+'" max="'+h(max)+'"></progress>':'')+'</div>').join('')+'</div>';
        target.querySelector('[data-metrics]').innerHTML=metrics([['支付金额',money(m.gmv)],['支付订单',m.order_count??'未知'],['退款金额',money(m.refund_amount)],['退款笔数',m.refund_count??'未知']])+compare+breakdown;};
      paint();if(chooser)chooser.onchange=paint;
    }catch(err){if(ctx.active())target.textContent=describeError(err);}
  });
}

function resultTable(data){
  const objects=[data];
  let records, index=0;
  while(index<objects.length && index<100){
    const item=objects[index++];
    if(Array.isArray(item) && item.length && item.every(v=>v && typeof v==='object' && !Array.isArray(v))){records=item;break;}
    if(item && typeof item==='object')objects.push(...Object.values(item).filter(v=>v && typeof v==='object').slice(0,40));
  }
  if(!records && data && typeof data==='object')records=[data];
  const keys=Object.keys(records?.[0]??{}).filter(k=>records[0][k]!=null && typeof records[0][k]!=='object').slice(0,6);
  if(!keys.length)return notice('平台返回已收到，可展开查看完整记录。')+details(data);
  const labels={tid:'交易号',order_id:'订单号',orderId:'订单号',payment:'实付金额',status:'状态',created:'创建时间',pay_time:'支付时间',shop_name:'店铺名',total_results:'记录数'};
  return '<div class="scene-table-scroll"><table><thead><tr>'+keys.map(k=>'<th>'+h(labels[k]||k)+'</th>').join('')+'</tr></thead><tbody>'+
    records.slice(0,50).map(row=>'<tr>'+keys.map(k=>'<td>'+h(row[k]??'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'+details(data);
}
export async function bindCommerceSdk(ctx,directory) {
  const query=document.querySelector('[data-commerce-query-pane]');
  const loaded=await integrationStatus(ctx,'mcp-cn-commerce');
  if(!loaded){if(ctx.active()&&query)query.textContent='无法读取经营查询状态。';return;}
  const {box,state}=loaded;
  if(state.state!=='ready'){box.textContent=query.textContent='经营 SDK 尚未就绪，请检查部署配置。';return;}
  reportForm(box,ctx);
  const shops=directory.items, options=state.operations;
  const catalogue='<details class="scene-fold"><summary>平台与可查询的数据</summary><dl class="operation-catalog">'+Object.entries(options).map(([p,ops])=>
    '<div><dt>'+h(platformNames[p])+'</dt><dd>'+h(ops.map(op=>names[op]??op).join('、')||'当前版本无可用查询')+'</dd></div>').join('')+'</dl></details>';
  query.innerHTML='<div class="scene-split"><section class="scene-editor">'+paneTitle('desk','店铺与查询')+
    (shops.length?'<form class="live-form" data-form="commerce-query">'+field('当前店铺',select('shopId',shops.map(s=>[s.id,s.name+' · '+platformNames[s.platform]]),rememberedShop(ctx,shops)||shops[0].id))+
      field('查询内容','<select name="operation"></select>')+'<div data-business-fields></div><details class="scene-fold"><summary>高级业务参数</summary>'+
      field('平台 JSON 参数','<textarea name="params" rows="3" maxlength="16000">{}</textarea>')+'</details><p data-query-state class="scene-hint"></p><button type="submit" class="primary">查询店铺数据</button></form>'+
      '<button type="button" class="shop-external" data-open-shops>店铺登录与管理</button>':
      '<div class="shop-onboarding"><strong>接入第一家店铺</strong><p>添加店铺并完成经营授权后，可以按店铺读取订单、退款和售后资料。</p>'+shopButton+'</div>')+catalogue+
    '</section><section class="scene-output">'+paneTitle('operations','经营数据')+'<div data-query-result role="status">'+
      (shops.length?blankResult('operations','等待店铺数据','选择已授权店铺和查询内容后，结果将在这里显示。'):
        '<div class="ops-source-state">'+metrics([['已登记店铺',shops.length],['经营数据授权',shops.filter(s=>s.commerce).length]])+
        '<div class="scene-void">'+studioIcon('tasks')+'<h3>已有经营数据文件？</h3><p>导入订单与退款数据，按店铺查看支付金额和日报。</p><button type="button" class="plain" data-open-report>导入经营日报</button></div></div>')+'</div></section></div>';
  query.querySelector('[data-open-shops]').onclick=()=>document.getElementById('scene-operations-shops-tab').click();
  const reportJump=query.querySelector('[data-open-report]');
  if(reportJump)reportJump.onclick=()=>document.getElementById('scene-operations-report-tab').click();
  if(!shops.length)return;
  const fields=query.querySelector('form').elements, out=query.querySelector('[data-query-result]');
  const shop=()=>shops.find(s=>s.id===fields.shopId.value);
  function changeOp(){
    const s=shop(),op=fields.operation.value;
    const business=query.querySelector('[data-business-fields]');
    const paging=(s.platform==='taobao' || s.platform==='doudian') && op==='get_order_list';
    business.innerHTML=paging?'<div class="scene-pair">'+field('页码',input('page','type="number" min="'+(s.platform==='doudian'?0:1)+'" value="'+(s.platform==='doudian'?0:1)+'" required'))+field('每页数量',input('size','type="number" min="1" max="100" value="20" required'))+'</div>':'';
    let base={};
    if(s.platform==='taobao' && ['get_order_list','get_order_detail'].includes(op))base={fields:'tid,status,payment,created,pay_time'};
    if(s.platform==='taobao' && op==='get_refund_detail')base={fields:'refund_id,tid,status,refund_fee'};
    if(s.platform==='taobao' && op==='get_order_list')business.insertAdjacentHTML('beforeend','<div class="scene-pair">'+field('下单开始日期',input('since','type="date"'))+field('结束日期',input('until','type="date"'))+'</div>');
    if(s.platform==='taobao' && ['get_order_detail','get_refund_detail'].includes(op))business.innerHTML=field(op==='get_order_detail'?'交易编号':'退款编号',input('reference','required maxlength="64" inputmode="numeric" pattern="[0-9]+"'));
    fields.params.value=JSON.stringify(base,null,2);
    out.innerHTML=blankResult('operations','等待查询','结果仅属于当前选择的店铺。');
  }
  function changeShop(){
    const s=shop(),ops=options[s.platform]??[];
    fields.operation.replaceChildren(...ops.map(op=>new Option(names[op]??op,op)));
    query.querySelector('button[type=submit]').disabled=!s.enabled||!s.commerce||!ops.length;
    query.querySelector('[data-query-state]').textContent=!s.enabled?'店铺已停用。':!ops.length?'当前版本没有此平台的在线经营查询。':!s.commerce?'尚无有效经营授权。':'店铺授权已配置 · 每次查询返回一页数据';
    changeOp();
  }
  fields.shopId.onchange=()=>{rememberShop(ctx,fields.shopId.value);changeShop();};fields.operation.onchange=changeOp;changeShop();
  ctx.submit('commerce-query',async f=>{
    const id=f.get('shopId'),op=f.get('operation');fields.shopId.disabled=fields.operation.disabled=true;
    try{
      const params=JSON.parse(f.get('params'));
      if(!params||Array.isArray(params)||typeof params!=='object')throw new Error('高级业务参数需要是 JSON 对象。');
      if(f.has('page'))Object.assign(params,shop().platform==='taobao'?{page_no:Number(f.get('page')),page_size:Number(f.get('size'))}:{page:Number(f.get('page')),size:Number(f.get('size'))});
      if(f.get('since') && f.get('until') && f.get('since')>f.get('until'))throw new Error('结束日期须等于或晚于开始日期。');
      if(f.get('since'))params.start_created=f.get('since')+' 00:00:00';
      if(f.get('until'))params.end_created=f.get('until')+' 23:59:59';
      if(f.get('reference'))params[op==='get_order_detail'?'tid':'refund_id']=f.get('reference').trim();
      out.textContent='正在获取店铺数据…';
      const r=await ctx.api('/v1/integrations/mcp-cn-commerce/query',{method:'POST',body:{shopId:id,operation:op,params}});
      if(ctx.active())out.innerHTML='<p>'+h(r.shop)+' · '+h(names[op]??op)+'</p>'+resultTable(r.data);
    }catch(err){if(ctx.active())out.textContent=describeError(err);}finally{fields.shopId.disabled=fields.operation.disabled=false;}
  });
}
