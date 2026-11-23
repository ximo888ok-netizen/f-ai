import { action, field, form, grid, h, heading, input, item, link, list, notice, panel, path, select, textarea } from './live-ui.js';

const root='/v1/library';
const kinds={expert:'专家',team:'专家团'};
const base='library/experts';
function fields(entry, related) {
  const options=related.map(r=>[r.id,r.name+(r.enabled?'':'（已停用）')]);
  return field('名称',input('name','required maxlength="100" value="'+h(entry.name)+'"'))+
    field('行业与场景',textarea('description','maxlength="500"',entry.description))+
    field('角色和工作要求',textarea('instructions','required maxlength="2000"',entry.instructions))+
    field(entry.kind==='team'?'成员专家（最多六位）':'挂载技能（最多六个）',select('relatedIds',options,entry.relatedIds,'multiple'+(entry.kind==='team'?' required':'')));
}
function definition(data) {
  const relatedIds=data.getAll('relatedIds');
  if(relatedIds.length>6)throw new Error('最多选择六个关联条目。');
  return {name:data.get('name'),description:data.get('description'),instructions:data.get('instructions'),relatedIds};
}
export async function experts(ctx) {
  const [,id,arg]=ctx.args;
  const entries=await ctx.all(root);
  if(!id || id==='search'){
    const q=arg?decodeURIComponent(arg):'';
    const groups=Object.keys(kinds).map(kind=>panel(kinds[kind],list(entries.filter(e=>e.kind===kind &&
      (e.name+' '+e.description).toLowerCase().includes(q.toLowerCase())),e=>item(e.name,e.description,
      notice(e.enabled?'已启用':'已停用')+link('详情',base+'/'+e.id)), '没有匹配的条目。')));
    ctx.html(heading('专家与专家团')+link('返回工具库','library')+
      (ctx.manager?'<div class="live-row">'+link('新建专家',base+'/new/expert')+link('组建专家团',base+'/new/team')+'</div>':'')+
      form('expert-search',field('搜索名称或场景',input('q','type="search" maxlength="100" value="'+h(q)+'"')),'搜索')+grid(...groups));
    ctx.submit('expert-search',async data=>ctx.go(base+'/search/'+path(data.get('q').trim())));
    return;
  }
  const fresh=id==='new';
  const entry=fresh?{kind:arg,name:'',description:'',instructions:'',relatedIds:[]}:entries.find(e=>e.id===id);
  if(!entry || !Object.hasOwn(kinds,entry.kind) || (fresh && !ctx.manager))throw new Error('当前工作区无法访问该定义。');
  const related=entries.filter(e=>e.kind===(entry.kind==='team'?'expert':'skill'));
  const updatable=ctx.manager&&!entry.builtin;
  ctx.html(heading(fresh?'新建'+kinds[entry.kind]:entry.name)+link('返回专家库',base)+
    (!fresh?panel('工作要求',notice(entry.instructions)+list(related.filter(e=>entry.relatedIds.includes(e.id)),e=>item(e.name,kinds[e.kind]??'技能'),'无关联条目。')+
      (entry.enabled?link('带入模型对话','models/expert/'+entry.id):notice('当前已停用。'))+
      (ctx.manager?action(entry.enabled?'停用':'启用','expert-state'):'') ):'')+
    (updatable?panel('定义',form('expert-edit',fields(entry,related),'保存')+(!fresh?action('删除自定义定义','expert-delete'):'')):''));
  if(updatable)ctx.submit('expert-edit',async data=>{
    const body=definition(data);
    const saved=await ctx.api(fresh?root:root+'/'+path(id),{method:fresh?'POST':'PUT',body:fresh?{kind:entry.kind,...body}:{...body,revision:entry.revision}});
    ctx.go(base+'/'+saved.id);
  });
  if(!fresh && ctx.manager)ctx.click('expert-state',async()=>{await ctx.api(root+'/'+path(id)+'/state',{method:'PUT',body:{enabled:!entry.enabled}});ctx.reload();});
  if(!fresh && updatable)ctx.click('expert-delete',async()=>{if(confirm('删除这个自定义定义？')){await ctx.api(root+'/'+path(id),{method:'DELETE'});ctx.go(base);}});
}
