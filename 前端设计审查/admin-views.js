import { h, date, select } from './live-ui.js';
import { roles, modelKinds } from './admin-demo.js';
import { tabs, connection, contracts, hasCredential } from './admin-data.js';

const money = (cents) =>
  '¥' + (Number(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = (n) => Number(n).toLocaleString('zh-CN');
export const tabLink = (id, label = tabs[id]) =>
  '<a class="adm-btn" href="#admin/' + h(id) + '">' + h(label) + '</a>';
export const control = (type, label, id = '', className = '') =>
  '<button class="adm-btn ' +
  h(className) +
  '" type="button" data-admin-action="' +
  h(type) +
  '" data-id="' +
  h(id) +
  '">' +
  h(label) +
  '</button>';
const badge = (text) => '<span class="adm-pill">' + h(text) + '</span>';
const empty = (message) => '<p class="adm-muted">' + h(message) + '</p>';
const actions = (...items) => '<div class="adm-actions-cell">' + items.join('') + '</div>';
const panel = (name, body, tools = '') =>
  '<section class="adm-panel"><div class="adm-panel-head"><h2 class="adm-panel-title">' +
  h(name) +
  '</h2>' +
  tools +
  '</div>' +
  body +
  '</section>';
const table = (labels, rows, missing) =>
  rows.length
    ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
      labels.map((label) => '<th scope="col">' + h(label) + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>'
    : empty(missing);
const toggle = (type, id, enabled, label) =>
  '<button type="button" class="adm-switch" role="switch" aria-label="' +
  h(label) +
  '" aria-checked="' +
  Boolean(enabled) +
  '" data-admin-action="' +
  h(type) +
  '" data-id="' +
  h(id) +
  '"><span class="adm-switch-track"></span></button>';
const subcard = (name, body, buttons) =>
  '<article class="adm-subcard"><div class="adm-subcard-head"><h3>' +
  h(name) +
  '</h3></div>' +
  body +
  buttons +
  '</article>';
const options = (label, key, values, selected) =>
  '<label>' +
  h(label) +
  ' ' +
  select(
    key,
    [['', '全部'], ...Object.entries(values)],
    selected,
    'class="adm-select" data-filter="' + h(key) + '"'
  ) +
  '</label>';

export function shell(ctx, tab, body, status = '') {
  const local = connection(ctx).mode === 'demo';
  return (
    '<div class="admin-shell"><div class="admin-topbar"><div class="admin-topbar-left"><nav class="admin-breadcrumb" aria-label="所在位置"><a href="#settings">设置与诊断</a> / ' +
    h(tabs[tab]) +
    '</nav><div class="admin-title-row"><h1>管理员控制台</h1>' +
    badge(local ? '本地演示' : '自建后端') +
    '</div></div><div class="admin-topbar-right">' +
    (local ? badge('超级管理员权限 · 演示') : badge('使用后台管理凭据')) +
    '</div></div>' +
    '<nav class="adm-tabs" aria-label="管理模块">' +
    Object.entries(tabs)
      .map(
        ([id, label]) =>
          '<a class="adm-tab' +
          (id === tab ? ' active' : '') +
          '" href="#admin/' +
          id +
          '"' +
          (id === tab ? ' aria-current="page"' : '') +
          '>' +
          label +
          '</a>'
      )
      .join('') +
    '</nav>' +
    '<p class="adm-muted" role="status" data-admin-status>' +
    h(status) +
    '</p>' +
    body +
    '</div>'
  );
}

function chart(trend) {
  const maxRevenue = Math.max(1, ...trend.map((x) => x.revenueCents)),
    maxUsage = Math.max(1, ...trend.map((x) => x.usage));
  const bars = trend
    .map((d, i) => {
      const x = 36 + i * 78,
        revenue = (92 * d.revenueCents) / maxRevenue,
        use = (92 * d.usage) / maxUsage;
      const desc = d.date + ' 入账 ' + money(d.revenueCents) + '，消耗 ' + number(d.usage) + ' 积分';
      return (
        '<g><title>' +
        h(desc) +
        '</title><rect class="revenue" x="' +
        x +
        '" y="' +
        (124 - revenue) +
        '" width="14" height="' +
        revenue +
        '"/>' +
        '<rect class="usage" x="' +
        (x + 18) +
        '" y="' +
        (124 - use) +
        '" width="14" height="' +
        use +
        '"/><text x="' +
        (x + 15) +
        '" y="147" text-anchor="middle" fill="currentColor">' +
        h(d.date.slice(5)) +
        '</text></g>'
      );
    })
    .join('');
  return (
    '<div class="adm-legend"><span><i class="revenue"></i>充值收入（元）</span><span><i class="usage"></i>消耗（积分）</span></div>' +
    '<svg class="adm-trend-svg" viewBox="0 0 560 160" role="img" aria-label="最近七天充值收入与积分消耗，两个单位分别按最高值缩放">' +
    '<path d="M18 124H548" stroke="currentColor" opacity=".24"/>' +
    bars +
    '</svg>' +
    '<details><summary>查看每日数值</summary>' +
    table(
      ['日期', '充值收入', '积分消耗'],
      trend.map((d) => [h(d.date), money(d.revenueCents), number(d.usage)]),
      '暂无数据'
    ) +
    '</details>'
  );
}
export function overviewView(data) {
  const { totals, trend, audit } = data;
  return (
    '<div class="adm-kpi-grid">' +
    [
      ['总注册用户', number(totals.users)],
      ['累计入账金额', money(totals.revenueCents)],
      ['用户流通积分池', number(totals.credits)],
      ['启用模型通道', number(totals.models)]
    ]
      .map(
        ([k, v]) =>
          '<article class="adm-kpi-card"><span class="adm-kpi-head">' +
          k +
          '</span><strong class="adm-kpi-val">' +
          h(v) +
          '</strong></article>'
      )
      .join('') +
    '</div>' +
    panel('近 7 日充值与消耗', chart(trend)) +
    panel(
      '管理审计日志',
      audit.length
        ? '<div class="adm-log-list">' +
            audit
              .map(
                (e) =>
                  '<div class="adm-log-item"><span>' +
                  h(e.actor) +
                  ' · ' +
                  h(e.message) +
                  '</span><time>' +
                  h(date(e.at)) +
                  '</time></div>'
              )
              .join('') +
            '</div>'
        : empty('暂无管理操作记录。'),
      control('refresh', '刷新')
    )
  );
}

export function userRows(data, filters) {
  const term = (filters.search || '').trim().toLowerCase();
  const users = data.users.filter(
    (u) =>
      (!filters.role || u.role === filters.role) &&
      (!filters.status || (u.enabled ? 'enabled' : 'disabled') === filters.status) &&
      [u.name, u.id, u.email].some((v) => String(v).toLowerCase().includes(term))
  );
  return table(
    ['用户 / ID', '邮箱', '角色', '积分', '启用', '操作'],
    users.map((u) => [
      '<strong>' + h(u.name) + '</strong><div class="adm-muted adm-mono">' + h(u.id) + '</div>',
      h(u.email),
      h(roles[u.role]),
      number(u.balance),
      toggle('user-status', u.id, u.enabled, '启用用户 ' + u.name),
      actions(
        control('user', '编辑', u.id),
        control('adjust', '调积分', u.id),
        control('user-delete', '删除', u.id, 'danger')
      )
    ]),
    '没有匹配的用户。'
  );
}
export function usersView(data, filters) {
  return panel(
    '用户管理',
    '<div class="adm-toolbar"><input type="search" class="adm-input adm-search" data-filter="search" aria-label="搜索姓名、邮箱或 ID" placeholder="搜索姓名、邮箱或 ID" value="' +
      h(filters.search) +
      '">' +
      options('角色', 'role', roles, filters.role) +
      options('状态', 'status', { enabled: '正常', disabled: '已禁用' }, filters.status) +
      '</div><div data-filter-results>' +
      userRows(data, filters) +
      '</div>',
    control('user', '新增用户', '', 'primary')
  );
}
export function creditsView(data) {
  return (
    panel(
      '充值档位',
      '<div class="adm-grid-3">' +
        data.tiers
          .map((t) =>
            subcard(
              t.name,
              '<span class="adm-price">' +
                money(t.priceCents) +
                '</span><p>' +
                number(t.base) +
                ' 基础积分 · ' +
                number(t.bonus) +
                ' 赠送积分</p>',
              actions(toggle('tier-status', t.id, t.enabled, '上架 ' + t.name), control('tier', '编辑档位', t.id))
            )
          )
          .join('') +
        '</div>',
      control('tier', '新增档位')
    ) +
    panel(
      '功能扣费倍率',
      table(
        ['功能', '积分倍率', '操作'],
        data.rules.map((r) => [h(r.name), h(r.multiplier) + '×', control('rule', '编辑倍率', r.id)]),
        '暂无扣费规则。'
      )
    ) +
    panel(
      '充值订单',
      table(
        ['入账时间', '订单号', '用户', '入账金额'],
        data.orders.map((o) => [h(date(o.at)), h(o.id), h(o.userName), money(o.amountCents)]),
        '暂无已入账订单。'
      )
    ) +
    panel(
      '积分流水',
      table(
        ['时间', '用户', '变动', '变动后余额', '原因'],
        data.ledger.map((l) => [
          h(date(l.at)),
          h(l.userName),
          h((l.delta > 0 ? '+' : '') + l.delta),
          number(l.balance),
          h(l.reason)
        ]),
        '暂无积分变动。'
      ),
      control('adjust', '手动调账', '', 'primary')
    )
  );
}
export function subscriptionsView(data) {
  return (
    panel(
      '订阅套餐',
      '<div class="adm-grid-3">' +
        data.plans
          .map((p) =>
            subcard(
              p.name,
              '<span class="adm-price">' +
                money(p.priceCents) +
                ' <small>/ 月</small></span>' +
                '<p>月赠 ' +
                number(p.monthlyCredits) +
                ' 积分 · ' +
                number(p.seats) +
                ' 个并发席位</p>',
              control('plan', '编辑套餐', p.id)
            )
          )
          .join('') +
        '</div>'
    ) +
    panel(
      '用户订阅',
      table(
        ['用户', '套餐', '到期时间', '状态', '操作'],
        data.subscriptions.map((s) => {
          const active = !s.cancelled && Date.parse(s.until) > Date.now();
          return [
            h(s.userName),
            h(data.plans.find((p) => p.id === s.planId)?.name),
            h(date(s.until)),
            badge(s.cancelled ? '已取消' : active ? '活跃' : '已到期'),
            s.cancelled
              ? '—'
              : actions(control('renew', '续费 30 天', s.id), control('cancel-sub', '取消订阅', s.id, 'danger'))
          ];
        }),
        '暂无订阅。'
      ),
      control('subscribe', '手动开通', '', 'primary')
    )
  );
}
export function modelRows(data, filters) {
  const models = data.models.filter((m) => !filters.kind || m.kind === filters.kind);
  return table(
    ['Provider / Model ID', '类型', '服务地址', 'API Key', '倍率', '启用', '操作'],
    models.map((m) => [
      '<strong>' +
        h(m.name) +
        '</strong><div class="adm-mono">' +
        h(m.modelId) +
        '</div>' +
        (m.isDefault ? badge('默认路由') : ''),
      h(modelKinds[m.kind]),
      h(m.baseUrl),
      m.hasKey ? '••••••••' : '未设置',
      h(m.multiplier) + '×',
      toggle('model-status', m.id, m.enabled, '启用模型 ' + m.modelId),
      actions(
        control('model-test', '测试连通性', m.id),
        control('model', '编辑', m.id),
        control('model-delete', '移除', m.id, 'danger')
      )
    ]),
    '没有匹配的模型通道。'
  );
}
export function modelsView(data, filters) {
  return panel(
    '模型通道',
    '<div class="adm-toolbar">' +
      options('类型', 'kind', modelKinds, filters.kind) +
      '</div><div data-filter-results>' +
      modelRows(data, filters) +
      '</div>',
    control('model', '新增模型', '', 'primary')
  );
}
export function serverView(ctx) {
  const conf = connection(ctx);
  return (
    panel(
      '服务器配置',
      '<dl class="live-facts"><dt>运行模式</dt><dd>' +
        h(conf.mode === 'demo' ? '本地演示' : '对接自建后端') +
        '</dd><dt>Base URL</dt><dd>' +
        h(conf.baseUrl || '未设置') +
        '</dd><dt>鉴权方式</dt><dd>' +
        h(conf.auth === 'bearer' ? 'Bearer JWT' : 'X-Admin-Secret') +
        '</dd><dt>管理凭据</dt><dd>' +
        h(hasCredential(ctx) ? '已在本次登录中设置' : '未设置') +
        '</dd><dt>支付回调 Webhook</dt><dd>' +
        h(conf.webhook || '未设置') +
        '</dd><dt>请求超时</dt><dd>' +
        number(conf.timeout) +
        ' 毫秒</dd></dl>' +
        actions(
          control('config', '编辑连接配置', '', 'primary'),
          control('health', conf.mode === 'demo' ? '模拟健康检查' : '检查 /health'),
          control('export', '导出配置 JSON')
        )
    ) +
    panel(
      '后端接口约定',
      '<ul class="adm-feature-list">' +
        Object.values(contracts)
          .map((s) => '<li><code>' + h(s) + '</code></li>')
          .join('') +
        '</ul>'
    )
  );
}
