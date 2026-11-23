import { date, field, form, input, item, link, list, notice, path, select } from './live-ui.js';

export async function editContext(ctx, capability, args) {
  const follow = capability.id === 'model.chat' && ctx.args[0] === 'follow';
  const id = follow ? ctx.args[1] : args[2] === 'revise' ? args[3] : null;
  if (!id) return null;
  const url='/v1/tasks/'+path(id);
  const [source, previous]=await Promise.all([ctx.api(url+'/inputs'),ctx.api(url)]);
  if (source.capabilityId !== capability.id || ['queued','running'].includes(previous.state)) throw new Error('请选择同一能力的已结束任务。');
  let history=[];
  if (follow) {
    if (previous.state!=='succeeded' || !previous.result?.text) throw new Error('上一轮没有可继续的文字回复。');
    history=[...(source.parameters.messages??[]).filter(m=>m.role!=='system'),{role:'assistant',content:previous.result.text.slice(0,8000)}].slice(-30);
  }
  return {id,source,history,follow};
}

export function restoreInputs(formNode, edit) {
  if(!edit)return;
  const {source, follow}=edit;
  for(const control of formNode.elements) {
    const name=control.name;
    let value;
    if(name==='projectId'||name==='modelId'||name==='mode')value=source[name];
    else if(name==='stream')value=source.parameters.stream??false;
    else if(name==='conversation.system')value=source.parameters.messages?.find(m=>m.role==='system')?.content;
    else if(name==='conversation.user' && !follow)value=source.parameters.messages?.filter(m=>m.role==='user').at(-1)?.content;
    else if(name.startsWith('params.'))value=name.slice(7).split('.').reduce((obj,k)=>obj?.[k],source.parameters);
    if(value==null)continue;
    if(control.type==='checkbox')control.checked=Boolean(value);
    else if(control.multiple)for(const option of control.options)option.selected=Array.isArray(value)&&value.includes(option.value);
    else if(control.tagName==='SELECT') { if([...control.options].some(o=>o.value===String(value)))control.value=value; }
    else control.value=Array.isArray(value)?(value.some(x=>typeof x==='object')?JSON.stringify(value,null,2):value.join('\n')):value;
  }
}
export function editSummary(edit) {
  if(!edit)return '';
  return '<div class="live-row">'+link('查看原任务','tasks/'+edit.id)+notice(edit.follow?'继续对话将带入上轮消息。':'已带入原参数。提交后创建一条新的关联任务。')+'</div>'+
    (edit.follow?'<details class="live-fold"><summary>本次带入的消息</summary>'+edit.history.map(m=>item(m.role==='user'?'用户':'助手','',notice(m.content))).join('')+'</details>':'');
}
export function journalPanel() {
  return '<details class="live-fold"><summary>查询执行日志</summary>'+form('journal',field('级别',select('level',[['','全部'],['info','信息'],['warn','警告'],['error','错误']]))+
    field('从',input('from','type="datetime-local"'))+field('至',input('to','type="datetime-local"')),'查询日志')+
    '<div data-journal-results aria-live="polite"></div></details>';
}
export function bindJournal(ctx, endpoint) {
  ctx.submit('journal',async data=>{
    const query=new URLSearchParams();
    if(data.get('level'))query.set('level',data.get('level'));
    for(const key of ['from','to'])if(data.get(key))query.set(key,new Date(data.get(key)).toISOString());
    if(query.get('from') && query.get('to') && query.get('from')>query.get('to'))throw new Error('开始时间不能晚于结束时间。');
    const rows=await ctx.all(endpoint+'/events?'+query);
    if(ctx.active())document.querySelector('[data-journal-results]').innerHTML=list(rows,r=>item(r.event+' · '+r.level,date(r.createdAt)+' · 尝试 '+r.attempt+(r.errorCode?' · '+r.errorCode:'')),'没有符合条件的日志。');
  });
}
