import { bindCommerceSdk } from './live-commerce-sdk.js';
import { integrationSlot } from './live-agent-integrations.js';
import { sceneDesk } from './studio-workflows.js';
import { bindShopPane, shopPane, storesFor } from './desk-shops.js';
import { commerceReport } from './live-commerce-report.js';
import { action, field, form, grid, h, heading, input, item, link, list, notice, panel, path, select, textarea, toast } from './live.js';
import { parseValue, readOperationsCsv, template } from './operations-file.js';

const root = '/v1/studio/pinduoduo';
const pageSize = 25;
const captions = {orders:'待发货', shipments:'物流异常', returns:'待处理', tickets:'待处理', reviews:'待拟回复'};
const pageRoute = (base, filters) => base + '/list/' + path(filters.toString());
const money = minor => { const n = BigInt(minor); return '¥' + (n / 100n) + '.' + String(n % 100n).padStart(2,'0'); };

function download(filename, type, data) {
  const url = URL.createObjectURL(new Blob([data],{type}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function control(key, f, value) {
  const required = f.optional ? '' : 'required';
  if (f.type === 'choice') return select(key,[['','请选择'],...f.choices.map(v => [v,v])],value ?? '',required);
  if (f.type === 'text' && f.max > 500) return textarea(key, required + ' maxlength="' + f.max + '"', value);
  let attrs = required;
  if (f.type === 'text') attrs += ' maxlength="' + f.max + '"';
  else if (f.type === 'date') attrs += ' type="date"';
  else {
    const unit = f.type === 'money' ? 100 : 1;
    attrs += ' type="number" min="' + f.min / unit + '" max="' + f.max / unit + '" step="' + (1/unit) + '"';
    if (value != null) value = value / unit;
  }
  return input(key, attrs + ' value="' + h(value) + '"');
}

function editor(ctx, model, back, endpoint, record) {
  const values = record?.details ?? {};
  const fields = field(model.keyLabel, input('reference', 'maxlength="100" required ' +
    (record ? 'readonly value="' + h(record.reference) + '"' : ''))) + Object.entries(model.fields).map(([key,f]) =>
    field(f.label,control(key,f,values[key]))).join('');
  ctx.html(heading((record ? '编辑' : '新增') + model.label + '记录', '保存在当前店铺台账。') +
    link('返回' + model.label,back) + panel('业务记录',form('operation-edit',fields,'保存到台账')));
  ctx.submit('operation-edit',async data => {
    const details = {};
    for (const [key,f] of Object.entries(model.fields)) {
      const value = parseValue(f,data.get(key));
      if (value !== undefined) details[key] = value;
    }
    await ctx.api(endpoint,{method:'PUT',body:{ reference:data.get('reference'),revision:record?.revision ?? 0,details }});
    if (ctx.active()) { toast('已保存到台账'); ctx.go(back); }
  });
}

function filterBar(model, kind, params) {
  let fields = kind === 'analytics' ? '' : field('搜索编号或商品',input('q','maxlength="160" value="' + h(params.get('q')) + '"'));
  if (model.fields?.status) fields += field('状态', select('status',[['','全部'],...model.fields.status.choices.map(v => [v,v])],params.get('status') ?? ''));
  if (model.fields?.day || kind === 'analytics') fields += field('开始日期',input('from','type="date" value="' + h(params.get('from')) + '"')) +
    field('结束日期',input('to','type="date" value="' + h(params.get('to')) + '"'));
  if (kind === 'orders' || kind === 'tickets') fields += field('仅看此日期前已逾期',input('overdueOn','type="date" value="' + h(params.get('overdueOn')) + '"'));
  if (kind === 'inventory') fields += field('库存范围',select('low',[['','全部'],['true','低于或等于预警线']],params.get('low') ?? ''));
  return form('filter-records',fields,'查询');
}

function pager(base, params, offset, more) {
  function at(n) { const query = new URLSearchParams(params); query.set('offset', n); return pageRoute(base,query); }
  return (offset ? link('上一页',at(Math.max(0,offset-pageSize))) : '') + (more ? link('下一页',at(offset+pageSize)) : '');
}

function renderItem(record, model, kind, base, bookRoute) {
  const d = record.details;
  const values = Object.entries(model.fields).filter(([key]) => key !== 'title' && d[key] != null)
    .map(([key,f]) => f.label + ' ' + (f.type === 'money' ? money(d[key]) : d[key]));
  if (kind === 'inventory' && d.stock <= d.threshold) values.push('库存预警');
  if (kind === 'performance' && d.visitors > 0) values.push('支付转化率 ' + (d.buyers*100/d.visitors).toFixed(2) + '%');
  const related = d.orderRef ? link('查询关联订单',pageRoute(bookRoute + '/orders',new URLSearchParams({q:d.orderRef}))) : '';
  const title = d.title ? record.reference + ' · ' + d.title : record.reference;
  return item(title,values.join(' · '),link('编辑',base + '/edit/' + path(record.reference)) + related);
}

async function recordsPage(ctx, book, kind, model, view, key) {
  const bookRoute = 'commerce/' + book.id;
  const base = bookRoute + '/' + kind;
  const endpoint = root + '/books/' + book.id + (kind === 'analytics' ? '/analytics' : '/records/' + kind);
  if (kind !== 'analytics' && (view === 'new' || view === 'edit')) {
    const record = view === 'edit' ? await ctx.api(endpoint + '/lookup?reference=' + path(decodeURIComponent(key))) : null;
    editor(ctx,model,base,endpoint,record); return;
  }
  const filters = new URLSearchParams(view === 'list' && key ? decodeURIComponent(key) : '');
  const offset = Number(filters.get('offset') ?? 0);
  const query = new URLSearchParams(filters); query.set('limit',pageSize+1);
  const {items} = await ctx.api(endpoint + '?' + query);
  const entries = items.slice(0,pageSize);
  const analytics = kind === 'analytics';
  const table = analytics ? list(entries, r => item(r.day, r.orders + ' 笔非取消订单 · ' + r.units + ' 件 · 有实付金额 ' + r.withAmount + ' 笔 · 已知实付合计 ' +
    (r.paidMinor == null ? '未提供' : money(r.paidMinor)))) : list(entries,r => renderItem(r,model,kind,base,bookRoute));
  const imports = analytics ? '' : panel('导入和导出', notice('可上传本页模板格式的业务 CSV 或本页导出的 JSON，每次最多 500 条。相同记录自动跳过，内容冲突会整批退回。') +
    action('下载 CSV 表头','template') + (entries.length ? action('导出本页 JSON','export') : '') +
    form('operation-import',field('业务文件',input('file','type="file" accept=".csv,.json" required')),'导入台账'));
  ctx.html(heading(model.label,book.name + ' · 手工录入或文件导入') + link('返回运营总览',bookRoute) +
    (analytics ? link('日周月报表与导出',bookRoute+'/report') : link('新增记录',base + '/new')) +
    (kind === 'inventory' ? link('从商品草稿入账','drafts') : '') + panel('查询',filterBar(model,kind,filters)) +
    panel(model.label,listHeading(entries,offset) + table + pager(base,filters,offset,items.length>pageSize)) + imports);
  ctx.submit('filter-records', data => {
    const next = new URLSearchParams();
    for (const [name,value] of data) if (value.trim()) next.set(name,value.trim());
    ctx.go(pageRoute(base,next));
  });
  if (analytics) return;
  ctx.click('template',() => download(model.label + '-模板.csv','text/csv;charset=utf-8',template(model)));
  ctx.click('export',() => download(model.label + '.json','application/json',JSON.stringify({kind,items:entries.map(({reference,details}) => ({reference,details}))},null,2)));
  ctx.submit('operation-import',async data => {
    const file = data.get('file');
    if (!file.size || file.size > 4 * 1024 * 1024) throw new Error('请选择 4 MiB 以内的业务文件');
    const source = await file.text();
    let items;
    if (/\.csv$/i.test(file.name)) items = readOperationsCsv(source,model);
    else {
      const payload = JSON.parse(source.replace(/^\uFEFF/,''));
      if (payload?.kind !== kind || !Array.isArray(payload.items)) throw new Error('请选择当前模块导出的 JSON');
      items = payload.items;
    }
    const result = await ctx.api(endpoint + '/import',{method:'POST',body:{items}});
    if (ctx.active()) { toast('新增 ' + result.inserted + ' 条，已存在 ' + result.unchanged + ' 条'); ctx.reload(); }
  });
}

function listHeading(entries, offset) {
  return entries.length ? notice('第 ' + (offset+1) + '–' + (offset+entries.length) + ' 条') : '';
}

export async function operationsPage(ctx) {
  if (!ctx.manager) { ctx.html(heading('拼多多运营') + notice('店铺业务台账由工作区所有者或管理员管理。')); return; }
  const [id,kind,view,key] = ctx.args;
  const books = await ctx.all(root + '/books');
  if (!id || id==='shops') {
    const directory=await storesFor(ctx);
    if(!ctx.active())return;
    const ledger=grid(panel('拼多多店铺台账',list(books,b => item(b.name,'',link('打开台账','commerce/' + b.id)),'还没有台账。创建后可以录入或导入业务记录。')),
      panel('新建台账',form('book',field('店铺或台账名称',input('name','maxlength="120" required placeholder="输入店铺或台账名称"')),'创建台账'))) +
      '<div class="scene-related">'+link('检查我的商品草稿','drafts/quality') + link('客服工作台','customer')+'</div>';
    sceneDesk(ctx,'operations',[
      {id:'query',label:'店铺数据',icon:'operations',body:'<section class="scene-work" data-commerce-query-pane><p role="status">正在读取店铺授权…</p></section>'},
      {id:'report',label:'经营日报',icon:'tasks',body:integrationSlot('mcp-cn-commerce')},
      {id:'books',label:'运营台账',icon:'data',count:books.length,body:ledger},
      {id:'shops',label:'店铺管理',icon:'desk',count:directory.items.length,body:shopPane(ctx,directory,'commerce')},
    ],id==='shops'?'shops':'query',link('投放收益测算','roi'));
    bindShopPane(ctx,directory);
    void bindCommerceSdk(ctx,directory);
    ctx.submit('book',async f => { const book = await ctx.api(root + '/books',{method:'POST',body:{name:f.get('name')}}); ctx.go('commerce/' + book.id); });
    return;
  }
  const book = books.find(b => b.id === id);
  if (!book) throw new Error('当前工作区找不到这个台账');
  if(kind==='report')return commerceReport(ctx,book,view);
  const modules = await ctx.api(root + '/modules');
  if (kind) {
    if (kind !== 'analytics' && !Object.hasOwn(modules,kind)) throw new Error('找不到这个业务模块');
    return recordsPage(ctx,book,kind,kind === 'analytics' ? {label:'订单经营日报'} : modules[kind],view,key);
  }
  const now = new Date();
  const today = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
  const [totals,insights] = await Promise.all([ctx.api(root + '/books/' + id + '/summary'),
    ctx.api(root + '/books/' + id + '/insights?asOf=' + today)]);
  const summary = totals.items;
  const tiles = Object.entries(modules).map(([k,m]) => {
    const r = summary.find(v => v.kind === k);
    let caption = (r?.total ?? 0) + ' 条记录';
    if (captions[k]) caption += ' · ' + captions[k] + ' ' + (r?.pending ?? 0);
    if (k === 'inventory') caption += ' · 库存预警 ' + (r?.low ?? 0);
    const base = 'commerce/' + id + '/' + k;
    const states = insights.states.filter(s => s.kind === k && !(captions[k] === s.status)).map(s => s.status + ' ' + s.count);
    const overdue = insights.overdue[k] ? link('逾期 ' + insights.overdue[k] + ' 条', pageRoute(base,new URLSearchParams({overdueOn:today}))) : '';
    return item(m.label,[caption,...states].join(' · '),link('查看' + m.label,base) + overdue);
  }).join('');
  ctx.html(heading(book.name,'工作台台账汇总 · 数据范围为本台账已录入记录') + link('切换台账','commerce') +
    link('查看订单经营日报','commerce/' + id + '/analytics') + link('日周月报表与导出','commerce/'+id+'/report') + link('检查我的商品草稿','drafts/quality') + panel('业务记录与待办',tiles) +
    (insights.reviewTags.length ? panel('已录评价的常见标签',notice(insights.reviewTags.map(r => r.tag + '（' + r.count + '）').join('、'))) : ''));
}
