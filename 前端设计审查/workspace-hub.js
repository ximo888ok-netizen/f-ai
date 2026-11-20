/* Review data lives in the current local workspace session. */
const hubCatalog = {
 projects:['项目管理','folder','创建项目、关联成员，或归档结束的项目。'],
 team:['成员与邀请','shirt','管理本地成员、角色与待接受的邀请。'],
 resources:['知识与资料','layout','按范围检索知识、记忆、专家和技能。'],
 assistant:['助手与计划','spark','编排项目提醒，检查本地执行记录。'],
 inbox:['消息中心','film','查看本次会话的任务、提醒和成员变更。'],
 settings:['设置与诊断','plugin','配置工作区偏好，检查宿主与恢复插件。'],
 partner:['代理结算','store','按月份汇总代理订单和佣金，导出结算明细。'],
 welcome:['首次使用','sun','选择审查身份并进入工作区。']
};
const hubState = {
 sequence:0,projects:[],members:[],invites:[],resources:[],plans:[],messages:[],orders:[],
 filter:'进行中',resourceType:'知识',query:'',scope:'企业',notifications:true,checks:[],month:new Date().toLocaleDateString('sv-SE').slice(0,7)
};
function hubAllowed(page) {
 if(page==='team')return state.role==='企业管理员';
 if(page==='partner')return state.role==='代理用户';
 return true;
}
function hubLinks(ids) {
 return '<div class="hubGrid">'+ids.filter(hubAllowed).map(id=>{
   const [name,icon,desc]=hubCatalog[id];
   return '<button class="hubLink" data-nav="'+id+'"><span class="hubIcon">'+glyph(icon)+'</span><span><strong>'+name+'</strong><small>'+desc+'</small></span><i>↗</i></button>';
 }).join('')+'</div>';
}
function hubTabs(key,values,active) {
 return '<div class="hubTabs" role="group" aria-label="筛选">'+values.map(n=>'<button data-hub-tab="'+key+'" data-value="'+safe(n)+'" aria-pressed="'+(active===n)+'">'+safe(n)+'</button>').join('')+'</div>';
}
function hubButton(action,label,css='plain',id='') {
 return '<button type="button" data-hub-action="'+action+'" data-id="'+safe(id)+'" class="'+css+'">'+safe(label)+'</button>';
}
function hubForm(kind,heading,fields,id='') {
 modal('<form class="hubForm" data-hub-form="'+kind+'" data-id="'+safe(id)+'"><h2>'+safe(heading)+'</h2>'+fields+'<div class="buttons spaceTop"><button class="primary" type="submit">保存</button></div></form>');
}
function hubField(name,label,value='',options) {
 const control=Array.isArray(options)
   ? '<select name="'+name+'">'+selectOpts(options,value)+'</select>'
   : options==='textblock' ? '<textarea name="'+name+'" required maxlength="12000">'+safe(value)+'</textarea>'
   : '<input name="'+name+'" type="'+(options||'text')+'" required maxlength="160" value="'+safe(value)+'">';
 return '<label>'+label+control+'</label>';
}
function hubRow(name,detail,actions='') {
 return '<div class="hubRow"><div><strong>'+safe(name)+'</strong><small>'+safe(detail)+'</small></div><div class="buttons">'+actions+'</div></div>';
}
function hubNotice(text) { return '<p class="notice">'+safe(text)+'</p>'; }
function hubMessage(text,page) {
 hubState.messages.unshift({id:++hubState.sequence,text,page,read:false,time:new Date().toLocaleTimeString('zh-CN'),role:state.role});
}
function ownRows(rows){return rows.filter(r=>r.role===state.role);}
function projectPage(){
 const active=hubState.filter==='进行中';
 const rows=ownRows(hubState.projects).filter(p=>p.archived!==active);
 return title('项目管理',hubCatalog.projects[2],hubButton('new-project','新建项目','primary'))+
 hubTabs('filter',['进行中','已归档'],hubState.filter)+draftPanel('项目列表',rows.map(p=>hubRow(p.name,p.owner+' · '+(p.desc||'项目资料'),(active?hubButton('edit-project','编辑','smallbtn',p.id):'')+hubButton('archive',active?'归档':'恢复','smallbtn',p.id))).join('')||emptyState(active?'暂无进行中的项目':'暂无归档项目',active?'创建项目后，可填写目标并指定负责人。':'归档后的项目会显示在这里。'));
}
function teamPage(){
 const team=hubState.members.map(m=>hubRow(m.name,m.access,hubButton('role','调整角色','smallbtn',m.id))).join('');
 const pending=hubState.invites.filter(i=>!i.used);
 return title('成员与邀请','邀请在当前审查会话中流转。',hubButton('invite','创建邀请','primary'))+
 '<div class="deskSplit">'+draftPanel('工作区成员',hubRow('当前用户','企业管理员')+team)+draftPanel('待接受邀请',pending.map(i=>hubRow(i.name,i.access,hubButton('accept','演练接受邀请','smallbtn',i.id)+hubButton('revoke','撤回','smallbtn',i.id))).join('')||hubNotice('创建邀请后，可以在这里预览接受和撤回流程。'))+'</div>';
}
function resourceRows(){
 const list=ownRows(hubState.resources).filter(r=>r.kind===hubState.resourceType && r.scope===hubState.scope &&
   (r.name+' '+r.body).toLowerCase().includes(hubState.query.trim().toLowerCase()));
 return list.map(r=>hubRow(r.name,r.scope+' · '+r.body.slice(0,75),hubButton('open-resource','查看','smallbtn',r.id)+hubButton('edit-resource','编辑','smallbtn',r.id))).join('')||emptyState(hubState.query?'未找到匹配资料':'暂无资料',hubState.query?'试试更换关键词。':'添加一条资料后即可检索和编辑。');
}
function resourcePage(){
 const scopes=state.role.startsWith('企业')?['企业','个人']:['个人'];
 if(!scopes.includes(hubState.scope))hubState.scope=scopes[0];
 const bar='<div class="libbar">'+hubTabs('resourceType',['知识','记忆','专家','技能'],hubState.resourceType)+'<input type="search" id="hubSearch" aria-label="检索资料" placeholder="搜索标题或正文" value="'+safe(hubState.query)+'"></div>';
 return title('知识与资料',hubCatalog.resources[2],hubButton('new-resource','添加资料','primary'))+bar+
 '<div class="resourceScope">'+hubTabs('scope',scopes,hubState.scope)+'</div>'+draftPanel('资料列表','<div id="resourceRows">'+resourceRows()+'</div>');
}
function welcomePage(){
 return title('欢迎使用 F/AI Studio','在本地工作区试走一次从商品资料到交付的流程。')+
 '<div class="deskSplit">'+draftPanel('选择审查身份',field('role','工作区身份',select('role',['企业管理员','企业成员','个人用户','代理用户'],state.role))+
 '<div class="buttons spaceTop"><button class="primary" data-nav="home">进入工作区</button><button class="plain" data-nav="desk">打开生产工作台</button></div>')+
 draftPanel('第一次创作','<ol class="guideSteps"><li>进入商品视觉工作室，添加商品图或试用内置示例。</li><li>选择平台与画幅，核对插件中的素材和参数。</li><li>提交本地演练，打开任务记录检查结果。</li></ol><button class="plain" data-nav="create">前往创作台</button>')+'</div>';
}
function hubPage(id){
 if(!hubAllowed(id))return title('当前身份无法访问','可在工作区总览切换审查身份。','<button class="plain" data-nav="home">返回总览</button>');
 const pages={projects:projectPage,team:teamPage,resources:resourcePage,welcome:welcomePage,assistant:assistantPage,
   inbox:inboxPage,settings:settingsPage,partner:partnerPage};
 return pages[id]();
}
function projectForm(p) {
 const people=['当前用户',...hubState.members.map(m=>m.name)];
 hubForm('project',p?'编辑项目':'新建项目',hubField('name','项目名称',p?.name)+hubField('desc','项目目标',p?.desc,'textblock')+
   hubField('owner','负责人',p?.owner||people[0],state.role==='企业管理员'?people:['当前用户']),p?.id);
}
function resourceForm(r) {
 hubForm('resource',r?'编辑资料':'添加'+hubState.resourceType,hubField('name','标题',r?.name)+hubField('body','正文',r?.body,'textblock'),r?.id);
}
document.addEventListener('input',e=>{if(e.target.id==='hubSearch'){hubState.query=e.target.value;byId('resourceRows').innerHTML=resourceRows();}});
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.hubTab){hubState[b.dataset.hubTab]=b.dataset.value;render();return;}
 const key=b.dataset.hubAction,id=Number(b.dataset.id);
 if(!key)return;
 const p=ownRows(hubState.projects).find(p=>p.id===id),r=ownRows(hubState.resources).find(r=>r.id===id);
 if(key==='new-project'||(key==='edit-project'&&p&&!p.archived))return projectForm(p);
 if(key==='archive'&&p){p.archived=!p.archived;hubMessage((p.archived?'归档项目 · ':'恢复项目 · ')+p.name,'projects');render();return;}
 if(key==='new-resource'||(key==='edit-resource'&&r))return resourceForm(r);
 if(key==='open-resource'&&r)return modal('<h2>'+safe(r.name)+'</h2><p class="muted">'+safe(r.scope+' · '+r.kind)+'</p><p class="resourceBody">'+safe(r.body)+'</p>');
 if(state.role!=='企业管理员')return;
 if(key==='invite')return hubForm('invite','创建本地邀请',hubField('name','成员名称')+hubField('access','加入角色','企业成员',['企业成员','企业管理员']));
 const invite=hubState.invites.find(x=>x.id===id&&!x.used);
 if(invite && (key==='accept'||key==='revoke')){
   invite.used=true;if(key==='accept')hubState.members.push({id:invite.id,name:invite.name,access:invite.access});
   hubMessage((key==='accept'?'已加入 · ':'已撤回邀请 · ')+invite.name,'team');render();
 }
 const member=hubState.members.find(x=>x.id===id);
 if(key==='role'&&member)hubForm('role','调整 '+member.name+' 的角色',hubField('access','成员角色',member.access,['企业成员','企业管理员']),id);
});
document.addEventListener('submit',e=>{
 const form=e.target.closest('[data-hub-form]');if(!form)return;e.preventDefault();
 const type=form.dataset.hubForm,id=Number(form.dataset.id);
 const data=Object.fromEntries([...new FormData(form)].map(([k,v])=>[k,String(v).trim()]));
 if(Object.values(data).some(v=>!v)){toast('请补全必填字段');return;}
 if(type==='project'||type==='resource'){
   const project=type==='project',list=project?hubState.projects:hubState.resources;
   const row=id?ownRows(list).find(r=>r.id===id):null;
   if(id&&!row)return;
   if(row)Object.assign(row,data);
   else list.unshift({...data,id:++hubState.sequence,role:state.role,...(project?{archived:false}:{kind:hubState.resourceType,scope:hubState.scope})});
   if(project)hubState.filter='进行中';
 }else if(type==='invite'&&state.role==='企业管理员'){
   if(hubState.members.some(m=>m.name===data.name)||hubState.invites.some(i=>i.name===data.name&&!i.used)){toast('该成员已加入或已有待接受邀请');return;}
   hubState.invites.push({...data,id:++hubState.sequence,used:false});
 }else if(type==='role'&&state.role==='企业管理员'){
   const m=hubState.members.find(m=>m.id===id);if(!m)return;m.access=data.access;
 }else if(!saveSystemForm(type,data))return;
 byId('modal').close();render();toast('已保存到当前工作区会话');
});
