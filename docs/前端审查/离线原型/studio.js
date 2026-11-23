const byId = id => document.getElementById(id);
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {page:'desk', category:'业务插件',role:'企业管理员', records:[],disabled:new Set(),drafts:{},seq:0};
const voice = {device:'系统默认',lang:'普通话',engine:'企业配置的识别服务'};
const other = {account:['账户与客户端','⊞'],desk:['生产工作台','⊞'],create:['创作台','✦'],library:['工具库','⊞'],assets:['素材库','▤'],home:['工作区总览','⌂'],tasks:['任务记录','☷'],manager:['插件管理','⊞']};
function toast(message){
 const feedback=byId('modal').open?byId('modalFeedback'):byId('live');
 clearTimeout(toast.timer);
 for(const region of [byId('modalFeedback'),byId('live')]){
  region.textContent='';
  region.classList.remove('show');
 }
 feedback.textContent=message;
 feedback.classList.add('show');
 toast.timer=setTimeout(()=>{
  feedback.classList.remove('show');
  feedback.textContent='';
 },2400);
}
function initial(id){
 const p=plugins[id];return {mode:'flow',step:0,style:0,allowed:true,source:id==='image'?scenes.audio.product:p.source,option:p.choices[0],action:id==='ops'?'自动上架发布':p.actions.split(' ')[0],prompt:'',scenario:'成功',chat:[],confirmed:false,chatInput:''};
}
function draft(id){return state.drafts[id] ??= initial(id)}
function current(){return draft(state.page)}
function navItem(id,icon){
 const active=state.page===id||(id==='create'&&plugins[state.page])||(id==='desk'&&entryByPage(state.page));
 return '<button data-nav="'+id+'" class="navitem '+(active?'active':'')+'" '+(active?'aria-current="page"':'')+'>'+glyph(icon)+'<span>'+safe(other[id][0])+'</span></button>';
}
function nav(){
 byId('nav').innerHTML=navItem('desk','grid')+navItem('create','spark')+sideGroups()+navItem('library','layout')+navItem('assets','folder')+navItem('manager','plugin')+navItem('account','store');
}
const button = (action,text,css='smallbtn') => '<button type="button" data-do="'+action+'" class="'+css+'">'+text+'</button>';
const select = (key,values,value,attributes='') => '<select id="f-'+key+'" data-field="'+key+'"'+attributes+'>'+values.map(v=>'<option '+(v===value?'selected':'')+'>'+safe(v)+'</option>').join('')+'</select>';
const input = (key,value) => '<input id="f-'+key+'" data-field="'+key+'" value="'+safe(value)+'">';
const field = (key,label,control) => '<label for="f-'+key+'">'+label+'</label>'+control;
function title(name,sub,extra=''){return '<div class="heading"><div><h1>'+name+'</h1><p class="sub">'+sub+'</p></div>'+extra+'</div>'}
function preview(id,d){return {image:imagePreview,video:storyboard,service:servicePreview,ops:opsPreview,copy:copyPreview}[id](d);}
function statusTag(label,tone='neutral'){
 return '<span class="tag" data-tone="'+safe(tone)+'">'+safe(label)+'</span>';
}
function emptyState(title,detail){
 return '<div class="ui-empty"><strong>'+safe(title)+'</strong><p>'+safe(detail)+'</p></div>';
}
function dataTable(label,columns,rows){
 return '<div class="ui-table-scroll" role="region" aria-label="'+safe(label)+'" tabindex="0"><table class="rows"><thead><tr>'+
  columns.map(title=>'<th scope="col">'+safe(title)+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function taskRows(list){
 const visible=list.filter(r=>!r.owner||r.owner===state.role);
 if(!visible.length)return emptyState('暂无任务','提交一次本地创作演练后，可在这里查看记录。');
 const tones={'成功':'success','失败':'error','处理中':'progress'};
 return dataTable('任务列表',['任务','插件','状态','操作'],visible.map(r=>'<tr><td>'+safe(r.name)+'</td><td>'+plugins[r.id].label+
  '</td><td>'+statusTag(r.status,tones[r.status])+'</td><td><button class="smallbtn" data-record="'+r.n+'">详情</button></td></tr>').join(''));
}
function changesShop(id,d){return id==='ops' && ['自动上架发布','批量维护'].includes(d.action)}
function inspector(id,d){
 const p=plugins[id];let body='';
 if(d.step===0)body=field('action','子功能',select('action',p.actions.split(' '),d.action))+field('source',id==='ops'?'店铺名称':'输入来源',input('source',d.source))+field('allowed','授权状态',select('allowed',['已授权','授权失效'],d.allowed?'已授权':'授权失效',d.allowed?'':' aria-invalid="true" aria-describedby="authWarning"'))+(!d.allowed?'<p id="authWarning" class="notice" data-tone="warning">授权失效。更新授权后才能继续，此次不扣积分。</p>':'');
 if(d.step===1)body=((id==='image'||id==='video')?field('platform','目标平台',select('platform',['淘宝','拼多多','抖店'],d.platform||'淘宝')):'')+field('option',p.option,select('option',p.choices,d.option))+field('prompt','调整要求','<textarea id="f-prompt" data-field="prompt" placeholder="输入需要保留或调整的内容">'+safe(d.prompt)+'</textarea>')+'<p class="notice">返回上一步会保留本次输入。</p>';
 if(d.step===2)body='<div class="metric"><b>'+safe(d.action)+'</b><br>'+safe(d.source)+'<br>'+safe(d.option)+((id==='image'||id==='video')?' · '+safe(d.platform||'淘宝'):'')+'</div>'+field('scenario','演练结果',select('scenario',['成功','失败'],d.scenario))+(changesShop(id,d)?'<label class="checkline"><input type="checkbox" data-field="confirmed" '+(d.confirmed?'checked':'')+'> 已核对目标店铺与商品变更</label>':'')+'<p class="muted">仅演练界面状态，不产生费用或外部操作。</p>';
 return '<div class="card"><div class="panelhead"><strong>任务参数</strong><span class="minor">'+(d.step+1)+' / 3</span></div><div class="sidepad"><ol class="steps" aria-label="工作流进度">'+p.fields.map((v,i)=>'<li '+(i===d.step?'aria-current="step"':'')+'>'+v+'</li>').join('')+'</ol>'+body+(d.step===2?'<div class="quote">本地演练 · 0 积分</div>':'')+'<div class="buttons">'+(d.step?button('back','返回','plain'):'')+(d.step<2?button('next','下一步 →','primary'):button('run',id==='ops'?'确认演练':'提交演练','primary'))+'</div></div></div>';
}
function conversation(id,d){
 return '<div class="card"><div class="panelhead"><strong>任务对话</strong><span class="minor">共享当前草稿</span></div><div class="chatbox"><p class="muted">可连续补充要求，切回工作流后在「调整要求」中核对。</p>'+d.chat.map(m=>'<div class="bubble">'+safe(m)+'</div>').join('')+field('chatInput','补充要求','<textarea id="f-chatInput" data-field="chatInput" placeholder="例如：保留青绿色罐身">'+safe(d.chatInput)+'</textarea>')+button('say','加入草稿','primary')+' '+button('flow','核对参数','plain')+'</div></div>';
}
function studio(id){
 const p=plugins[id],d=draft(id);const modes='<div class="modes" role="group" aria-label="操作方式">'+['flow','chat'].map((m,i)=>button(m,['分步工作流','对话模式'][i],'tab '+(d.mode===m?'sel':''))).join('')+'</div>';
 return title(p.name,p.sub,modes)+'<div class="workspace"><section class="card"><div class="panelhead"><strong>'+p.preview+'</strong><span class="minor">'+(id==='image'?'ARTBOARD 01':'青屿上新项目')+'</span></div>'+preview(id,d)+'</section>'+(d.mode==='flow'?inspector(id,d):conversation(id,d))+'</div><div class="sectiontitle"><h2>本插件任务</h2>'+button('all','查看全部 →')+'</div><section class="card">'+taskRows(state.records.filter(r=>r.id===id).slice(0,3))+'</section>';
}
function manager(){
 const business=state.category==='业务插件';
 const icons={image:'photo',video:'film',service:'folder',ops:'store',copy:'layout'};
 const list=business?Object.entries(plugins).map(([key,p])=>[key,p.name,p.sub]):toolsCatalog.map(name=>[
  name,name,name==='语音输入'?'输入设备、识别语言与服务可分别配置。':'内置工具，随工作区加载。'
 ]);
 const tabs=['业务插件','内置工具'].map(category=>'<button class="pill '+(category===state.category?'sel':'')+
  '" data-category="'+category+'" aria-pressed="'+(category===state.category)+'">'+category+' · '+(category==='业务插件'?Object.keys(plugins).length:toolsCatalog.length)+'</button>');
 const cards=list.map(([key,name,description])=>{
  const disabled=state.disabled.has(key);
  const open=business&&!disabled?'<button class="smallbtn plugin-open" data-nav="'+key+'">打开</button>':'';
  const details=business?'<button class="smallbtn" data-plugin-info="'+key+'">插件详情</button>':'';
  const settings=key==='语音输入'&&!disabled?button('voice','配置','smallbtn plugin-open'):'';
  const toggle='<button class="smallbtn" data-toggle="'+key+'">'+(disabled?'启用':'停用')+'</button>';
  return '<section class="card plugin"><div class="pluginHead"><div class="tileIcon">'+glyph(icons[key]||'plugin')+'</div>'+
   statusTag(disabled?'已停用':'已启用',disabled?'neutral':'success')+'</div><h3>'+name+'</h3><p>'+description+
   '</p><div class="buttons">'+open+settings+details+toggle+'</div></section>';
 });
 return title('插件管理','宿主管理工具和业务插件，启停后创作入口与工具库立即更新。')+
  '<div class="tabs" role="group" aria-label="插件类别">'+tabs.join('')+'</div><div class="library">'+cards.join('')+'</div>';
}
function home(){
 const roles=['企业管理员','企业成员','个人用户','代理用户'];
 const unread=ownRows(hubState.messages).filter(m=>!m.read).length;
 return title('工作区总览','按当前身份管理项目、资料和工作区服务。', '<button data-nav="welcome" class="plain">首次使用</button>')+
 '<div class="guideBar"><div><b>'+safe(state.role)+'</b><small>青屿工作区</small></div>'+field('role','审查身份',select('role',roles,state.role))+
 '<button class="plain" data-nav="inbox">消息中心'+(unread?' · '+unread:'')+'</button></div>'+
 '<div class="sectiontitle"><h2>工作区服务</h2></div>'+hubLinks(['projects','resources','team','assistant','partner','inbox','settings'])+
 '<div class="sectiontitle"><h2>已启用的业务插件</h2><button class="smallbtn" data-nav="manager">管理插件</button></div><div class="library">'+
 (Object.entries(plugins).filter(([k])=>!state.disabled.has(k)).map(([k,p])=>'<section class="card plugin"><h3>'+p.name+'</h3><p>'+p.sub+'</p><button class="smallbtn" data-nav="'+k+'">进入工作室 →</button></section>').join('')||'<p class="notice">当前业务插件均已停用，可在插件管理中启用。</p>')+'</div>';
}
function render(){
 const focused=document.activeElement;
 const focusKey=focused?.tagName==='BUTTON'?Object.entries(focused.dataset).find(([key])=>!['id','value'].includes(key)):null;
 const focusId=focused?.id;
 nav();const p=state.page;
 byId('queueLink').setAttribute('aria-current',p==='tasks'?'page':'false');
 const profile=document.querySelector('.profile');
 profile.querySelector('small').textContent=state.role;
 profile.setAttribute('aria-current',p==='home'?'page':'false');
 document.body.dataset.page=p;
 byId('crumb').innerHTML=glyph('grid')+'<button class="crumbHome" data-nav="home">青屿工作区</button><i>／</i><b>'+safe(hubCatalog[p]?.[0]||plugins[p]?.name||entryByPage(p)?.name||other[p]?.[0]||'工作台')+'</b>';
 byId('main').innerHTML=(p==='desk'||entryByPage(p))?renderDeskPage(p):hubCatalog[p]?hubPage(p):p==='account'?servicePage():p==='create'?creativeHome():p==='library'?toolbox():p==='assets'?assetShelf():plugins[p]?studio(p):p==='manager'?manager():p==='home'?home():title('任务记录','当前页面会话的演练任务，按最近提交排序。')+'<div class="card">'+taskRows(state.records)+'</div>';
 DeskFloat.restore();StudioGlass.schedule();
 if(focused && !focused.isConnected){
   let replacement=focusId && byId(focusId);
   if(!replacement && focusKey){
     replacement=[...document.querySelectorAll('#main button,#nav button')].find(b=>b.dataset[focusKey[0]]===focusKey[1] &&
      ['id','value'].every(k=>b.dataset[k]===focused.dataset[k]));
   }
   replacement?.focus?.({preventScroll:true});
 }
}
function validPage(id){return Object.hasOwn(other,id)||Object.hasOwn(plugins,id)||Object.hasOwn(hubCatalog,id)||!!entryByPage(id);}
function go(id,writeHistory=true){
 if(!validPage(id))id='desk';
 const entry=entryByPage(id);
 if(state.disabled.has(id)||(entry&&!deskAvailable(entry))){toast('插件已停用，可在插件管理中启用');if(writeHistory)return;id='manager';}
 else if(entry?.cap){const d=draft(entry.kind);Object.assign(d,{action:entry.cap,step:0,mode:'flow',confirmed:false});id=entry.kind;}
 const target='#'+id;
 if(location.hash!==target){
   if(writeHistory)location.hash=id;else history.replaceState(null,'',target);
 }
 state.page=id;render();byId('main').focus({preventScroll:true});window.scrollTo(0,0);
}
window.addEventListener('hashchange',()=>{const id=location.hash.slice(1)||'desk';if(id!==state.page)go(id,false);});
function modal(html){
 const dialog=byId('modal'),content=byId('modalContent'),title=byId('modalTitle');
 byId('modalFeedback').textContent='';
 content.innerHTML=html;
 const heading=content.querySelector('h2');
 title.textContent=heading?.textContent||'工作区对话框';
 heading?.remove();
 dialog.showModal();
 (content.querySelector('input:not([type=hidden]), select, textarea')||title).focus({preventScroll:true});
}
function run(){
 const d=current(),id=state.page;
 if(!d.source.trim()||!d.allowed||state.disabled.has(id)){toast('请先补全输入并核对授权');return}
 if(changesShop(id,d)&&!d.confirmed){toast('请先勾选并确认店铺与商品变更');return}
 const r={n:++state.seq,id,name:d.action,status:'处理中',note:d.prompt,src:d.source,asset:d.asset,scene:d.scene,scenario:d.scenario,option:d.option,platform:d.platform};
 r.owner=state.role;
 if(id==='ops')r.items=structuredClone(d.items||[]);
 if(id==='video')r.shots=d.shots.map((name,i)=>({镜头:name,秒数:d.durations[i]}));
 if(id==='copy')r.text=copyVersion(d).body;
 state.records.unshift(r);render();toast('演练任务已提交');
 setTimeout(()=>{r.status=r.scenario==='成功'?'成功':'失败';hubState.messages.unshift({id:++hubState.sequence,role:r.owner,text:r.name+' · '+r.status,page:'tasks',time:new Date().toLocaleTimeString('zh-CN'),read:false});if(['tasks','home','inbox',id,'desk-history'].includes(state.page))render();toast(r.status==='成功'?'演练完成，可打开任务详情':'演练失败，未扣积分，可查看原因')},900);
}
function action(cmd){
 if(cmd==='all'){go('tasks');return}
 if(cmd==='voice'){modal('<h2>语音输入设置</h2>'+Object.entries({device:['输入设备',['系统默认','USB 麦克风']],lang:['识别语言',['普通话','English']],engine:['识别服务',['企业配置的识别服务','本地可用服务']]}).map(([k,[label,opts]])=>field(k,label,select(k,opts,voice[k]))).join('')+'<p>'+button('saveVoice','保存设置','primary')+'</p>');return}
 if(cmd==='saveVoice'){for(const k of Object.keys(voice))voice[k]=byId('f-'+k).value;byId('modal').close();toast('语音设置已保存到本次演练');return}
 const d=current();
 if(cmd==='saveShot'){
   const i=d.shot??0,seconds=Number(document.querySelector('[data-clip-time]').value),text=byId('f-shotText').value.trim();
   if(!text||!Number.isInteger(seconds)||seconds<1||seconds>600){toast('请输入镜头说明和 1–600 的整数秒数');return;}
   d.shots[i]=text;d.durations[i]=seconds;delete d.shotEdits?.[i];toast('分镜说明已更新');
 }
 if(cmd==='handoff'){d.human=!d.human}
 if(cmd==='flow'||cmd==='chat'){d.mode=cmd}
 if(cmd==='next'){if(!d.allowed||!d.source.trim()){toast('请检查输入来源和授权状态');return}d.step=Math.min(2,d.step+1)}
 if(cmd==='back')d.step=Math.max(0,d.step-1);
 if(cmd==='say'){if(!d.chatInput.trim()){toast('请输入要求');return}d.chat.push(d.chatInput.trim());d.prompt=[d.prompt,d.chatInput.trim()].filter(Boolean).join('\n');d.chatInput='';toast('已写入工作流草稿')}
 if(cmd==='run'){run();return}render();
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;const v=b.dataset;
 if(v.shot!==undefined){const d=current();d.shot=Number(v.shot);render();return}
 if(v.nav){go(v.nav);return}if(v.do){action(v.do);return}if(v.color!==undefined){current().style=Number(v.color);render();return}
 if(v.category){state.category=v.category;render();return}
 if(v.pluginInfo){const plugin=plugins[v.pluginInfo],labels={image:'读取所选图片、导出视觉制作清单',video:'读取参考素材、导出分镜单',copy:'读取当前商品事实、导出编辑正文',service:'读取会话资料、记录接待草稿',ops:'读取已选店铺、人工核对商品变更'};modal('<h2>'+plugin.name+'</h2><p>'+plugin.sub+'</p><div class="metric">'+safe(labels[v.pluginInfo])+'</div><p class="muted">注册能力</p><div class="tags inner">'+plugin.actions.split(' ').map(deskTag).join('')+'</div>');return;}
 if(v.toggle){if(recoverPlugins){toast('请先在设置与诊断中退出安全模式');return;}if(state.disabled.has(v.toggle))state.disabled.delete(v.toggle);else state.disabled.add(v.toggle);render();return}
 if(v.record){const r=state.records.find(x=>x.n===Number(v.record));modal('<h2>'+safe(r.name)+'</h2><p>'+safe(r.src)+' · '+safe(r.option)+'</p><p>'+safe(r.note)+'</p><p class="notice">'+(r.status==='失败'?'示例错误：服务超时。额度已释放。':r.status==='成功'?'演练成功。交付格式为 '+plugins[r.id].output+'。':'正在处理演练任务。')+'</p>'+(r.items?'<p class="resourceBody">'+r.items.map(x=>safe(x.name+' · '+x.status+' → '+x.target)).join('<br>')+'</p>':r.shots?'<p class="resourceBody">'+r.shots.map(x=>safe(x.镜头+' · '+x.秒数+' 秒')).join('<br>')+'</p>':r.text?'<p class="resourceBody">'+safe(r.text)+'</p>':'')+(r.status==='失败'?'<button class="smallbtn" data-retry="'+r.n+'">返回参数重试</button>':''));return}
 if(v.retry){const r=state.records.find(x=>x.n===Number(v.retry));byId('modal').close();if(!state.disabled.has(r.id)){const d=draft(r.id);if(r.items)d.items=structuredClone(r.items);if(r.shots){d.shots=r.shots.map(x=>x.镜头);d.durations=r.shots.map(x=>x.秒数);d.shotEdits={};}if(r.text!==undefined)copyVersion(Object.assign(d,{option:r.option})).body=r.text;Object.assign(d,{source:r.src,asset:r.asset,scene:r.scene,platform:r.platform,option:r.option,prompt:r.note,action:r.name,scenario:'成功',step:2,mode:'flow',confirmed:false})}go(r.id)}
});
document.addEventListener('keydown',event=>{
 const region=event.target;
 if(!region.matches?.('.ui-table-scroll') || region.scrollWidth<=region.clientWidth)return;
 const direction={ArrowLeft:-1,ArrowRight:1}[event.key];
 if(!direction)return;
 event.preventDefault();
 region.scrollLeft+=direction*48;
});
document.addEventListener('input',e=>{const k=e.target.dataset.field;if(!k||byId('modal').open)return;if(k==='role'){state.role=e.target.value;render();return}if(!plugins[state.page])return;const d=current();if(k==='shotText'){const i=d.shot??0;((d.shotEdits??={})[i]??={}).text=e.target.value;return;}d[k]=k==='allowed'?e.target.value==='已授权':k==='confirmed'?e.target.checked:e.target.value;if(k!=='confirmed')d.confirmed=false;if(['allowed','option','action'].includes(k))render()});
byId('queueLink').onclick=()=>go('tasks');go(location.hash.slice(1)||'desk',false);
