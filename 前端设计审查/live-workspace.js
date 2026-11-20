
import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, result, select, textarea, toast, uid } from './live.js';
import { downloadAsset } from './live-tasks.js';

const body = data => Object.fromEntries(data);
const post = (ctx, endpoint, fields) => ctx.api(endpoint, { method: 'POST', body: fields });
const patch = (ctx, endpoint, fields) => ctx.api(endpoint, { method: 'PATCH', body: fields });
const roles = { owner: '所有者', admin: '管理员', member: '成员' };
const memberOptions = members => members.map(member => [member.id, member.displayName + ' · ' + member.email]);
const nameField = (label = '名称', value = '') => field(label, input('name', 'required maxlength="120" value="' + h(value) + '"'));
const pickMember = members => field('成员', select('memberId', memberOptions(members), undefined, 'required'));

async function members(ctx) {
  return ctx.enterprise && ctx.manager ? (await ctx.api('/v1/members')).items : [];
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
  if (!id) {
    const entries = await ctx.all(base + '?state=all');
    ctx.html(heading('项目管理') + (ctx.manager ? panel('新建项目', form('project', nameField('项目名称'), '创建项目')) : '') +
      panel('项目清单', list(entries, project => item(project.name, project.archivedAt ? '已归档' : '进行中',
        link('项目详情', 'projects/' + project.id)))));
    ctx.submit('project', async data => {
      const project = await post(ctx, base, body(data));
      ctx.go('projects/' + project.id);
    });
    return;
  }
  const endpoint = base + '/' + path(id);
  const [project, roster] = await Promise.all([ctx.api(endpoint), members(ctx)]);
  const eligible = roster.filter(member => member.role === 'member');
  ctx.html(heading(project.name, project.archivedAt ? '已归档 · ' + date(project.archivedAt) : '创建于 ' + date(project.createdAt)) +
    (ctx.manager ? grid(panel('项目设置', form('rename', nameField('项目名称', project.name), '保存名称') +
      action(project.archivedAt ? '恢复项目' : '归档项目', 'project-state')),
    ...(eligible.length ? [panel('项目成员权限', form('project-access', pickMember(eligible) +
      field('操作', select('method', [['PUT','添加成员'], ['DELETE','移除成员']])), '更新权限'))] : [])) : '') +
    link('返回项目清单', 'projects'));
  ctx.submit('rename', async data => { await patch(ctx, endpoint, body(data)); ctx.reload(); });
  ctx.click('project-state', async () => {
    await patch(ctx, endpoint, { state: project.archivedAt ? 'active' : 'archived' });
    ctx.reload();
  });
  ctx.submit('project-access', async data => {
    await ctx.api(endpoint + '/members/' + path(data.get('memberId')), { method: data.get('method') });
    toast('项目权限已更新');
  });
}

async function team(ctx) {
  const roster = await members(ctx);
  const editable = roster.filter(member => member.role !== 'owner');
  const roleOptions = ctx.workspace.role === 'owner' ? [['member', '成员'], ['admin', '管理员']] : [['member', '成员']];
  ctx.html(heading('企业成员') +
    (ctx.enterprise && ctx.manager ? grid(panel('成员清单', list(roster, member => item(member.displayName, member.email + ' · ' + roles[member.role]))),
      panel('邀请成员', form('invite', field('对方邮箱', input('email', 'type="email" required maxlength="254"')) +
        field('角色', select('role', roleOptions)), '生成邀请') + '<div id="invitation"></div>'),
      ...(ctx.workspace.role === 'owner' && editable.length ? [panel('修改角色', form('role', pickMember(editable) +
        field('新角色', select('role', roleOptions)), '保存角色'))] : []))
      : notice(ctx.enterprise ? '成员清单和角色管理仅向企业管理员开放。' : '企业成员管理仅向企业工作区开放。')) +
    panel('接受企业邀请', form('accept', field('一次性邀请码', input('token', 'required minlength="43" maxlength="43" autocomplete="off"')), '接受邀请')));
  ctx.submit('invite', async data => {
    const invitation = await post(ctx, '/v1/invitations', body(data));
    if (!ctx.active()) return;
    document.querySelector('#invitation').innerHTML = notice('将邀请码交给受邀邮箱的使用者。到期时间 ' + date(invitation.expiresAt)) + result(invitation.token);
  });
  ctx.submit('role', async data => {
    await patch(ctx, '/v1/members/' + path(data.get('memberId')), { role: data.get('role') });
    ctx.reload();
  });
  ctx.submit('accept', async data => ctx.acceptInvitation(await ctx.api('/v1/invitations/accept', {
    method: 'POST', tenant: false, body: { token: data.get('token').trim() },
  })));
}

async function resources(ctx) {
  const [id, documentId] = ctx.args;
  const basesPath = '/v1/knowledge/bases';
  if (id === 'memory') { await memory(ctx, documentId === 'enterprise' && ctx.enterprise ? 'enterprise' : 'personal'); return; }
  if (!id) {
    const bases = await ctx.all(basesPath);
    ctx.html(heading('知识库与记忆') + '<div class="live-row">' + link('个人记忆', 'resources/memory/personal') +
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
  if (documentId) {
    const doc = await ctx.api(documents + '/' + path(documentId));
    ctx.html(heading(doc.name, doc.category) + panel('文档内容', result(doc.content)) + link('返回知识库', 'resources/' + id));
    return;
  }
  const [bases, docs, roster] = await Promise.all([ctx.all(basesPath), ctx.all(documents), members(ctx)]);
  const base = bases.find(base => base.id === id);
  const eligible = roster.filter(member => member.role === 'member');
  ctx.html(heading(base?.name ?? '知识库') + panel('已上传文档', list(docs, doc => item(doc.name, doc.category,
    link('阅读', 'resources/' + id + '/' + doc.id) + (ctx.manager ? action('删除', 'delete-document', doc.id) : '')))) +
    (ctx.manager ? grid(panel('添加文本资料', form('add-doc', field('名称', input('name', 'required maxlength="200"')) +
      field('分类', input('category', 'maxlength="100"')) + field('正文', textarea('content', 'maxlength="200000"')) +
      field('或读取 UTF-8 文本文件', input('file', 'type="file" accept=".txt,text/plain"')), '保存文档')),
      panel('库设置', form('rename-base', nameField('知识库名称', base?.name), '保存名称') + action('删除知识库', 'delete-base')),
      ...(eligible.length ? [panel('权限', form('grant', pickMember(eligible) +
        field('操作', select('method', [['PUT','授予访问'],['DELETE','撤销访问']])), '更新权限'))] : [])) : '') +
    link('返回知识库清单', 'resources'));
  ctx.submit('add-doc', async data => {
    const file = data.get('file');
    const content = file.size ? await file.text() : data.get('content');
    await post(ctx, documents, { name: data.get('name'), category: data.get('category') || undefined, content });
    ctx.reload();
  });
  ctx.submit('rename-base', async data => { await patch(ctx, endpoint, body(data)); ctx.reload(); });
  ctx.submit('grant', async data => {
    await ctx.api(endpoint + '/grants/' + path(data.get('memberId')), { method: data.get('method') });
    toast('知识库权限已更新');
  });
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

const mimeByExtension = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', mp4:'video/mp4', mp3:'audio/mpeg', psd:'application/vnd.adobe.photoshop' };
async function uploadMedia(ctx, data) {
  const file = data.get('file');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('请选择 10 MiB 以内的文件。');
  const mediaType = mimeByExtension[file.name.split('.').at(-1).toLowerCase()];
  if (!mediaType) throw new Error('支持 PNG、JPEG、MP4、MP3 和 PSD。');
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
  const files = await ctx.all('/v1/assets');
  ctx.html(heading('素材库') + grid(panel('上传素材', form('upload',
    field('文件', input('file', 'type="file" required accept=".png,.jpg,.jpeg,.mp3,.mp4,.psd"')) +
    field('素材来源', input('source', 'required maxlength="200"')) + field('使用用途', input('purpose', 'required maxlength="200"')) +
    field('授权凭证编号（选填）', input('consentReference', 'maxlength="200"')) +
    field('授权截止时间（与凭证同时填写）', input('consentExpiresAt', 'type="datetime-local"')), '上传至工作区')),
    panel('我的素材', list(files, file => item(file.name,
      file.mediaType + ' · ' + Math.ceil(file.sizeBytes / 1024) + ' KiB' + (file.consentExpiresAt ? ' · 授权至 ' + date(file.consentExpiresAt) : ''),
      action('下载', 'download', file.id) + action('删除', 'delete-asset', file.id))))));
  ctx.submit('upload', async data => { await uploadMedia(ctx, data); ctx.reload(); });
  ctx.click('download', id => downloadAsset(ctx, id, files.find(file => file.id === id).name));
  deleteButton(ctx, 'delete-asset', id => '/v1/assets/' + path(id), '从工作区删除这项素材？');
}

const operations = { credit:'入账', reserve:'预占', release:'释放', settle:'消费', transfer_out:'分配转出', transfer_in:'分配转入' };
async function account(ctx) {
  const [wallet, ledger, roster] = await Promise.all([ctx.api('/v1/credits/wallet'), ctx.all('/v1/credits/ledger'), members(ctx)]);
  const recipients = roster.filter(member => member.id !== ctx.account.id);
  ctx.html(heading('账户与积分') + grid(panel('当前账号', item(ctx.account.displayName, ctx.account.email, action('退出登录', 'logout'))),
    panel('积分钱包', item(wallet.available + ' 可用积分', '总额 ' + wallet.balance + ' · 预占 ' + wallet.reserved)),
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
  const types = { 'task.succeeded':'任务成功', 'task.failed':'任务失败', 'task.cancelled':'任务取消' };
  ctx.html(heading('消息中心', summary.unread + ' 条未读') +
    panel('通知', (summary.unread ? action('全部标为已读', 'read-all') : '') + list(messages, message => item(types[message.type] ?? message.type,
      date(message.createdAt) + (message.readAt ? ' · 已读' : ' · 未读'),
      (message.data.taskId ? link('查看任务', 'tasks/' + message.data.taskId) : '') + (message.readAt ? '' : action('标为已读', 'read-id', message.id))))));
  ctx.click('read-all', async () => { await post(ctx, '/v1/notifications/read-all'); ctx.reload(); });
  ctx.click('read-id', async id => { await post(ctx, '/v1/notifications/' + path(id) + '/read'); ctx.reload(); });
}

async function settings(ctx) {
  const { preferences } = await ctx.api('/v1/settings');
  const toggle = (label, key, fallback) => field(label, input(key, 'type="checkbox" ' + ((preferences[key] ?? fallback) ? 'checked' : '')));
  ctx.html(heading('设置与诊断') + grid(panel('工作区偏好', form('settings',
    toggle('开启任务消息', 'taskNotifications', true))),
    panel('服务诊断', action('检查服务和数据库', 'check') + '<div id="checks"></div>')));
  ctx.submit('settings', async data => {
    const values = Object.fromEntries(['taskNotifications'].map(key => [key, data.has(key)]));
    await patch(ctx, '/v1/settings', values);
    toast('工作区偏好已保存');
    ctx.reload();
  });
  ctx.click('check', async () => {
    const endpoints = [['API 进程','/health'], ['数据库与迁移','/ready']];
    const checks = await Promise.allSettled(endpoints.map(([, endpoint]) => ctx.api(endpoint, { auth: false })));
    if (ctx.active()) document.querySelector('#checks').innerHTML = checks.map((check, index) =>
      item(endpoints[index][0], check.status === 'fulfilled' ? check.value.status : check.reason.message)).join('');
  });
}

export const workspacePages = { projects, team, resources, assets, account, inbox, settings };
