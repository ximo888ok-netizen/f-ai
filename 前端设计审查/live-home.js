import { onboarding, bindOnboarding } from './live-onboarding.js';
import { date, h, heading, item, link, list, notice, panel, path } from './live-ui.js';
import { cardTitle } from './live-task-fields.js';
import { assetPreview } from './live-asset-preview.js';
import { mountDisplay } from './live-spatial.js';

const taskStates = { queued:'排队中', running:'执行中', succeeded:'已完成', failed:'失败', cancelled:'已取消' };

function recentDrafts(drafts) {
  if (!drafts.length) {
    return panel('商品草稿', '<div class="live-resume"><div class="live-resume-copy">' +
      notice('还没有保存的商品草稿。') + link('新建商品草稿', 'drafts/new') +
      '</div><div class="live-draft-photo" data-empty-display aria-hidden="true"></div></div>');
  }
  const [latest, ...others] = drafts;
  return panel('继续编辑', '<div class="live-resume"><div class="live-resume-copy"><h3>' + h(latest.title) + '</h3>' +
    notice('拼多多商品草稿 · ' + date(latest.updatedAt)) + link('继续编辑这份草稿', 'drafts/' + path(latest.id)) +
    '</div><div class="live-draft-photo" data-draft-photo></div></div>' +
    (others.length ? '<details class="live-fold"><summary>其他最近草稿（' + others.length + '）</summary>' +
      others.map(d => item(d.title, date(d.updatedAt), link('继续编辑', 'drafts/' + path(d.id)))).join('') + '</details>' : ''));
}

export async function dashboard(ctx) {
  const [wallet, catalog, tasks, messages, drafts, settings] = await Promise.all([
    ctx.api('/v1/credits/wallet'), ctx.api('/v1/plugins'), ctx.api('/v1/tasks?limit=5'),
    ctx.api('/v1/notifications?limit=1'), ctx.api('/v1/studio/pinduoduo-drafts?limit=3'), ctx.api('/v1/settings'),
  ]);
  const capabilityNames = new Map([...catalog.items, catalog.models].flatMap(plugin =>
    plugin.capabilities.map(c => [c.id, cardTitle(c)])));
  const tools = catalog.items.map(plugin => item(plugin.name, plugin.enabled
    ? plugin.capabilities.filter(c => c.available).length + ' 项服务可用' : '当前未开放',
    link('查看', { 'customer-service':'customer', operations:'shops' }[plugin.id] ?? 'create/' + plugin.id))).join('');
  ctx.html('<div class="live-desk-stage"><div class="live-home-title">' + heading('商品上新工作台', ctx.workspace.name) +
    '<a class="primary" href="#create">新建创作</a></div>' +
    recentDrafts(drafts.items) + '</div><div class="live-desk-lower">' +
    panel('最近任务', list(tasks.items, t => '<div class="live-task-line"><div><strong>' +
      h(capabilityNames.get(t.capabilityId) ?? t.capabilityId) + '</strong>' +
      '<p class="live-muted"><span class="task-state-dot" data-state="' + h(t.state) + '">' +
      h(taskStates[t.state] ?? t.state) + '</span> · ' + h(date(t.createdAt)) + '</p></div>' +
      link('查看任务', 'tasks/' + path(t.id)) + '</div>')) +
    '<div class="live-desk-tools"><div class="live-account-strip">' + link('可用 ' + wallet.available + ' 积分 · 预占 ' + wallet.reserved, 'account') +
    link('消息 · ' + messages.unread + ' 条未读', 'inbox') + '</div>' +
    '<details class="card live-fold live-panel"><summary>创作与经营</summary><div class="live-grid">' + tools + '</div></details>'+onboarding(settings.preferences)+'</div></div>');
  bindOnboarding(ctx);

  if (!ctx.active()) return;
  if (!drafts.items.length) {
    mountDisplay(document.querySelector('[data-empty-display]'), ctx.signal);
    return;
  }
  const holder = document.querySelector('[data-draft-photo]');
  try {
    const draft = await ctx.api('/v1/studio/pinduoduo-drafts/' + path(drafts.items[0].id));
    const image = draft.images.find(i => i.role === 'main');
    if (ctx.active() && image) {
      await assetPreview(ctx, holder)(image.assetId, draft.title + '主图');
      mountDisplay(holder, ctx.signal);
    }
  } catch { /* The draft link stays available if its optional thumbnail cannot be read. */ }
}
