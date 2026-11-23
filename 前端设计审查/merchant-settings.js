import { bindReadiness } from './merchant-readiness.js';
import { action, date, field, form, grid, h, input, item, list, notice, panel, path, select } from './live-ui.js';
import { badge, logs, rowActions, sectionTitle } from './merchant-ui.js';

function releaseControl(feature) {
  const releases = feature.releases.map(release => [release.version, release.version === 'builtin' ? '部署内置版本' : release.version]);
  if (!releases.some(([id]) => id === feature.version)) releases.unshift([feature.version, feature.version + '（历史配置）']);
  return field('生效版本', select('version', releases, feature.version)) +
    '<details><summary>查看更新说明</summary>' + list(feature.releases, release => item(release.version, release.notes)) + '</details>';
}

export async function featuresPage(ctx) {
  const [directory, members] = await Promise.all([ctx.api('/v1/merchant/features'), ctx.all('/v1/members?state=active')]);
  const rows = directory.items.map(feature => {
    const selected = new Set(feature.memberIds);
    const memberInputs = members.map(member => '<label><input type="checkbox" name="memberId" value="' + h(member.id) + '"' +
      (selected.has(member.id) ? ' checked' : '') + '> ' + h(member.displayName + ' · ' + member.email) + '</label>').join('');
    const controls = field('企业开关', select('enabled', [['true', '启用'], ['false', '停用']], String(feature.enabled))) +
      field('开放范围', select('mode', [['all', '全企业'], ['trial', '指定成员试用']], feature.mode)) +
      releaseControl(feature) + '<fieldset data-trial-members' + (feature.mode === 'trial' ? '' : ' hidden') +
      '><legend>试用名单</legend><div class="merchant-list">' + (memberInputs || notice('暂无可选成员。')) + '</div></fieldset>';
    return '<details name="merchant-feature-editor" class="merchant-feature-row"><summary><strong>' + h(feature.name) +
      '</strong><span>' + badge(feature.enabled ? 'active' : 'suspended') + '</span><span>' +
      (feature.provisioned ? '能力已配置' : '服务未配置') + '</span><span>' +
      (feature.mode === 'trial' ? '试用 · ' + selected.size + ' 人' : '全企业') + '</span><span class="merchant-feature-toggle">设置</span></summary>' +
      form('feature-' + feature.id, controls, '保存功能设置') + '</details>';
  });
  ctx.html(sectionTitle('功能管理', ctx.workspace.name) + panel('企业功能', rows.join('')));
  if (!ctx.active()) return;
  for (const mode of document.querySelectorAll('#merchantContent [name=mode]')) {
    mode.addEventListener('change', () => {
      mode.form.querySelector('[data-trial-members]').hidden = mode.value !== 'trial';
    });
  }
  for (const feature of directory.items) ctx.form('feature-' + feature.id, async data => {
    const enabled = data.get('enabled') === 'true';
    const mode = data.get('mode');
    if (feature.enabled && !enabled && !confirm('停用「' + feature.name + '」后将阻止本企业的新操作。继续？')) return;
    const ids = mode === 'trial' ? data.getAll('memberId') : [];
    if (mode === 'trial' && (ids.length < 1 || ids.length > 100)) throw new Error('请选择 1 至 100 位试用成员。');
    await ctx.api('/v1/merchant/features/' + path(feature.id), { method: 'PUT', body: {
      enabled, mode, version: data.get('version'), revision: feature.revision, memberIds: ids,
    } });
    ctx.complete('功能设置已保存');
  });
}

const connectorNames = { model: '模型别名', feishu: '飞书', webdav: '网盘', shop: '店铺' };

export async function connectionsPage(ctx) {
  const { items } = await ctx.api('/v1/merchant/connections');
  const owner = ctx.workspace.role === 'owner';
  ctx.html(sectionTitle('项目接入', '查看已由部署方提供的服务，按企业启用、检查或断开。') + panel('可管理的接入',
    list(items, (connection, index) => item(connection.name, connectorNames[connection.kind] + ' · 最近检查 ' + date(connection.checkedAt),
      '<div class="merchant-feature-state">' + badge(connection.enabled ? 'active' : '已断开') +
        badge(connection.canCheck ? connection.checkState : '凭据由部署方管理') + '</div>' +
        (owner ? rowActions(connection.canCheck ? action('检查连接', 'check', index) : '',
          action(connection.enabled ? '断开连接' : '启用连接', 'toggle-connection', index)) : '')),
    '当前企业没有已配置的服务。由部署方准备对应的模型、店铺或连接凭据后，这里会显示接入项。') +
    (owner ? '' : notice('企业所有者可以检查或调整连接。'))) + panel('工作区接入概况',action('读取当前接入能力','readiness')+'<div data-readiness-result aria-live="polite"></div>'));
  bindReadiness(ctx);
  const endpoint = connection => '/v1/merchant/connections/' + path(connection.kind) + '/' + path(connection.id);
  ctx.click('check', async index => {
    const result = await ctx.api(endpoint(items[Number(index)]) + '/check', { method: 'POST' });
    ctx.complete(result.checkState === 'reachable' ? '连接检查通过' : '连接检查失败，请核对部署配置。');
  });
  ctx.click('toggle-connection', async index => {
    const connection = items[Number(index)];
    const enabled = !connection.enabled;
    if (!confirm((enabled ? '启用' : '断开') + '「' + connection.name + '」？')) return;
    await ctx.api(endpoint(connection), { method: 'PUT', body: { enabled, revision: connection.revision } });
    ctx.complete('连接状态已更新');
  });
}

export async function auditPage(ctx) {
  const query = new URLSearchParams({ limit: 30 });
  const { auditFilters, auditCursor } = ctx.state;
  if (auditFilters.action) query.set('action', auditFilters.action);
  if (auditFilters.targetId) query.set('targetId', auditFilters.targetId);
  if (auditFilters.from) query.set('from', auditFilters.from);
  if (auditCursor) {
    query.set('beforeAt', auditCursor.occurredAt);
    query.set('beforeId', auditCursor.id);
  }
  const result = await ctx.api('/v1/merchant/audit-events?' + query);
  const filter = '<form class="merchant-filter" data-form="audit-filter">' +
    field('操作类型', input('action', 'maxlength="64" value="' + h(auditFilters.action) + '"')) +
    field('对象 ID', input('targetId', 'maxlength="128" value="' + h(auditFilters.targetId) + '"')) +
    field('开始日期', input('from', 'type="date" value="' + h(auditFilters.from?.slice(0, 10)) + '"')) +
    '<button class="smallbtn">查询</button></form>';
  ctx.html(sectionTitle('管理操作记录', '核对本企业成员、项目、功能和连接的变更。') + filter + action('导出筛选记录','audit-export') + logs(result.items,
    rowActions(auditCursor ? action('返回最新', 'audit-reset') : '', result.hasMore ? action('下一页', 'audit-next') : '')));
  ctx.click('audit-export',async()=>{
    const params=new URLSearchParams(query);params.delete('beforeAt');params.delete('beforeId');params.set('limit','100');
    const records=[];
    for (;;) {
      const page=await ctx.api('/v1/merchant/audit-events?'+params);
      records.push(...page.items);
      if (!page.hasMore)break;
      const last=page.items.at(-1);
      if(!last || last.id===params.get('beforeId'))throw new Error('审计游标未前进，请重新查询。');
      params.set('beforeAt',last.occurredAt);params.set('beforeId',last.id);
    }
    if(!ctx.active())return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(records,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='商家操作记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
  });
  ctx.form('audit-filter', data => {
    ctx.state.auditFilters = { action: data.get('action').trim(), targetId: data.get('targetId').trim(),
      from: data.get('from') ? new Date(data.get('from') + 'T00:00:00').toISOString() : '' };
    ctx.state.auditCursor = null;
    ctx.reload();
  });
  ctx.click('audit-next', () => { ctx.state.auditCursor = result.items.at(-1); ctx.reload(); });
  ctx.click('audit-reset', () => { ctx.state.auditCursor = null; ctx.reload(); });
}
