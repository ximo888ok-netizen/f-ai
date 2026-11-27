import { action, date, field, form, h, heading, item, link, list, notice, panel, path, textarea, toast, uid } from './live.js';

const backups='/v1/cloud-assets';
const channel='/v1/channels/feishu';

export async function cloudAssetsPage(ctx) {
  const [status,copies]=await Promise.all([ctx.api(backups+'/status'),ctx.all(backups)]);
  ctx.html(heading('网盘备份',status.available ? '本工作区已绑定网盘。' : '请由管理员配置工作区网盘。') +
    link('返回素材库','assets') + panel('我的备份',list(copies,copy=>item(copy.name,
      Math.ceil(copy.sizeBytes/1024)+' KiB · '+(copy.state==='ready' ? '已核验' : '待核验')+' · '+date(copy.createdAt),
      status.available ? action('下载备份','cloud-download',copy.id)+action('恢复到素材库','cloud-restore',copy.id) : ''),'暂无备份。')));
  ctx.click('cloud-download',async id=>{
    const copy=copies.find(record=>record.id===id);
    const response=await ctx.api(backups+'/'+path(id)+'/content',{raw:true});
    const blob=await response.blob();
    if (!ctx.active()) return;
    const url=URL.createObjectURL(blob);
    const download=document.createElement('a');
    download.href=url;
    download.download=copy.name;
    download.click();
    setTimeout(()=>URL.revokeObjectURL(url),3000);
    if (copy.state==='pending') ctx.reload();
  });
  ctx.click('cloud-restore',async id=>{
    await ctx.api(backups+'/'+path(id)+'/restore',{method:'POST',body:{confirmed:true}});
    toast('已恢复到素材库');
    ctx.go('assets');
  });
}

const states={queued:'待发送',sending:'发送中',sent:'已发送',failed:'发送失败',uncertain:'待核实是否送达'};

export async function feishuPage(ctx) {
  const [connector,id]=ctx.args;
  if (!ctx.manager) {
    ctx.html(heading('飞书消息')+notice('工作区所有者和管理员可查看及回复。'));
    return;
  }
  if (!id) {
    const [status,entries]=await Promise.all([ctx.api(channel+'?limit=1'),ctx.all(channel)]);
    ctx.html(heading('飞书消息',status.available ? '工作区已绑定飞书机器人。' : '请由管理员配置飞书机器人。')+
      link('返回客服工作台','customer')+panel('收到的消息',list(entries,message=>item(message.content,date(message.createdAt),
        link('查看与回复','feishu/'+message.connector+'/'+message.eventId)),'暂无收到的消息。')));
    return;
  }
  const target=channel+'/'+path(connector)+'/inbox/'+path(id);
  const snapshot=await ctx.api(target);
  const replies=snapshot.items;
  const pending=replies.some(reply=>['queued','sending'].includes(reply.state));
  ctx.html(heading('飞书私信')+link('返回飞书消息','feishu')+
    panel('收到的内容',notice(snapshot.message.content)+'<p class="live-muted">'+h(date(snapshot.message.createdAt))+'</p>')+
    panel('回复记录',list(replies,reply=>item(reply.content,
      states[reply.state]+(reply.errorCode?' · '+reply.errorCode:'')+' · '+date(reply.createdAt)),'暂无回复。')+
      (pending?action('刷新投递状态','feishu-refresh'):''))+
    panel('写回复',form('feishu-send',field('回复内容',textarea('content','required maxlength="4000"')),'确认发送回复')));
  ctx.click('feishu-refresh',()=>ctx.reload());
  let draft;
  ctx.submit('feishu-send',async data=>{
    const content=data.get('content').trim();
    if (!content) throw new Error('请填写回复内容。');
    if (!draft || draft.content!==content) draft={id:uid(),content};
    await ctx.api(target+'/replies/'+path(draft.id),{method:'PUT',body:{content,confirmed:true}});
    toast('回复已入队，可刷新查看投递结果');
    ctx.reload();
  });
}
