import { field, form, heading, input, link, notice, panel, path } from './live-ui.js';

export async function memberCreditLimit(ctx, id) {
  const endpoint='/v1/credits/members/'+path(id)+'/limit';
  const [value, members]=await Promise.all([ctx.api(endpoint),ctx.all('/v1/members')]);
  const member=members.find(m=>m.id===id);
  if(!member)throw new Error('成员已不存在。');
  const editable=member.role!=='owner' && (ctx.workspace.role==='owner' || member.role!=='admin');
  ctx.html(heading(member.displayName+'的任务额度',member.email)+link('返回企业成员','members')+
    panel('累计消费额度',notice('已消费 '+value.spent+' 积分 · 执行中预占 '+value.reserved+' 积分')+
      notice(value.limit===null?'当前没有累计额度限制。':'当前上限为 '+value.limit+' 积分。')+
      (editable?form('member-limit',field('累计上限（留空解除限制）',input('limit','type="number" min="0" max="1000000000" step="1" value="'+(value.limit??'')+'"')),'保存额度'):'')));
  if(editable)ctx.form('member-limit',async data=>{
    const raw=data.get('limit');await ctx.api(endpoint,{method:'PUT',body:{limit:raw===''?null:Number(raw)}});
    ctx.complete('成员额度已更新');
  });
}
