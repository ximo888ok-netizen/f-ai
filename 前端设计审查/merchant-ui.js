import { action, date, h, heading, item, list, panel } from './live-ui.js';

export const roleNames = { owner: '企业所有者', admin: '企业管理员', member: '普通成员' };
const statusTone = { active: 'success', suspended: 'warning', pending: 'progress', reachable: 'success', failed: 'error' };
const statusText = {
  active: '启用', suspended: '已停用', pending: '待接受', accepted: '已接受', revoked: '已撤回', expired: '已过期',
  unverified: '待验证', reachable: '连接检查通过', failed: '连接检查失败',
};
export const badge = status => '<span class="tag" data-tone="' + (statusTone[status] ?? 'neutral') + '">' + h(statusText[status] ?? status) + '</span>';
export const rowActions = (...items) => '<div class="merchant-actions">' + items.join('') + '</div>';

export function sectionTitle(title, detail, controls = '') {
  return '<div class="merchant-heading">' + heading(title, detail) + controls + '</div>';
}

export function table(label, headers, items, render) {
  if (!items.length) return '<div class="ui-empty"><strong>没有匹配记录</strong><p>可以更换筛选条件或创建一条记录。</p></div>';
  return '<div class="ui-table-scroll" role="region" tabindex="0" aria-label="' + h(label) + '"><table class="live-table merchant-table"><thead><tr>' +
    headers.map(column => '<th scope="col">' + h(column) + '</th>').join('') +
    '</tr></thead><tbody>' + items.map(value => '<tr>' + render(value).map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}

export function paging(offset, count, limit) {
  return '<div class="merchant-page-nav">' +
    (offset > 0 ? action('上一页', 'page', Math.max(0, offset - limit)) : '') +
    (count === limit ? action('下一页', 'page', offset + limit) : '') + '</div>';
}

export function logs(items, next) {
  return panel('操作记录', list(items, event => item(event.action, date(event.occurredAt) + ' · 对象 ' + event.targetId,
    '<details><summary>查看详情</summary><p class="live-muted">操作者 ' + h(event.actorName) + ' · 请求 ' + h(event.requestId) +
      '</p><pre class="live-result">' + h(JSON.stringify(event.detail, null, 2)) + '</pre></details>')) + next);
}
