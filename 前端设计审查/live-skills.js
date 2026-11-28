import { confirmDialog } from './live-ui.js';
import { action, field, form, grid, h, heading, input, item, link, list, notice, panel, path, result, retryKey, select, textarea, toast } from './live.js';

const root='/v1/library';
const actions={
  'copy-review':'文案措辞检查','sku-review':'商品 SKU 核对','model-chat':'模型对话',
};
const options=Object.entries(actions);
const actionOf=entry=>entry.skillAction ?? 'model-chat';

function editor(entry={}) {
  return field('技能名称',input('name','required maxlength="100" value="'+h(entry.name)+'"')) +
    field('技能说明',textarea('description','maxlength="500"',entry.description)) +
    field('执行方式',select('skillAction',options,actionOf(entry))) +
    field('执行说明或模型指令',textarea('instructions','required maxlength="2000"',entry.instructions));
}

function definition(data) {
  return {name:data.get('name').trim(),description:data.get('description').trim(),instructions:data.get('instructions').trim(),
    relatedIds:[],skillAction:data.get('skillAction')};
}

export async function skillsPage(ctx) {
  const [id]=ctx.args;
  if (id==='new' && ctx.manager) {
    ctx.html(heading('新增技能') + link('返回技能运行','skills') + panel('技能设置',form('skill-create',editor(),'创建技能')));
    ctx.submit('skill-create',async data=>{
      const saved=await ctx.api(root,{method:'POST',body:{kind:'skill',...definition(data)}});
      ctx.go('skills/'+saved.id);
    });
    return;
  }
  if (id) {await details(ctx,id);return;}
  const entries=await ctx.all(root+'?kind=skill');
  ctx.html(heading('技能运行') + '<div class="live-row">'+link('平台文案校验','copy-review')+
    (ctx.manager?link('新增技能','skills/new'):'')+'</div>' +
    panel('工作区技能',list(entries,entry=>item(entry.name,
      actions[actionOf(entry)]+' · '+(entry.enabled?'可运行':'已停用'),
      (entry.description?notice(entry.description):'')+link('打开技能','skills/'+entry.id)))));
}

async function runFields(ctx,kind) {
  if (kind==='sku-review') {
    const drafts=await ctx.all('/v1/studio/pinduoduo-drafts');
    return drafts.length
      ? form('skill-run',field('商品草稿',select('draftId',[['','选择草稿'],...drafts.map(draft=>[draft.id,draft.title])],
        undefined,'required')),'核对 SKU')
      : notice('请先保存一份商品草稿。')+link('打开商品草稿','drafts');
  }
  if (kind==='copy-review') {
    return form('skill-run',field('待审阅文案',textarea('content','required maxlength="8000"')),'审阅文案');
  }
  const {items:models}=await ctx.api('/v1/models?capabilityId=model.chat');
  if (!models.length) return notice('当前部署没有可执行模型技能的对话模型。');
  return form('skill-run',field('对话模型',select('modelId',models.map(model=>[model.id,model.id]))) +
    field('发送给模型的内容',textarea('content','required maxlength="8000"')),'提交模型技能');
}

function runResult(data) {
  if (data.action==='sku-review') {
    return notice(data.result.ready?'此次核对无缺项。':'请补齐以下规格信息。')+
      list(data.result.variants,variant=>item(variant.specification || '主规格',variant.sku || '未填写 SKU',
        notice(variant.missing.length?'缺少 '+variant.missing.join('、'):'资料齐全')))+
      link('打开商品草稿','drafts/'+data.result.draftId);
  }
  return list(data.result.matches,match=>item(match.term,'字符 '+match.start+'–'+match.end,
    notice('建议替换为 '+match.suggestion)),'未发现需审阅词语。')+
    '<h3>建议稿</h3>'+result(data.result.preview);
}

async function details(ctx,id) {
  const target=root+'/'+path(id);
  const entry=await ctx.api(target);
  if (entry.kind!=='skill') throw new Error('请选择可执行的技能。');
  const fields=entry.enabled?await runFields(ctx,actionOf(entry)):notice('此技能已停用。');
  const management=ctx.manager?panel('管理技能',
    action(entry.enabled?'停用技能':'启用技能','skill-state') +
    (entry.builtin?'':form('skill-update',editor(entry),'保存技能')+action('删除技能','skill-delete'))):'';
  ctx.html(heading(entry.name,entry.description) + link('返回技能运行','skills') +
    grid(panel(actions[actionOf(entry)],fields+'<div data-skill-result aria-live="polite"></div>'),management));
  const key=retryKey();
  ctx.submit('skill-run',async data=>{
    const body={revision:entry.revision,...Object.fromEntries(data)};
    if (actionOf(entry)==='model-chat') body.idempotencyKey=key(body);
    const response=await ctx.api(target+'/runs',{method:'POST',body});
    if (response.task) {ctx.go('tasks/'+response.task.id);return;}
    if (ctx.active()) document.querySelector('[data-skill-result]').innerHTML=runResult(response);
  });
  ctx.click('skill-state',async ()=>{
    await ctx.api(target+'/state',{method:'PUT',body:{enabled:!entry.enabled}});
    ctx.reload();
  });
  ctx.submit('skill-update',async data=>{
    await ctx.api(target,{method:'PUT',body:{...definition(data),revision:entry.revision}});
    toast('技能设置已保存');
    ctx.reload();
  });
  ctx.click('skill-delete',async ()=>{
    if (!await confirmDialog('确认操作', '删除这个自定义技能？')) return;
    await ctx.api(target,{method:'DELETE'});
    ctx.go('skills');
  });
}
