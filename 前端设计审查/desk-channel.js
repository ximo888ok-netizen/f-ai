import { field, form, h, input, notice, select } from './live-ui.js';
import { paneTitle,blankResult } from './live-agent-integrations.js';
import { platformNames,inboxLink } from './desk-shops.js';
import { describeError } from './studio-errors.js';

export function nativeChannelPane(shops) {
  return '<div class="native-pane"><section class="scene-sheet">'+paneTitle('connections','平台接待')+
    (shops.length?form('native-history',field('已绑定店铺',select('shopId',shops.map(s=>[s.id,s.name+' · '+platformNames[s.platform]])))+
      field('买家 ID',input('query','maxlength="100" required placeholder="输入平台买家 ID"')),'读取会话')+
      '<div data-platform-desk></div><h3>已转人工</h3><div data-native-queue></div>':
      '<p>绑定 Customer-Agent 店铺资料库后，可在这里查看买家历史和已转人工的会话。</p><button type="button" class="primary" data-channel-shops>打开店铺管理</button>')+
    '</section><section class="scene-sheet">'+paneTitle('service','平台聊天记录')+'<div data-native-stream role="log">'+
    blankResult('service','尚未选择买家','读取后的消息按时间排列。')+'</div><div data-native-actions></div><p role="status" data-native-status></p></section></div>';
}
export function bindNativeChannels(ctx,shops) {
  const root=document.querySelector('.native-pane');
  if(!root||!ctx.active())return;
  const jump=root.querySelector('[data-channel-shops]');
  if(jump){jump.onclick=()=>document.getElementById('scene-customer-shops-tab').click();return;}
  const f=root.querySelector('form'), stream=root.querySelector('[data-native-stream]'), actions=root.querySelector('[data-native-actions]'), status=root.querySelector('[data-native-status]');
  const queue=root.querySelector('[data-native-queue]');
  let view=null,serial=0,queueSeq=0,busy=false;
  const call=(name,body)=>ctx.api('/v1/integrations/customer-agent/'+name,{method:'POST',body});
  async function loadQueue() {
    const id=f.elements.shopId.value,seq=++queueSeq;
    root.querySelector('[data-platform-desk]').innerHTML=inboxLink(shops.find(s=>s.id===id)?.platform,'打开平台客服');
    queue.textContent='正在读取转接记录…';
    try{
      const r=await call('handoffs',{shopId:id});
      if(!ctx.active()||seq!==queueSeq)return;
      queue.innerHTML=r.items.length?r.items.map(v=>'<button type="button" data-native-buyer="'+h(v.buyerId)+'">'+h(v.buyerId)+'</button>').join(' '):notice('该店暂无有效的转人工标记。');
    }catch(e){if(ctx.active()&&seq===queueSeq)queue.textContent=describeError(e);}
  }
  async function read() {
    if(!view)return;
    const request=view,seq=++serial;
    try{
      const r=await call('history',request);
      if(!ctx.active()||view!==request||seq!==serial)return;
      status.textContent='最近读取 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
      stream.innerHTML=r.items.map(m=>'<article class="chat-turn" data-sender="'+(m.role==='user'?'customer':'assistant')+'"><small>'+h(m.role==='user'?'买家':'AI 客服')+' · '+h(m.timestamp)+'</small><p>'+h(m.content)+'</p></article>').join('')||notice('此账号下没有该买家的历史消息。');
      const shop=shops.find(s=>s.id===request.shopId);
      actions.innerHTML=(r.items.length&&shop?.allowHandoff?'<button type="button" class="primary" data-native-handoff>标记人工接管</button>':'')+inboxLink(shop?.platform,'在官方客服窗口回复');
    }catch(e){if(ctx.active()&&view===request&&seq===serial)status.textContent=describeError(e);}
  }
  function clear(){
    view=null;serial++;actions.replaceChildren();status.textContent='';stream.innerHTML=notice('读取此买家后显示聊天记录。');
  }
  f.elements.shopId.onchange=()=>{clear();f.elements.query.value='';loadQueue();};
  f.elements.query.oninput=clear;
  queue.onclick=e=>{const b=e.target.closest('[data-native-buyer]');if(b){f.elements.query.value=b.dataset.nativeBuyer;f.requestSubmit();}};
  ctx.submit('native-history',async data=>{view={shopId:data.get('shopId'),query:data.get('query').trim()};actions.replaceChildren();stream.textContent='正在读取…';await read();});
  actions.onclick=async e=>{
    const btn=e.target.closest('[data-native-handoff]');
    if(!btn||!view||busy)return;
    const selected=view;
    if(!window.confirm('为当前买家写入 Customer-Agent 转人工标记？新标记有效一小时，人工回复在官方客服窗口发送。'))return;
    busy=true;btn.disabled=true;
    try{
      const r=await call('handoff',{shopId:selected.shopId,buyerId:selected.query});
      if(ctx.active()&&view===selected){status.textContent='转人工标记有效至 '+new Date(r.expiry*1000).toLocaleString('zh-CN');await loadQueue();}
    }catch(err){if(ctx.active()&&view===selected)status.textContent=describeError(err);}finally{busy=false;btn.disabled=false;}
  };
  let first=true;
  const refresh=async()=>{
    if(busy||!ctx.active()||document.hidden||!root.getClientRects().length)return;
    busy=true;
    try{await Promise.all([loadQueue(),read()]);}finally{busy=false;first=false;}
  };
  const tab=document.getElementById('scene-customer-channel-tab');tab?.addEventListener('click',()=>{if(first)refresh();});
  refresh();
  const timer=setInterval(refresh,12000);
  ctx.signal.addEventListener('abort',()=>clearInterval(timer),{once:true});
}
