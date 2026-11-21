import { date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, result, retryKey, select, textarea, toast } from './live.js';

const root='/v1/rights/notices';
const states={
  submitted:'待转送',forwarded:'已转送',restricted:'素材受限',counter_received:'收到反通知',
  counter_forwarded:'反通知已转送',upheld:'维持限制',restored:'已解除本案限制',dismissed:'已驳回',
};
export const rightsActions={
  forward:'转送通知',restrict:'限制素材访问',counter:'提交反通知','forward-counter':'转送反通知',
  uphold:'维持限制',restore:'解除本案限制',dismiss:'驳回通知',
};
const managerActions={
  submitted:['forward','dismiss'],forwarded:['restrict','dismiss'],
  restricted:['uphold','restore'],counter_received:['forward-counter'],
  counter_forwarded:['uphold','restore'],upheld:['restore'],
};
const uuidPattern='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export async function rightsPage(ctx) {
  const [id,assetId]=ctx.args;
  if (id==='new') return submitNotice(ctx,assetId);
  if (id) return noticeDetail(ctx,id);
  const notices=await ctx.all(root);
  ctx.html(heading('权利通知') + link('提交权利通知','rights/new') +
    panel('案件',list(notices,entry=>item(entry.id,
      (states[entry.state] ?? entry.state)+' · '+date(entry.updatedAt),link('查看案件','rights/'+entry.id)))));
}

function submitNotice(ctx,assetId='') {
  const key=retryKey();
  ctx.html(heading('提交权利通知') + link('返回权利通知','rights') +
    panel('通知内容',form('rights-submit',
      field('素材编号',input('assetId','required pattern="'+uuidPattern+'" value="'+h(assetId)+'"')) +
      field('通知说明',textarea('statement','required maxlength="3000"')) +
      field('证据编号或引用',textarea('evidenceReference','required maxlength="800"')),'提交通知')));
  ctx.submit('rights-submit',async data=>{
    const body=Object.fromEntries([...data].map(([key,value])=>[key,value.trim()]));
    const saved=await ctx.api(root,{method:'POST',body:{...body,id:key(body)}});
    toast('权利通知已提交');
    ctx.go('rights/'+saved.id);
  });
}

async function noticeDetail(ctx,id) {
  const target=root+'/'+path(id);
  const {notice:record,events}=await ctx.api(target);
  const actions=ctx.manager?[...(managerActions[record.state] ?? [])]:[];
  if (record.state==='restricted' && (record.affectsMyAsset || record.affectedId===ctx.account.id)) actions.push('counter');
  const controls=actions.length?panel('案件处理',form('rights-action',
    field('处理操作',select('action',actions.map(key=>[key,rightsActions[key]]))) +
    field('处理说明',textarea('explanation','required maxlength="3000"')),'提交处理')):'';
  ctx.html(heading('权利通知详情',states[record.state] ?? record.state) + link('返回权利通知','rights') +
    grid(panel('通知内容',item(record.id,'版本 '+record.revision+' · '+date(record.createdAt),
      '<dl class="live-facts"><dt>素材编号</dt><dd>'+h(record.assetId)+'</dd><dt>证据编号或引用</dt><dd>'+
      h(record.evidenceReference)+'</dd></dl>'+result(record.statement))),controls) +
    panel('处理记录',list(events,event=>item(rightsActions[event.action] ?? event.action,date(event.createdAt),result(event.explanation)),
      '此案件暂无处理记录。')));
  const key=retryKey();
  ctx.submit('rights-action',async data=>{
    const action=data.get('action');
    const explanation=data.get('explanation').trim();
    if (['restrict','restore','uphold','dismiss'].includes(action) &&
        !confirm('确认'+rightsActions[action]+'？')) return;
    const body={action,explanation,revision:record.revision};
    const saved=await ctx.api(target+'/actions',{method:'POST',body:{...body,eventId:key(body)}});
    toast(states[saved.state] ?? '案件已更新');
    ctx.reload();
  });
}
