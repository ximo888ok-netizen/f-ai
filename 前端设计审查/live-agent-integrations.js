import { confirmDialog } from './live-ui.js';
import { action, field, form, h, input, link, notice, panel, path, retryKey, select, textarea } from './live-ui.js';
import { describeError } from './studio-errors.js';
import { studioIcon } from './studio-icons.js';
import { downloadContent } from './live-text-delivery.js';

const states = { not_configured:'未配置外部运行时。', runtime_unavailable:'运行时不可用，请核对 Python 及上游依赖。', model_unconfigured:'运行时已安装，尚未配置模型。', disabled:'此工作区已停用模型接入。' };
export const integrationSlot = name => '<section class="card live-panel" data-engine="' + name + '"><h2>' + h(name) + '</h2><p role="status">正在检查接入…</p></section>';

export const paneTitle=(icon,title,meta='')=>'<header class="scene-panel-title"><span class="scene-tile-icon">'+studioIcon(icon)+'</span><h2>'+h(title)+'</h2>'+(meta?'<small>'+h(meta)+'</small>':'')+'</header>';
export const blankResult=(icon,title,note)=>'<div class="scene-void"><span class="empty-glyph">'+studioIcon(icon)+'</span><h3>'+h(title)+'</h3><p>'+h(note)+'</p></div>';
const modelMeta=state=>'<div class="model-meta"><span class="desk-status">'+h(state.model)+'</span><span>每次 '+h(state.cost)+' 积分</span></div>';

export async function integrationStatus(ctx, engine) {
  const box = document.querySelector('[data-engine="' + engine + '"]');
  if (!box) return null;
  try {
    const state = await ctx.api('/v1/integrations/' + engine);
    if (!ctx.active() || !box.isConnected) return null;
    return {box,state};
  } catch (error) {
    if (ctx.active()) box.querySelector('[role=status]').textContent = '接入信息读取失败。' + describeError(error);
    return null;
  }
}

function waitTick(signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, 1500);
    function done() { clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); }
    signal.addEventListener('abort',done,{once:true});
  });
}

function bindGeneration(ctx, box, name, engine, capability, params, complete, origin=()=>null) {
  const key = retryKey();
  const output = box.querySelector('[data-generation-result]');
  ctx.submit(name, async data => {
    const body = { capabilityId:capability, modelId:engine, mode:'workflow', parameters:params(data) };
    const submittedFrom=origin();
    output.textContent = '正在提交…';
    let id;
    try {
      let task = await ctx.api('/v1/tasks',{ method:'POST', body:{...body,idempotencyKey:key(body)} });
      id = task.id;
      while (ctx.active() && ['queued','running'].includes(task.state)) {
        output.innerHTML = notice(task.state === 'queued' ? '任务已排队。' : '正在生成…') + link('查看任务记录','tasks/' + path(id));
        await waitTick(ctx.signal);
        if (!ctx.active() || !box.isConnected) return;
        task = await ctx.api('/v1/tasks/' + path(id));
      }
      if (!ctx.active() || !box.isConnected) return;
      if (task.state !== 'succeeded' || !task.result?.text) throw new Error('任务未完成（' + (task.errorCode || task.state) + '）。');
      output.innerHTML = '<pre class="live-result">' + h(task.result.text) + '</pre>' + link('查看任务记录','tasks/' + path(id));
      complete(task, output, submittedFrom);
    } catch (error) {
      if (ctx.active()) output.innerHTML = notice(describeError(error)) + (id ? link('查看任务记录','tasks/' + path(id)) : '');
    }
  });
}

export async function bindCustomerAgent(ctx, question = '', handover = null) {
  const engine = 'customer-agent', loaded = await integrationStatus(ctx, engine);
  if (!loaded) return;
  const { box,state } = loaded;
  const knowledge = state.shops.length ? '<details class="live-fold"><summary>查询已绑定店铺的知识与会话</summary>' +
    form('ca-lookup',field('Customer-Agent 店铺',select('shopId',state.shops.map(s=>[s.id,s.name]))) +
      field('查询类型',select('lookup',[['knowledge','店铺商品 / 客服知识'],['history','会话最近 50 条消息']])) +
      field('知识关键词或买家 ID',input('query','required maxlength="150"')), '读取') + '<div data-evidence></div></details>' :
    notice('尚无可访问的 Customer-Agent 店铺绑定。');
  box.innerHTML = '<div class="scene-split"><section class="scene-editor">'+paneTitle('service','回复助手')+
    (state.state === 'ready' ? form('ca-draft',field('买家问题',textarea('question','required maxlength="2000" rows="4" placeholder="输入买家刚刚问的问题…"',question)) +
      field('参考事实',textarea('facts','maxlength="5000" rows="4" placeholder="填写商品参数、店铺政策或已确认的订单情况"'))+modelMeta(state), '生成回复草稿') : notice(states[state.state]))+knowledge+
    '</section><section class="scene-output">'+paneTitle('copywriting','回复草稿')+'<div data-generation-result role="status">'+blankResult('service','等待生成回复','核对后可将草稿带入已接管的会话。')+'</div></section></div>';
  const facts = box.querySelector('[name=facts]');
  if (state.shops.length) ctx.submit('ca-lookup',async f => {
    const target = box.querySelector('[data-evidence]');
    target.textContent = '正在查询…';
    try {
      const data = await ctx.api('/v1/integrations/customer-agent/' + f.get('lookup'),{method:'POST',body:{shopId:f.get('shopId'),query:f.get('query')}});
      if (!ctx.active()) return;
      const lines = data.items.map(row => row.title ? row.kind + ' · ' + row.title + '\n' + row.content :
        row.timestamp + ' · ' + (row.role === 'user' ? '买家' : '助手') + '\n' + row.content);
      target.innerHTML = lines.length ? '<pre class="live-result">' + h(lines.join('\n\n')) + '</pre>' +
        (facts ? action('选用查询结果作为参考','ca-use') : '') : notice('没有匹配的记录。');
      target.querySelector('[data-ca-use]')?.addEventListener('click',()=>{ facts.value=lines.join('\n\n').slice(0,5000); facts.focus(); });
    } catch (error) { if (ctx.active()) target.textContent = describeError(error); }
  });
  if (state.state !== 'ready') return;
  bindGeneration(ctx,box,'ca-draft',engine,'customer-service.reply-draft',f=>({
    question:f.get('question').trim(), ...(f.get('facts').trim() ? {facts:f.get('facts').trim()} : {}),
  }),(task,target,id)=>{
    if (id && handover) {
      target.insertAdjacentHTML('beforeend',action('带入人工回复','ca-insert'));
      target.querySelector('[data-ca-insert]').onclick=()=>{
        document.querySelector('#scene-customer-inbox-tab')?.click();
        if (!handover.insert?.(id,task.result.text)) toastNotice(target,'请先在接待台选中原会话并人工接管，再带入此草稿。');
      };
    }
  },()=>handover?.id);
}

function toastNotice(target,message) {
  let node=target.querySelector('[data-insert-note]');
  if(!node){node=document.createElement('p');node.dataset.insertNote='';target.append(node);}
  node.textContent=message;
  if(document.querySelector('#scene-customer-draft-tab')) document.querySelector('#scene-customer-draft-tab').click();
}

export async function bindContentAgent(ctx, platform) {
  const engine='ecommerce-content-agent',loaded=await integrationStatus(ctx,engine);
  if(!loaded)return;
  const {box,state}=loaded;
  const channels=[['taobao','淘宝'],['douyin','抖音'],['xiaohongshu','小红书']];
  const channel=channels.some(([id])=>id===platform)?platform:'taobao';
  const picker='<fieldset class="channel-picker"><legend>发布平台</legend>'+channels.map(([id,name])=>'<label><input required type="radio" name="platform" value="'+id+'"'+(id===channel?' checked':'')+'><span>'+name+'</span></label>').join('')+'</fieldset>';
  const fields=picker+'<div data-product-library></div><div class="scene-pair">'+field('商品标题',input('title','required maxlength="240" placeholder="商品名称或标题"'))+
    field('商品类目',input('category','required maxlength="120" placeholder="填写商品所属类目"'))+'</div>'+
    field('商品资料',textarea('facts','required maxlength="4000" rows="4" placeholder="填写已确认的规格、材质、用途等商品信息"'))+
    '<details class="scene-fold"><summary>卖点与目标受众</summary>'+field('已有卖点（每行一条，最多 10 条）',textarea('sellingPoints','maxlength="3010"'))+
    field('目标受众',input('audience','maxlength="300"'))+'</details>'+modelMeta(state);
  box.innerHTML='<div class="scene-split"><section class="scene-editor">'+paneTitle('products','商品简报')+(state.state==='ready'?form('content-package',fields,'生成商品文案'):notice(states[state.state]))+
    '</section><section class="scene-output">'+paneTitle('copywriting','成稿编辑')+'<div data-generation-result role="status">'+blankResult('copywriting','等待生成内容包','标题、卖点、详情文案与关键词会在这里展开。')+'</div></section></div>';
  if(state.state!=='ready')return;
  bindGeneration(ctx,box,'content-package',engine,'copywriting.content-package',f=>({
    title:f.get('title').trim(),category:f.get('category').trim(),platform:f.get('platform'),facts:f.get('facts').trim(),
    sellingPoints:f.get('sellingPoints').split(/\r?\n/).map(v=>v.trim()).filter(Boolean),...(f.get('audience').trim()?{audience:f.get('audience').trim()}:{}),
  }),(task,target)=>{
    const r=task.result;
    const pieces=[['标题',r.title],['卖点',r.sellingPoints.join('\n')],['商品描述',r.description],['社交文案',r.socialCopy],['关键词',r.keywords.join('、')]];
    target.innerHTML='<div class="copy-proof">'+pieces.map(([label,v],i)=>field(label,textarea('proof'+i,'rows="'+(i===0?2:3)+'"',v||''))).join('')+'</div>'+
      '<p class="scene-hint">当前修改可导出。发布前请核对商品资料。</p>'+action('导出当前成稿','download-proof')+link('任务原稿','tasks/'+path(task.id));
    target.querySelector('[data-download-proof]').onclick=()=>{
      downloadContent('商品文案-'+task.id+'.txt',pieces.map(([label],i)=>label+'\n'+target.querySelector('[name=proof'+i+']').value).join('\n\n'));
    };
    if(['taobao','douyin'].includes(r.platform)){
      target.insertAdjacentHTML('beforeend',action('带入平台校验','check-proof'));
      target.querySelector('[data-check-proof]').onclick=()=>{
        editedProof.set(task.id,{title:target.querySelector('[name=proof0]').value,sellingPoints:target.querySelector('[name=proof1]').value});
        ctx.go('copy-review/'+r.platform+'/from/'+path(task.id));
      };
    }
  });
  try {
    const [products,categories]=await Promise.all([ctx.all('/v1/studio/products'),ctx.all('/v1/studio/categories')]);
    if(!ctx.active() || !box.isConnected)return;
    const library=box.querySelector('[data-product-library]');
    library.innerHTML=products.length?field('引用商品档案',select('product',[['','选择商品以填入简报'],...products.map(p=>[p.id,p.name+' · '+p.sku])])):link('管理商品档案','products');
    const control=library.querySelector('select');
    if(control)control.onchange=async()=>{
      const p=products.find(row=>row.id===control.value);if(!p)return;
      const f=box.querySelector('[data-form="content-package"]').elements;
      if((f.title.value||f.category.value||f.facts.value) && !await confirmDialog('确认操作', '用商品档案替换当前标题、类目和资料？')){control.value='';return;}
      f.title.value=p.name;f.facts.value=(p.description||'').slice(0,4000);f.category.value=categories.find(c=>c.id===p.categoryId)?.name||'';
    };
  } catch { if(ctx.active())box.querySelector('[data-product-library]').textContent='商品档案暂不可用，可手动填写。'; }
}
export const editedProof=new Map();
