
import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, result, select, textarea } from './live.js';

const endpoint = '/v1/customer-service';
const senderLabels = { assistant: 'AI 助手', customer: '客户', operator: '人工客服' };
const post = (ctx, url, body) => ctx.api(url, { method: 'POST', body });

export async function customerPage(ctx) {
  const directory = await ctx.api('/v1/plugins');
  if (!directory.items.find(plugin => plugin.id === 'customer-service').enabled) {
    ctx.html(heading('客服工作台') + notice('客服插件已在当前工作区停用。') + link('查看插件状态', 'manager'));
    return;
  }
  const [id] = ctx.args;
  if (id === 'replies') { await quickReplies(ctx); return; }
  if (id) { await conversation(ctx, id); return; }
  const [conversations, bases] = await Promise.all([
    ctx.all(endpoint + '/conversations'), ctx.all('/v1/knowledge/bases'),
  ]);
  ctx.html(heading('客服工作台') + grid(panel('新会话', form('new-conversation', field('主题', input('subject', 'required maxlength="160"')) +
    (bases.length ? field('允许引用的知识库（可多选）', select('baseId', bases.map(base => [base.id, base.name]), undefined, 'multiple')) : ''), '创建会话')),
    panel('会话', list(conversations, row => item(row.subject, row.state === 'human' ? '人工接待' : 'AI 接待',
      link('打开会话', 'customer/' + row.id))))) + link('快捷话术', 'customer/replies'));
  ctx.submit('new-conversation', async data => {
    const row = await post(ctx, endpoint + '/conversations', { subject: data.get('subject'), knowledgeBaseIds: data.getAll('baseId') });
    ctx.go('customer/' + row.id);
  });
}

async function conversation(ctx, id) {
  const route = endpoint + '/conversations/' + path(id);
  const [firstPage, replies] = await Promise.all([ctx.api(route + '/messages?limit=100'), ctx.all(endpoint + '/quick-replies')]);
  const current = firstPage.conversation;
  const messages = firstPage.items;
  let count = messages.length;
  while (count && count % 100 === 0) {
    const { items } = await ctx.api(route + '/messages?limit=100&offset=' + count);
    if (!items.length) break;
    messages.push(...items);
    count += items.length;
  }
  const assigned = ctx.enterprise && ctx.manager && current.operatorId === ctx.account.id;
  const sender = assigned ? 'operator' : current.accountId === ctx.account.id ? 'customer' : '';
  const controls = sender ? form('message',
    (assigned && replies.length ? field('插入快捷话术', select('reply', [['', '选择话术'], ...replies.map(reply => [reply.id, reply.title])])) : '') +
    field(assigned ? '客服回复' : '客户消息', textarea('content', 'required maxlength="4000"')) +
    (current.state === 'assistant' && sender === 'customer' ? field('知识检索关键词（选填）', input('search', 'maxlength="160"')) : ''), '发送') : '';
  ctx.html(heading(current.subject, current.state === 'human' ? '人工接待' : 'AI 知识库接待') +
    panel('消息', list(messages, message => item(senderLabels[message.sender], date(message.createdAt),
      result(message.content) + message.sources.map(source => '<p>' + h(source.baseName + ' · ' + source.documentName) + ' ' +
        link('引用文档', 'resources/' + source.baseId + '/' + source.documentId) + '</p>').join('')))) +
    (controls ? panel('发送消息', controls) : '') +
    (ctx.enterprise && ctx.manager && current.state === 'assistant' ? action('接管会话', 'handoff') : '') +
    action('刷新消息', 'refresh') + link('返回会话清单', 'customer'));
  ctx.on('[name=reply]', 'change', node => {
    const reply = replies.find(entry => entry.id === node.value);
    if (reply) document.querySelector('[name=content]').value = reply.content;
  });
  ctx.submit('message', async data => {
    const search = data.get('search');
    await post(ctx, route + '/messages', { sender, content: data.get('content'), ...(search ? { search } : {}) });
    ctx.reload();
  });
  ctx.click('handoff', async () => { await post(ctx, route + '/handoff'); ctx.reload(); });
  ctx.click('refresh', ctx.reload);
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
    if (!window.confirm('删除这条快捷话术？')) return;
    await ctx.api(route + '/' + path(id), { method:'DELETE' });
    ctx.reload();
  });
}
