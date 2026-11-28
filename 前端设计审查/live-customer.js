import { confirmDialog } from './live-ui.js';

import { action, field, form, h, heading, input, item, link, list, notice, panel, result, textarea } from './live.js';
import { bindCustomerAgent, integrationSlot } from './live-agent-integrations.js';
import { sceneDesk } from './studio-workflows.js';
import { bindShopPane, shopPane, storesFor } from './desk-shops.js';
import { bindNativeChannels, nativeChannelPane } from './desk-channel.js';
import { bindInbox, inboxPane } from './desk-inbox.js';

const endpoint='/v1/customer-service';
const post=(ctx,url,body)=>ctx.api(url,{method:'POST',body});

export async function customerPage(ctx) {
  const directory=await ctx.api('/v1/plugins');
  if(!directory.items.find(plugin=>plugin.id==='customer-service').enabled){
    ctx.html(heading('客服工作台')+notice('客服插件已在当前工作区停用。')+link('查看插件状态','manager'));return;
  }
  const [id]=ctx.args;
  if(id==='replies'){await quickReplies(ctx);return;}
  const [conversations,bases,replies,shops]=await Promise.all([ctx.all(endpoint+'/conversations'),ctx.all('/v1/knowledge/bases'),ctx.all(endpoint+'/quick-replies'),storesFor(ctx)]);
  if(!ctx.active())return;
  const panels=[{id:'inbox',label:'接待台',icon:'service',body:inboxPane(ctx,shops.items,bases)},
    {id:'draft',label:'回复助手',icon:'copywriting',body:integrationSlot('customer-agent')}];
  const native=shops.items.filter(s=>s.customer);
  if(ctx.manager){
    panels.push({id:'channel',label:'平台会话',icon:'connections',body:nativeChannelPane(native)});
    panels.push({id:'shops',label:'店铺管理',icon:'desk',count:shops.items.length,body:shopPane(ctx,shops,'customer')});
  }
  sceneDesk(ctx,'customer',panels,id==='shops'&&ctx.manager?'shops':'inbox',link('快捷话术','customer/replies'));
  const switchTab=name=>document.querySelector('#scene-customer-'+name+'-tab')?.click();
  if(ctx.manager)bindShopPane(ctx,shops);
  if(ctx.manager)bindNativeChannels(ctx,native);
  const handover={id:null,insert:null};
  void bindCustomerAgent(ctx,'',handover);
  handover.insert=await bindInbox(ctx,{shops:shops.items,conversations,replies,initial:id==='shops'?null:id,onDraft:(question,conversationId)=>{
    handover.id=conversationId;switchTab('draft');
    const q=document.querySelector('[data-form="ca-draft"] [name=question]');
    if(q){q.value=question;q.focus();}
  }});
  const extra=document.querySelector('.inbox-context-links');
  if(extra && ctx.active())extra.insertAdjacentHTML('beforeend',link('权利通知','rights')+(ctx.manager?link('飞书消息','feishu'):''));
}

function replyFields(reply = {}) {
  return field('标题', input('title', 'required maxlength="160" value="' + h(reply.title) + '"')) +
    field('场景', input('scenario', 'required maxlength="100" value="' + h(reply.scenario) + '"')) +
    field('内容', textarea('content', 'required maxlength="4000"', reply.content));
}

async function quickReplies(ctx) {
  const route = endpoint + '/quick-replies';
  const replies = await ctx.all(route);
  ctx.html(heading('快捷话术') +
    (ctx.manager ? panel('新增话术', form('new-reply', replyFields(), '新增话术')) : '') +
    panel('话术清单', list(replies, reply => item(reply.title, reply.scenario,
      ctx.manager ? '<details><summary>查看或编辑</summary>' + form('reply-' + reply.id, replyFields(reply)) +
        action('删除话术', 'delete-reply', reply.id) + '</details>' : result(reply.content)))) + link('返回客服工作台', 'customer'));
  ctx.submit('new-reply', async data => { await post(ctx, route, Object.fromEntries(data)); ctx.reload(); });
  for (const reply of replies) ctx.submit('reply-' + reply.id, async data => {
    await ctx.api(route + '/' + path(reply.id), { method:'PUT', body:Object.fromEntries(data) });
    ctx.reload();
  });
  ctx.click('delete-reply', async id => {
    if (!await confirmDialog('确认操作', '删除这条快捷话术？')) return;
    await ctx.api(route + '/' + path(id), { method:'DELETE' });
    ctx.reload();
  });
}
