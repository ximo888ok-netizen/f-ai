let planTimer;
let storeMode='本地文件';
let recoverPlugins=null;
function assistantPage(){
 const rows=ownRows(hubState.plans);
 return title('助手与计划','在当前会话到点提醒，或手动运行一次。',hubButton('new-plan','创建计划','primary'))+
 draftPanel('项目提醒',rows.map(p=>hubRow(p.name,new Date(p.when).toLocaleString('zh-CN')+' · '+(p.done?'已完成':'待提醒'),
 p.done?hubButton('to-inbox','查看消息','smallbtn'):hubButton('run-plan','立即提醒','smallbtn',p.id)+hubButton('cancel-plan','取消计划','smallbtn',p.id))).join('')||
 hubNotice('创建一个有具体时间的提醒。页面保持打开时，到期的消息会进入消息中心。'));
}
function inboxPage(){
 const rows=ownRows(hubState.messages);
 return title('消息中心','任务、提醒与成员变更保留在当前会话。',rows.some(m=>!m.read)?hubButton('read-all','全部标为已读'):'')+
 draftPanel('工作区消息',rows.map(m=>hubRow(m.text,m.time+' · '+(m.read?'已读':'未读'),hubButton('open-message','查看','smallbtn',m.id))).join('')||hubNotice('当前没有消息。完成一次插件任务或创建一个提醒后，可以回到这里查看。'));
}
function runPlan(p) {
 if(p.done)return;
 p.done=true;
 hubState.messages.unshift({id:++hubState.sequence,role:p.role,text:'项目提醒 · '+p.name,page:'assistant',time:new Date().toLocaleTimeString('zh-CN'),read:false});
 if(p.role===state.role && hubState.notifications)toast('项目提醒 · '+p.name);
}
function schedulePlans() {
 clearTimeout(planTimer);
 const pending=hubState.plans.filter(p=>!p.done);
 if(!pending.length)return;
 const next=Math.min(...pending.map(p=>Date.parse(p.when)));
 planTimer=setTimeout(()=>{
   const due=pending.filter(p=>Date.parse(p.when)<=Date.now());
   due.forEach(runPlan);
   if(due.length && ['inbox','assistant','home'].includes(state.page))render();
   schedulePlans();
 },Math.min(2147483647,Math.max(0,next-Date.now())));
}
function settingsPage(){
 const prefs='<label class="checkline"><input id="hubNotify" type="checkbox" '+(hubState.notifications?'checked':'')+'> 显示计划提醒浮层</label>'+
 '<label for="hubStore">交付偏好</label><select id="hubStore">'+selectOpts(['本地文件','导出后手动归档'],storeMode)+'</select>'+
 '<p class="muted spaceTop">外观动效可在顶栏暂停。导出的文件由浏览器保存。</p>';
 const checks=hubState.checks.map(([k,v])=>hubRow(k,v)).join('');
 return title('设置与诊断',hubCatalog.settings[2])+'<div class="deskSplit">'+draftPanel('工作区偏好',prefs)+
 draftPanel('宿主自检',hubButton('check','运行自检')+checks)+'</div><div class="spaceTop">'+draftPanel('插件恢复',
 '<p class="muted">安全模式会暂时停用可选插件，保留设置与插件管理入口。</p><div class="buttons spaceTop">'+
 (recoverPlugins?hubButton('restore','恢复原有启用状态','primary'):hubButton('safe','进入安全模式'))+
 '<button class="plain" data-nav="manager">插件管理</button></div>')+'</div>';
}
function partnerPage(){
 const orders=ownRows(hubState.orders).filter(o=>o.month===hubState.month);
 const total=orders.reduce((sum,o)=>sum+o.commission,0);
 return title('代理结算','按归属层级查看订单与本地结算草案。',hubButton('new-order','登记订单','primary'))+
 '<div class="deskSplit">'+draftPanel('结算周期','<label for="settleMonth">月份</label><input type="month" id="settleMonth" value="'+safe(hubState.month)+'"><div class="resultItem spaceTop"><small>预计佣金</small><strong>¥ '+(total/100).toFixed(2)+'</strong></div>')+
 draftPanel('订单明细',orders.map(o=>hubRow(o.name,o.level+' · ¥ '+(o.sales/100).toFixed(2)+' × '+o.rate+'%','<b>¥ '+(o.commission/100).toFixed(2)+'</b>')).join('')+
 (orders.length?hubButton('export-orders','导出结算明细'):hubNotice('当前月份尚未登记订单。')))+'</div>';
}
function saveSystemForm(type,data){
 if(type==='plan'){
   if(!Number.isFinite(Date.parse(data.when))||Date.parse(data.when)<=Date.now()){toast('请选择将来的提醒时间');return false;}
   hubState.plans.unshift({...data,role:state.role,id:++hubState.sequence,done:false});schedulePlans();return true;
 }
 if(type==='order'&&state.role==='代理用户'){
   const sales=Math.round(Number(data.sales)*100),rate=Number(data.rate);
   if(!Number.isSafeInteger(sales)||sales<=0||!Number.isFinite(rate)||rate<0||rate>100){toast('请输入正数订单金额以及 0–100% 的比例');return false;}
   hubState.orders.unshift({...data,sales,rate,commission:Math.round(sales*rate/100),month:hubState.month,role:state.role});return true;
 }
 return false;
}
document.addEventListener('change',e=>{
 if(e.target.id==='hubNotify')hubState.notifications=e.target.checked;
 if(e.target.id==='hubStore')storeMode=e.target.value;
 if(e.target.id==='settleMonth'&&e.target.value){hubState.month=e.target.value;render();}
});
document.addEventListener('click',e=>{
 const b=e.target.closest('[data-hub-action]');if(!b)return;
 const key=b.dataset.hubAction,id=Number(b.dataset.id);
 if(key==='new-plan')return hubForm('plan','创建项目提醒',hubField('name','提醒事项')+hubField('when','提醒时间','','datetime-local'));
 if(key==='run-plan'||key==='cancel-plan'){
   const p=ownRows(hubState.plans).find(p=>p.id===id);if(!p)return;
   if(key==='run-plan')runPlan(p);else hubState.plans=hubState.plans.filter(row=>row!==p);
   schedulePlans();render();return;
 }
 if(key==='to-inbox'){go('inbox');return;}
 if(key==='read-all'){ownRows(hubState.messages).forEach(m=>m.read=true);render();return;}
 if(key==='open-message'){
   const msg=ownRows(hubState.messages).find(m=>m.id===id);if(msg){msg.read=true;go(msg.page);}return;
 }
 if(key==='check'){
   hubState.checks=[['业务插件',Object.keys(plugins).filter(id=>!state.disabled.has(id)).length+' / '+Object.keys(plugins).length+' 已启用'],
   ['本地文件',typeof FileReader==='function'&&typeof Blob==='function'?'可用':'当前浏览器未提供'],['对话框',typeof HTMLDialogElement==='function'?'可用':'当前浏览器未提供']];
   render();return;
 }
 if(key==='safe'){recoverPlugins=new Set(state.disabled);[...Object.keys(plugins),...toolsCatalog].forEach(id=>state.disabled.add(id));render();return;}
 if(key==='restore'&&recoverPlugins){state.disabled=recoverPlugins;recoverPlugins=null;render();return;}
 if(state.role!=='代理用户')return;
 if(key==='new-order')hubForm('order','登记代理订单',hubField('name','订单备注')+
 hubField('level','关系层级','直接',['直接','二级'])+'<label>销售额（元）<input required name="sales" type="number" min=".01" max="999999999" step=".01"></label><label>佣金比例（%）<input required name="rate" type="number" min="0" max="100" step=".01"></label>');
 if(key==='export-orders')fileDownload('代理结算-'+hubState.month+'.json',{月份:hubState.month,订单:ownRows(hubState.orders).filter(o=>o.month===hubState.month).map(o=>({订单:o.name,层级:o.level,销售额:o.sales/100,佣金比例:o.rate,佣金:o.commission/100}))});
});
