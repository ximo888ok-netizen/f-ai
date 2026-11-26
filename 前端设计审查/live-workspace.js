import { assetDetails, searchable } from './live-record-tools.js';
import { settings } from './live-settings.js';
import { categoryDocs, categoryPage, customerScopeField, knowledgeDocument, readCustomerScope, webSearch } from './live-knowledge-tools.js';

import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, result, select, textarea, toast, uid } from './live.js';
import { downloadAsset } from './live-tasks.js';
import { rightsActions } from './live-rights.js';

const body = data => Object.fromEntries(data);
const post = (ctx, endpoint, fields) => ctx.api(endpoint, { method: 'POST', body: fields });
const patch = (ctx, endpoint, fields) => ctx.api(endpoint, { method: 'PATCH', body: fields });
const memberOptions = members => members.map(member => [member.id, member.displayName + ' · ' + member.email]);
const nameField = (label = '名称', value = '') => field(label, input('name', 'required maxlength="120" value="' + h(value) + '"'));
const pickMember = members => field('成员', select('memberId', memberOptions(members), undefined, 'required'));

async function members(ctx) {
  return ctx.enterprise && ctx.manager ? await ctx.all('/v1/members?state=active') : [];
}

function deleteButton(ctx, attr, endpoint, warning) {
  ctx.click(attr, async id => {
    if (!window.confirm(warning)) return;
    await ctx.api(endpoint(id), { method: 'DELETE' });
    ctx.reload();
  });
}

async function projects(ctx) {
  const [id] = ctx.args;
  const base = '/v1/projects';
  const manage = ctx.manager && !ctx.enterprise;
  const merchant = ctx.manager && ctx.enterprise ? '<a class="smallbtn" href="/merchant#projects">在商家后台管理</a>' : '';
  if (!id) {
    const entries = await ctx.all(base + '?state=all');
    ctx.html(heading('我的项目') + merchant + (manage ? panel('新建项目', form('project', nameField('项目名称'), '创建项目')) : '') +
      panel('项目清单', list(entries, project => item(project.name, project.archivedAt ? '已归档' : '进行中',
        link('项目详情', 'projects/' + project.id)))));
    ctx.submit('project', async data => {
      const project = await post(ctx, base, body(data));
      ctx.go('projects/' + project.id);
    });
    return;
  }
  const endpoint = base + '/' + path(id);
  const project = await ctx.api(endpoint);
  ctx.html(heading(project.name, project.archivedAt ? '已归档 · ' + date(project.archivedAt) : '创建于 ' + date(project.createdAt)) +
    merchant + (manage ? panel('项目设置', form('rename', nameField('项目名称', project.name), '保存名称') +
      action(project.archivedAt ? '恢复项目' : '归档项目', 'project-state')) : '') +
    link('返回项目清单', 'projects'));
  ctx.submit('rename', async data => { await patch(ctx, endpoint, body(data)); ctx.reload(); });
  ctx.click('project-state', async () => {
    await patch(ctx, endpoint, { state: project.archivedAt ? 'active' : 'archived' });
    ctx.reload();
  });
}

async function team(ctx) {
  const token = /^[A-Za-z0-9_-]{43}$/.test(ctx.args[0] ?? '') ? ctx.args[0] : '';
  ctx.html(heading('企业邀请', '使用由企业管理员生成的一次性邀请码加入工作区。') +
    (ctx.enterprise && ctx.manager ? '<p><a class="smallbtn" href="/merchant#members">在商家后台管理成员</a></p>' : '') +
    panel('接受企业邀请', form('accept', field('一次性邀请码',
      input('token', 'required minlength="43" maxlength="43" autocomplete="off" value="' + h(token) + '"')), '接受邀请')));
  ctx.submit('accept', async data => ctx.acceptInvitation(await ctx.api('/v1/invitations/accept', {
    method: 'POST', tenant: false, body: { token: data.get('token').trim() },
  })));
}

async function resources(ctx) {
  const [id, documentId] = ctx.args;
  const basesPath = '/v1/knowledge/bases';
  if (id === 'web') return webSearch(ctx);
  if (id === 'memory') { await memory(ctx, documentId === 'enterprise' && ctx.enterprise ? 'enterprise' : 'personal'); return; }
  if (!id) {
    const bases = await ctx.all(basesPath);
    ctx.html(heading('知识库与记忆') + '<div class="live-row">' + link('个人记忆', 'resources/memory/personal') + link('联网检索', 'resources/web') +
      (ctx.enterprise ? link('企业记忆', 'resources/memory/enterprise') : '') + '</div>' +
      grid(panel('知识库', list(bases, base => item(base.name, date(base.createdAt), link('打开知识库', 'resources/' + base.id))) +
        (ctx.manager ? form('new-base', nameField('知识库名称'), '创建知识库') : '')),
      panel('检索文档', form('search', field('关键词', input('query', 'required maxlength="160"')) +
        (bases.length ? field('限定知识库', select('baseId', [['', '全部已授权库'], ...bases.map(base => [base.id, base.name])])) : ''), '检索') +
        '<div id="search-results"></div>')));
    ctx.submit('new-base', async data => ctx.go('resources/' + (await post(ctx, basesPath, body(data))).id));
    ctx.submit('search', async data => {
      const baseId = data.get('baseId');
      const hits = await post(ctx, '/v1/knowledge/search', { query: data.get('query'), ...(baseId ? { baseIds: [baseId] } : {}) });
      if (ctx.active()) document.querySelector('#search-results').innerHTML = list(hits.items, hit => item(hit.name + ' · ' + hit.baseName,
        hit.snippet, link('查看文档', 'resources/' + hit.baseId + '/' + hit.documentId)), '未找到匹配文档。');
    });
    return;
  }
  const endpoint = basesPath + '/' + path(id);
  const documents = endpoint + '/documents';
  if (documentId === 'categories') return categoryPage(ctx, id);
  if (documentId === 'category') return categoryDocs(ctx, id, ctx.args[2]);
  if (documentId) return knowledgeDocument(ctx, id, documentId);
  const [bases, docs, roster, grants, products] = await Promise.all([ctx.all(basesPath), ctx.all(documents), members(ctx),
    ctx.manager && ctx.enterprise ? ctx.all(endpoint+'/grants') : [], ctx.manager ? ctx.all('/v1/studio/products') : []]);
  const base = bases.find(base => base.id === id);
  const eligible = roster.filter(member => member.role === 'member' && !grants.some(g=>g.accountId===member.id));
  ctx.html(heading(base?.name ?? '知识库') + link('文档分类', 'resources/' + id + '/categories') + panel('已上传文档', list(docs, doc => item(doc.name, doc.category,
    link('阅读', 'resources/' + id + '/' + doc.id) + (ctx.manager ? action('删除', 'delete-document', doc.id) : '')))) +
    (ctx.manager ? grid(panel('添加文本资料', form('add-doc', field('名称', input('name', 'required maxlength="200"')) +
      field('分类', input('category', 'maxlength="100"')) + customerScopeField(products) + field('正文', textarea('content', 'maxlength="200000"')) +
      field('或读取 UTF-8 文本文件', input('file', 'type="file" accept=".txt,text/plain"')), '保存文档')),
      panel('库设置', form('rename-base', nameField('知识库名称', base?.name), '保存名称') + action('删除知识库', 'delete-base')),
      ...(ctx.enterprise ? [panel('文档访问授权',list(grants,g=>item(roster.find(m=>m.id===g.accountId)?.displayName??g.accountId,'已授权',action('撤销访问','remove-grant',g.accountId)),'暂无单独授权的成员。')+
        (eligible.length?form('grant',pickMember(eligible),'授予访问'):''))] : [])) : '') +
    link('返回知识库清单', 'resources'));
  ctx.submit('add-doc', async data => {
    const file = data.get('file');
    const content = file.size ? await file.text() : data.get('content');
    await post(ctx, documents, { name: data.get('name'), category: data.get('category') || undefined, content,
      customerScope: readCustomerScope(data.get('customerScope')) });
    ctx.reload();
  });
  ctx.submit('rename-base', async data => { await patch(ctx, endpoint, body(data)); ctx.reload(); });
  ctx.submit('grant', async data => {
    await ctx.api(endpoint + '/grants/' + path(data.get('memberId')), { method:'PUT' });
    ctx.reload();
  });
  ctx.click('remove-grant',async member=>{if(confirm('撤销该成员对知识库的访问？')){await ctx.api(endpoint+'/grants/'+path(member),{method:'DELETE'});ctx.reload();}});
  deleteButton(ctx, 'delete-document', doc => documents + '/' + path(doc), '删除该文档及检索索引？');
  ctx.click('delete-base', async () => {
    if (!window.confirm('删除该知识库及其中的文档？')) return;
    await ctx.api(endpoint, { method: 'DELETE' });
    ctx.go('resources');
  });
}

async function memory(ctx, scope) {
  const entries = await ctx.all('/v1/memory?scope=' + scope);
  const editable = scope === 'personal' || ctx.manager;
  ctx.html(heading(scope === 'enterprise' ? '企业记忆' : '个人记忆') +
    (editable ? panel('新建记忆', form('memory', field('内容', textarea('content', 'required maxlength="10000"')), '保存记忆')) : '') +
    panel('记忆记录', list(entries, entry => item(date(entry.createdAt), entry.content,
      editable ? action('删除', 'delete-memory', entry.id) : ''))) + link('返回知识库', 'resources'));
  ctx.submit('memory', async data => { await post(ctx, '/v1/memory', { scope, ...body(data) }); ctx.reload(); });
  deleteButton(ctx, 'delete-memory', id => '/v1/memory/' + path(id), '删除该记忆？');
}

const mimeByExtension = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', mp4:'video/mp4', mp3:'audio/mpeg',
  m4a:'audio/mp4', webm:'audio/webm', psd:'application/vnd.adobe.photoshop' };
export async function uploadMedia(ctx, data) {
  const file = data.get('file');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('请选择 10 MiB 以内的文件。');
  const mediaType = mimeByExtension[file.name.split('.').at(-1).toLowerCase()];
  if (!mediaType) throw new Error('支持 PNG、JPEG、MP4、MP3、M4A、WebM 和 PSD。');
  const content = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const payload = { name: file.name, mediaType, source: data.get('source'), purpose: data.get('purpose'), dataBase64: content };
  if (data.get('consentReference')) payload.consentReference = data.get('consentReference');
  if (data.get('consentExpiresAt')) payload.consentExpiresAt = new Date(data.get('consentExpiresAt')).toISOString();
  return post(ctx, '/v1/assets', payload);
}

async function assets(ctx) {
  if (ctx.args[0]) return assetDetails(ctx,ctx.args[0]);
  const [files,cloud,video] = await Promise.all([
    ctx.all('/v1/assets'),ctx.api('/v1/cloud-assets/status'),ctx.api('/v1/video-export/status'),
  ]);
  ctx.html(heading('素材库') + '<div class="live-row">'+link('图片与视频处理','media')+
    link('网盘备份','cloud-assets')+'</div>' + grid(panel('上传素材', form('upload',
    field('文件', input('file', 'type="file" required accept=".png,.jpg,.jpeg,.mp3,.mp4,.m4a,.webm,.psd"')) +
    field('素材来源', input('source', 'required maxlength="200"')) + field('使用用途', input('purpose', 'required maxlength="200"')) +
    field('授权凭证编号（选填）', input('consentReference', 'maxlength="200"')) +
    field('授权截止时间（与凭证同时填写）', input('consentExpiresAt', 'type="datetime-local"')), '上传至工作区')),
    panel('我的素材', searchable('搜索素材名称或类型',list(files, file => item(file.name,
      file.mediaType + ' · ' + Math.ceil(file.sizeBytes / 1024) + ' KiB' + (file.consentExpiresAt ? ' · 授权至 ' + date(file.consentExpiresAt) : ''),
      '<div class="live-row">'+link('文件详情','assets/'+path(file.id))+action('下载', 'download', file.id) +
      (cloud.available ? action('备份到网盘','cloud-backup',file.id) : '') +
      (['image/png','image/jpeg'].includes(file.mediaType)?link('处理图片','media/images/new/'+file.id):'') +
      (video.available && file.mediaType==='video/mp4' ? link('视频导出','media/video/'+file.id) +
        action('导出带 AI 标识视频','mark-video',file.id) : '') +
      link('提交权利通知','rights/new/'+file.id)+action('删除', 'delete-asset', file.id)+'</div>'))))));
  ctx.submit('upload', async data => { await uploadMedia(ctx, data); ctx.reload(); });
  ctx.click('download', id => downloadAsset(ctx, id, files.find(file => file.id === id).name));
  ctx.click('mark-video',async id=>{
    const file=files.find(asset=>asset.id===id);
    if (!confirm('确认「'+file.name+'」是 AI 生成的视频，并导出一份带标识的 MP4？')) return;
    toast('正在导出视频，短片可能需要数秒。');
    await downloadAsset(ctx,id,file.name.replace(/\.mp4$/i,'')+'-AI.mp4','video-export',
      {method:'POST',body:{aiGenerated:true}});
  });
  ctx.click('cloud-backup',async id=>{
    const file=files.find(asset=>asset.id===id);
    if (!confirm('将「'+file.name+'」复制到此工作区的自有网盘？')) return;
    await ctx.api('/v1/cloud-assets/'+path(id),{method:'PUT',body:{confirmed:true}});
    toast('已备份并核对文件');
    ctx.go('cloud-assets');
  });
  deleteButton(ctx, 'delete-asset', id => '/v1/assets/' + path(id), '从工作区删除这项素材？');
}

const operations = { credit:'入账', reserve:'预占', release:'释放', settle:'消费', transfer_out:'分配转出', transfer_in:'分配转入' };
async function account(ctx) {
  const [wallet, ledger, roster, spending] = await Promise.all([ctx.api('/v1/credits/wallet'), ctx.all('/v1/credits/ledger'), members(ctx), ctx.api('/v1/credits/limit')]);
  const recipients = roster.filter(member => member.id !== ctx.account.id);
  ctx.html(heading('AI 加油站', '查看工作区积分额度、消费与分配记录。') + grid(panel('当前账号', item(ctx.account.displayName, ctx.account.email, action('退出登录', 'logout'))),
    panel('积分钱包', item(wallet.available + ' 可用积分', '总额 ' + wallet.balance + ' · 预占 ' + wallet.reserved) + notice('累计任务消费 '+spending.spent+' · 额度上限 '+(spending.limit ?? '不限')) + notice('当前部署未配置在线充值。')),
    ...(recipients.length ? [panel('分配积分', form('allocate', pickMember(recipients) +
      field('积分数量', input('amount', 'type="number" min="1" max="1000000" required')), '确认分配'))] : [])) +
    panel('积分流水', list(ledger, entry => item((operations[entry.operation] ?? entry.operation) + ' · ' + entry.amount, date(entry.createdAt) + ' · ' + entry.reference))));
  ctx.click('logout', ctx.logout);
  let previous;
  ctx.submit('allocate', async data => {
    const values = { memberId: data.get('memberId'), amount: Number(data.get('amount')) };
    if (!previous || previous.memberId !== values.memberId || previous.amount !== values.amount) previous = { ...values, reference: uid() };
    await post(ctx, '/v1/credits/allocate', previous);
    ctx.reload();
  });
}

async function inbox(ctx) {
  const [summary, messages] = await Promise.all([ctx.api('/v1/notifications?limit=1'), ctx.all('/v1/notifications')]);
  const types = { 'task.succeeded':'任务成功', 'task.failed':'任务失败', 'task.cancelled':'任务取消',
    'member.joined':'已加入企业工作区', 'member.role-changed':'工作区角色已变更', 'member.state-changed':'成员状态已变更',
    ...Object.fromEntries(Object.entries(rightsActions).map(([key,label])=>['rights.'+key,label])),
  };
  ctx.html(heading('消息中心', summary.unread + ' 条未读') + link('全部通知','inbox') + link('仅看未读','inbox/unread') +
    panel('通知', (summary.unread ? action('全部标为已读', 'read-all') : '') + searchable('搜索消息类型或时间',list(ctx.args[0]==='unread'?messages.filter(m=>!m.readAt):messages, message => item(types[message.type] ?? message.type,
      date(message.createdAt) + (message.readAt ? ' · 已读' : ' · 未读'),
      (message.data.taskId ? link('查看任务', 'tasks/' + message.data.taskId) : '') +
      (message.data.noticeId?link('查看案件','rights/'+message.data.noticeId):'') +
      (message.readAt ? '' : action('标为已读', 'read-id', message.id)))))));
  ctx.click('read-all', async () => { await post(ctx, '/v1/notifications/read-all'); ctx.reload(); });
  ctx.click('read-id', async id => { await post(ctx, '/v1/notifications/' + path(id) + '/read'); ctx.reload(); });
}

export const workspacePages = { projects, team, resources, assets, account, inbox, settings };
