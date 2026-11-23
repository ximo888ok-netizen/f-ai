import { action, date, field, form, grid, h, input, item, link, list, panel, path, select } from './live-ui.js';
import { badge, paging, rowActions, sectionTitle, table } from './merchant-ui.js';

const limit = 25;
const projectName = value => field('项目名称', input('name', 'required maxlength="120" value="' + h(value ?? '') + '"'));

export async function projectsPage(ctx) {
  const [id] = ctx.args;
  if (id) return projectPage(ctx, id);
  const { projectFilter, projectOffset } = ctx.state;
  const { items } = await ctx.api('/v1/projects?' + new URLSearchParams({ state: projectFilter, limit, offset: projectOffset }));
  const filter = '<form class="merchant-filter" data-form="project-filter">' +
    field('项目状态', select('state', [['all', '全部'], ['active', '进行中'], ['archived', '已归档']], projectFilter)) +
    '<button class="smallbtn">筛选</button></form>';
  ctx.html(sectionTitle('项目管理', '创建项目并按成员分配访问权限。') +
    panel('项目清单', filter + table('项目清单', ['项目', '状态', '创建时间', '操作'], items, project => [
      h(project.name), badge(project.archivedAt ? '已归档' : '进行中'), h(date(project.createdAt)),
      link('管理项目', 'projects/' + path(project.id)),
    ]) + paging(projectOffset, items.length, limit)) +
    panel('新建项目', form('project', projectName(), '创建项目')));
  ctx.form('project-filter', data => { ctx.state.projectFilter = data.get('state'); ctx.state.projectOffset = 0; ctx.reload(); });
  ctx.click('page', value => { ctx.state.projectOffset = Number(value); ctx.reload(); });
  ctx.form('project', async data => {
    const result = await ctx.api('/v1/projects', { method: 'POST', body: { name: data.get('name') } });
    ctx.go('projects/' + result.id);
  });
}

async function projectPage(ctx, id) {
  const endpoint = '/v1/projects/' + path(id);
  const [project, members, roster] = await Promise.all([
    ctx.api(endpoint), ctx.all(endpoint + '/members'), ctx.all('/v1/members?state=active&role=member'),
  ]);
  const granted = new Set(members.map(member => member.id));
  const eligible = roster.filter(member => !granted.has(member.id));
  const archived = Boolean(project.archivedAt);
  const access = !archived && eligible.length
    ? form('grant', field('授予访问', select('memberId', eligible.map(member => [member.id, member.displayName + ' · ' + member.email]))), '授权')
    : '';
  ctx.html(sectionTitle(project.name, archived ? '已归档 · ' + date(project.archivedAt) : '创建于 ' + date(project.createdAt),
    link('返回项目清单', 'projects')) + grid(
    panel('项目设置', form('rename', projectName(project.name), '保存名称') +
      rowActions(action(archived ? '恢复项目' : '归档项目', 'archive'))),
    panel('已授权成员', list(members, member => item(member.displayName, '', badge(member.state) +
      rowActions(action('撤销访问', 'revoke-access', member.id))), '暂无单独授权的成员。') + access),
  ));
  ctx.form('rename', async data => {
    await ctx.api(endpoint, { method: 'PATCH', body: { name: data.get('name') } });
    ctx.complete('项目名称已更新');
  });
  ctx.click('archive', async () => {
    if (!confirm((archived ? '恢复' : '归档') + '「' + project.name + '」？')) return;
    await ctx.api(endpoint, { method: 'PATCH', body: { state: archived ? 'active' : 'archived' } });
    ctx.complete('项目状态已更新');
  });
  ctx.form('grant', async data => {
    await ctx.api(endpoint + '/members/' + path(data.get('memberId')), { method: 'PUT' });
    ctx.complete('项目访问已授予');
  });
  ctx.click('revoke-access', async member => {
    if (!confirm('撤销该成员对此项目的访问权限？')) return;
    await ctx.api(endpoint + '/members/' + path(member), { method: 'DELETE' });
    ctx.complete('项目访问已撤销');
  });
}
