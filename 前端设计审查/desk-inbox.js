import { action, field, form, h, input, link, path, retryKey, select, textarea } from './live-ui.js';
import { studioIcon } from './studio-icons.js';
import { platformNames, inboxLink, rememberedShop, rememberShop } from './desk-shops.js';
import { describeError } from './studio-errors.js';

const endpoint='/v1/customer-service/conversations';
const roles={customer:'买家',assistant:'AI 客服',operator:'人工客服'};
const msgTime=v=>new Date(v).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});

export function inboxPane(ctx,shops,bases,products) {
  const shopList=[['','全部店铺'],['local','未关联店铺'],...shops.filter(s=>s.enabled).map(s=>[s.id,s.name])];
  return '<div class="inbox-layout"><aside class="inbox-rail"><header class="scene-panel-title">'+studioIcon('service')+'<h2>会话队列</h2><button type="button" class="inbox-add" aria-label="新建会话" title="新建会话" data-inbox-new>'+studioIcon('plus')+'</button></header>'+
    field('店铺范围',select('inboxShop',shopList,rememberedShop(ctx,shops)))+
    '<div class="inbox-filter" aria-label="筛选接待状态">'+[['all','全部'],['assistant','AI 接待'],['human','人工']].map(([v,t])=>'<button type="button" data-inbox-filter="'+v+'" aria-pressed="'+(v==='all')+'">'+t+'</button>').join('')+'</div>'+
    '<div class="inbox-list" data-inbox-list></div></aside>'+
    '<section class="inbox-chat"><header class="inbox-head" data-chat-head></header><div class="inbox-stream" data-chat-stream role="log" aria-label="聊天记录"></div>'+
    '<div data-chat-compose></div><p class="scene-hint" data-chat-error role="status"></p></section>'+
    '<aside class="inbox-context"><header class="scene-panel-title">'+studioIcon('tasks')+'<h2>接待信息</h2></header><div data-chat-context></div>'+
    '<div class="inbox-context-links">'+link('快捷话术','customer/replies')+link('工作区知识库','resources')+'</div></aside></div>'+
    '<dialog class="scene-dialog" data-inbox-dialog><header><h2>新建工作台会话</h2>'+action('关闭','close-new')+'</header>'+
    form('new-conversation',field('主题',input('subject','required maxlength="160" placeholder="本次咨询的主题"'))+
      (ctx.manager?field('关联店铺',select('shopId',[['','工作区会话'],...shopList.slice(2)],rememberedShop(ctx,shops))):'')+
      (products.length ? field('关联商品（选填）',select('productId',[['','不关联'],...products.map(product=>[product.id,product.sku+' · '+product.name])])) : '')+
      field('商品编号（选填）',input('productReference','maxlength="100"'))+field('订单编号（选填）',input('orderReference','maxlength="100"'))+
      (bases.length?field('可引用的知识库',select('baseId',bases.map(b=>[b.id,b.name]),undefined,'multiple')):''),'创建会话')+'</dialog>';
}

export async function bindInbox(ctx,{shops,conversations,replies,initial,onDraft}) {
  const root=document.querySelector('.inbox-layout');
  if (!root || !ctx.active()) return;
  const el=s=>root.querySelector(s), stream=el('[data-chat-stream]'), errors=el('[data-chat-error]');
  const scope=el('[name=inboxShop]'),dialog=document.querySelector('[data-inbox-dialog]');
  let all=conversations, filter='all', selected=null, epoch=0, current=null, turns=[], lastComposer='', busy=false;
  const drafts=new Map(), senderKeys=new Map();
  const shopFor=id=>shops.find(s=>s.id===id);
  const matches=row=>(!scope.value || (scope.value==='local'?!row.shopId:row.shopId===scope.value)) && (filter==='all'||row.state===filter);
  const initialRow=all.find(s=>s.id===initial);
  if(initial && !initialRow) { scope.value=''; }
  if(initialRow) scope.value=initialRow.shopId || '';
  const updateStatus=msg=>{errors.textContent=msg;};
  function queue() {
    const list=all.filter(matches);
    el('[data-inbox-list]').innerHTML=list.map(r=>'<button type="button" data-thread="'+h(r.id)+'" aria-pressed="'+(r.id===selected)+'"><span class="thread-avatar">'+h(r.subject.slice(0,1))+'</span><span><strong>'+h(r.subject)+'</strong><small>'+h(r.state==='human'?'人工接待':'AI 接待')+' · '+h(msgTime(r.updatedAt))+'</small></span></button>').join('')||
      '<p class="scene-hint">当前范围暂无会话</p>';
    return list;
  }
  function header() {
    el('[data-chat-head]').innerHTML='<div><small>工作台会话</small><h2>'+h(current?.subject || '接待窗口')+'</h2></div>'+
      (current?'<div><span class="desk-status">'+h(current.state==='human'?'人工接待':'AI 接待')+'</span>'+
        (ctx.manager&&ctx.enterprise&&current.state==='assistant'?action('人工接管','live-handoff'):'')+'</div>':'');
    const shop=shopFor(current?.shopId || scope.value);
    el('[data-chat-context]').innerHTML='<dl>'+[['关联店铺',shop?.name || '未关联'],['渠道',shop?platformNames[shop.platform]:'工作台'],['接待人',current?.operatorId?(current.operatorId===ctx.account.id?'我':'其他客服'):'—'],['商品编号',current?.productReference || '—'],['订单编号',current?.orderReference || '—']].map(([k,v])=>'<div><dt>'+k+'</dt><dd>'+h(v)+'</dd></div>').join('')+'</dl>'+
      (shop?inboxLink(shop.platform,'前往平台接待'):'');
  }
  function messages() {
    const nearEnd=stream.scrollHeight-stream.scrollTop-stream.clientHeight<72;
    stream.innerHTML=turns.length?turns.map(m=>'<article class="chat-turn" data-sender="'+h(m.sender)+'"><small>'+roles[m.sender]+' · '+h(msgTime(m.createdAt))+'</small><p>'+h(m.content)+'</p>'+
      (m.sources||[]).map(s=>link(s.documentName,'resources/'+path(s.baseId)+'/'+path(s.documentId))).join('')+'</article>').join(''):
      '<div class="scene-void">'+studioIcon('service')+'<h3>'+h(current?'等待第一条消息':'选择会话开始接待')+'</h3><p>'+h(current?'后续消息将在这里更新。':'从队列中选择买家咨询，或创建工作台会话。')+'</p>'+(!current?'<button type="button" class="primary" data-inbox-new>新建工作台会话</button>':'')+'</div>';
    if(nearEnd)stream.scrollTop=stream.scrollHeight;
  }
  function composer() {
    const canReply=current?.operatorId===ctx.account.id && current?.state==='human';
    const sender=canReply?'operator':current?.accountId===ctx.account.id?'customer':'';
    const signature=selected+':'+sender+':'+current?.state;
    if(lastComposer===signature)return;
    lastComposer=signature;
    const host=el('[data-chat-compose]');
    host.replaceChildren();
    if(!current)return;
    if(!sender){host.innerHTML='<p class="scene-hint">接管此会话后可人工回复。</p>';return;}
    const draftKey=selected+':'+sender, text= drafts.get(draftKey) || '';
    host.innerHTML='<form data-chat-send class="chat-compose">'+(canReply && replies.length?select('quick',[['','插入快捷话术'],...replies.map(r=>[r.id,r.title])]):'')+
      textarea('content','aria-label="'+(canReply?'客服回复':'客户消息')+'" required maxlength="4000" placeholder="'+(canReply?'输入人工回复…':'输入工作台客户消息…')+'"',text)+
      (sender==='customer' && current.state==='assistant'?'<details><summary>检索选项</summary>'+field('知识检索关键词',input('search','maxlength="160"'))+'</details>':'')+
      '<footer>'+action('拟写回复草稿','compose-draft')+'<button type="submit" class="primary">'+(canReply?'发送人工回复':'发送客户消息')+'</button></footer></form>';
    const f=host.querySelector('form'),id=selected;
    f.elements.content.oninput=()=>drafts.set(draftKey,f.elements.content.value);
    if(f.elements.quick) f.elements.quick.onchange=()=>{const reply=replies.find(r=>r.id===f.elements.quick.value);if(reply){f.elements.content.value=reply.content;drafts.set(draftKey,reply.content);}};
    f.querySelector('[data-compose-draft]').onclick=()=>onDraft(turns.findLast(m=>m.sender==='customer')?.content || '', id);
    f.onsubmit=async e=>{
      e.preventDefault();
      const submit=f.querySelector('[type=submit]');
      if(submit.disabled)return;
      const value=f.elements.content.value.trim();
      if(!value)return;
      submit.disabled=true;
      const body={sender,content:value,...(f.elements.search?.value.trim()?{search:f.elements.search.value.trim()}:{})};
      if(!senderKeys.has(draftKey)) senderKeys.set(draftKey,retryKey());
      try{
        await ctx.api(endpoint+'/'+id+'/messages',{method:'POST',body:{...body,clientId:senderKeys.get(draftKey)(body)}});
        senderKeys.delete(draftKey);drafts.delete(draftKey);
        if(ctx.active()&&selected===id){f.elements.content.value='';await refresh(false);}
      }catch(err){if(ctx.active())updateStatus(describeError(err));}
      finally{submit.disabled=false;}
    };
  }
  async function refresh(reset) {
    const seq=++epoch,id=selected;
    if(reset){current=null;turns=[];lastComposer='';header();messages();composer();}
    if(!id)return;
    const delta=[];
    let next, offset=turns.length;
    do {
      const page=await ctx.api(endpoint+'/'+path(id)+'/messages?limit=100&offset='+offset);
      if(!ctx.active() || seq!==epoch)return;
      next=page.conversation;delta.push(...page.items);offset+=page.items.length;
      if(page.items.length<100)break;
    }while(true);
    current=next;turns.push(...delta);updateStatus('');
    all=all.map(s=>s.id===id?next:s);queue();header();if(reset || delta.length)messages();composer();
    if(reset)stream.scrollTop=stream.scrollHeight;
  }
  function choose(id){ selected=id;queue();return refresh(true).catch(e=>{if(ctx.active()&&selected===id)updateStatus(describeError(e));}); }
  function filtered(){const visible=queue();if(!visible.some(r=>r.id===selected))return choose(visible[0]?.id || null);}
  root.addEventListener('click',async e=>{
    const node=e.target.closest('button');
    if(!node)return;
    if(node.hasAttribute('data-inbox-new')){if(dialog.querySelector('[name=shopId]'))dialog.querySelector('[name=shopId]').value=shopFor(scope.value)?.id || '';dialog.showModal();return;}
    if(node.dataset.thread){await choose(node.dataset.thread);revealChat();return;}
    if(node.dataset.inboxFilter){filter=node.dataset.inboxFilter;root.querySelectorAll('[data-inbox-filter]').forEach(n=>n.setAttribute('aria-pressed',String(n===node)));return filtered();}
    if(node.hasAttribute('data-live-handoff') && selected){
      const id=selected;node.disabled=true;
      const writing=Array.from(el('[data-chat-compose]').querySelectorAll('textarea,input,button,select')).filter(n=>!n.disabled);
      writing.forEach(n=>{n.disabled=true;});updateStatus('正在接管会话…');
      try{
        await ctx.api(endpoint+'/'+id+'/handoff',{method:'POST'});
        if(ctx.active()&&id===selected){
          if(filter==='assistant'){filter='human';root.querySelectorAll('[data-inbox-filter]').forEach(n=>n.setAttribute('aria-pressed',String(n.dataset.inboxFilter===filter)));}
          await refresh(false);
        }
      }catch(err){if(ctx.active())updateStatus(describeError(err));}finally{node.disabled=false;writing.forEach(n=>{n.disabled=false;});}
    }
  });
  scope.onchange=()=>{rememberShop(ctx,scope.value==='local'?'':scope.value);filtered();};
  ctx.click('close-new',()=>dialog.close());
  ctx.submit('new-conversation',async f=>{
    const body={subject:f.get('subject').trim(),knowledgeBaseIds:f.getAll('baseId')};
    for(const key of ['shopId','productId','productReference','orderReference'])if(f.get(key)?.trim())body[key]=f.get(key).trim();
    const created=await ctx.api(endpoint,{method:'POST',body});if(!ctx.active())return;
    dialog.close();dialog.querySelector('form').reset();all.unshift(created);filter='all';
    root.querySelectorAll('[data-inbox-filter]').forEach(n=>n.setAttribute('aria-pressed',String(n.dataset.inboxFilter==='all')));
    scope.value=created.shopId || '';await choose(created.id);revealChat();
  });
  function revealChat(){if(ctx.active() && matchMedia('(max-width:600px)').matches)el('.inbox-chat').scrollIntoView({block:'start',behavior:'instant'});}
  await choose(initialRow?.id || queue()[0]?.id || initial || null);
  const timer=setInterval(async()=>{
    if(busy || !ctx.active() || document.hidden || !root.getClientRects().length)return;
    busy=true;
    try{
      const updated=await ctx.all(endpoint);
      if(!ctx.active())return;
      all=updated;const visible=queue();if(selected && !visible.some(r=>r.id===selected))await filtered();else if(selected)await refresh(false);else if(visible.length)await choose(visible[0].id);
    }catch(err){if(ctx.active())updateStatus(describeError(err));}finally{busy=false;}
  },6000);
  if(!ctx.active()){clearInterval(timer);return;}
  ctx.signal.addEventListener('abort',()=>clearInterval(timer),{once:true});
  return (id,text)=>{
    if(!id||selected!==id||current?.state!=='human'||current.operatorId!==ctx.account.id)return false;
    const control=el('[data-chat-send] [name=content]');if(!control)return false;
    control.value=text;control.dispatchEvent(new Event('input'));control.focus();return true;
  };
}
