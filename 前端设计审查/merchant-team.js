import { confirmDialog } from './live-ui.js';
import { memberCreditLimit } from './merchant-credit-limit.js';
import { action, date, field, form, grid, h, input, item, link, list, panel, path, select } from './live-ui.js';
import { badge, paging, roleNames, rowActions, sectionTitle, table } from './merchant-ui.js';

const limit = 25;
const roleOptions = [['member', '普通成员'], ['admin', '管理员']];
const states = [['', '全部状态'], ['active', '启用'], ['suspended', '已停用']];
const filters = [['', '全部角色'], ['owner', '所有者'], ...roleOptions];

function inviteToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function invitationLink(result) {
  if(location.protocol==='file:')return '<label>体验库一次性邀请码<input data-ticket readonly value="'+h(result.token)+'"></label>'+action('复制邀请码','copy-invite')+'<p class="live-muted">邀请已保存在本机体验库。跨设备邀请需要部署工作台服务。</p>';
  const url = new URL('/', location.origin);
  url.hash = 'team/' + result.token;
  return '<label>一次性邀请链接<input data-ticket readonly value="' + h(url.href) + '"></label>' + action('复制链接', 'copy-invite') +
    '<p class="live-muted">有效期至 ' + h(date(result.expiresAt)) + '。请交给受邀邮箱的使用者。</p>';
}

function memberControls(member, owner) {
  if (member.role === 'owner' || (!owner && member.role === 'admin')) return '';
  const state = member.state === 'active' ? '停用' : '恢复';
  const role = member.role === 'admin' ? '设为成员' : '设为管理员';
  return rowActions(link('任务额度','members/limit/'+path(member.id)), action(state, 'member-state', member.id), owner ? action(role, 'member-role', member.id) : '');
}

function invitationControls(invite, owner) {
  if (!['pending', 'expired'].includes(invite.status) || (invite.role === 'admin' && !owner)) return '';
  return rowActions(action('重发链接', 'renew', invite.id), action('撤回', 'revoke', invite.id));
}

export async function membersPage(ctx) {
  if (ctx.args[0] === 'limit' && ctx.args[1]) return memberCreditLimit(ctx,ctx.args[1]);
  const filter = ctx.state.filters;
  const offset = ctx.state.memberOffset;
  const query = new URLSearchParams({ limit, offset });
  for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value);
  const [members, invitations] = await Promise.all([
    ctx.api('/v1/members?' + query),
    ctx.api('/v1/invitations?limit=' + limit + '&offset=' + ctx.state.inviteOffset),
  ]);
  const owner = ctx.workspace.role === 'owner';
  const roster = table('企业成员', ['成员', '角色', '状态', '操作'], members.items, member => [
    '<strong>' + h(member.displayName) + '</strong><p class="live-muted">' + h(member.email) + '</p>',
    h(roleNames[member.role]), badge(member.state), memberControls(member, owner),
  ]);
  const queryForm = '<form class="merchant-filter" data-form="filters">' +
    field('姓名或邮箱', input('q', 'type="search" maxlength="100" value="' + h(filter.q ?? '') + '"')) +
    field('角色', select('role', filters, filter.role ?? '')) + field('状态', select('state', states, filter.state ?? '')) +
    '<button class="smallbtn">筛选</button></form>';
  const inviteForm = form('invite', field('邮箱', input('email', 'type="email" required maxlength="254"')) +
    field('加入角色', select('role', owner ? roleOptions : roleOptions.slice(0, 1), 'member')), '生成邀请链接');
  const ticket = ctx.state.invitation ? '<div class="merchant-ticket">' + invitationLink(ctx.state.invitation) + '</div>' : '';
  const inviteList = list(invitations.items, invite => item(invite.email, roleNames[invite.role] + ' · ' + date(invite.expiresAt),
    badge(invite.status) + invitationControls(invite, owner)), '暂无邀请记录。');
  const invitePage = paging(ctx.state.inviteOffset, invitations.items.length, limit).replaceAll('data-page=', 'data-invite-page=');
  ctx.html(sectionTitle('成员与邀请', '邀请同事、管理角色与本企业工作区访问。') +
    panel('企业成员', queryForm + roster + paging(offset, members.items.length, limit)) +
    grid(panel('邀请成员', ticket + inviteForm), panel('邀请记录', inviteList + invitePage)));

  ctx.form('filters', data => { ctx.state.filters = Object.fromEntries(data); ctx.state.memberOffset = 0; ctx.reload(); });
  ctx.click('page', value => { ctx.state.memberOffset = Number(value); ctx.reload(); });
  ctx.click('invite-page', value => { ctx.state.inviteOffset = Number(value); ctx.reload(); });
  ctx.click('copy-invite', async (_value, control) => {
    const input = control.closest('.merchant-ticket').querySelector('[data-ticket]');
    try {
      await navigator.clipboard.writeText(input.value);
      ctx.notify('邀请链接已复制');
    } catch {
      input.select();
      ctx.notify('链接已选中，可以手动复制。');
    }
  });
  ctx.form('invite', async data => {
    const result = await ctx.api('/v1/invitations', { method: 'POST', body: Object.fromEntries(data) });
    if (ctx.active()) { ctx.state.invitation = result; ctx.state.inviteOffset = 0; ctx.reload(); }
  });
  ctx.click('renew', async id => {
    if (!await confirmDialog('确认操作', '重发后，原邀请链接将立即失效。继续重发？')) return;
    const invitation = invitations.items.find(item => item.id === id);
    const result = await ctx.api('/v1/invitations/' + path(id) + '/token', {
      method: 'PUT', body: { token: inviteToken(), revision: invitation.revision },
    });
    if (ctx.active()) { ctx.state.invitation = result; ctx.reload(); }
  });
  ctx.click('revoke', async id => {
    if (!await confirmDialog('确认操作', '撤回这条邀请链接？')) return;
    await ctx.api('/v1/invitations/' + path(id), { method: 'DELETE' });
    if (ctx.active() && ctx.state.invitation?.id === id) ctx.state.invitation = null;
    ctx.complete('邀请已撤回');
  });
  ctx.click('member-state', async id => {
    const member = members.items.find(item => item.id === id);
    const state = member.state === 'active' ? 'suspended' : 'active';
    if (!await confirmDialog('确认操作', (state === 'suspended' ? '停用' : '恢复') + '「' + member.displayName + '」的企业访问？')) return;
    await ctx.api('/v1/members/' + path(id) + '/state', { method: 'PATCH', body: { state } });
    ctx.complete('成员状态已更新');
  });
  ctx.click('member-role', async id => {
    const member = members.items.find(item => item.id === id);
    const role = member.role === 'admin' ? 'member' : 'admin';
    if (!await confirmDialog('确认操作', '将「' + member.displayName + '」设为' + roleNames[role] + '？')) return;
    await ctx.api('/v1/members/' + path(id), { method: 'PATCH', body: { role } });
    ctx.complete('成员角色已更新');
  });
}
