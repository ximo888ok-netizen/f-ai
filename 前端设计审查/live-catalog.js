import { experts } from './live-experts.js';
import { action, grid, h, heading, item, link, notice, panel, path } from './live-ui.js';
import { cardTitle } from './live-task-fields.js';

export const getCatalog = async ctx => {
  const directory = await ctx.api('/v1/plugins');
  return [...directory.items, directory.models];
};
const capLink = capability => capability.id.startsWith(capability.pluginId+'.skill-') ? 'desk/'+capability.pluginId+'/skills/'+capability.id :
  capability.endpoint ? 'customer' : 'create/' + capability.pluginId + '/' + capability.id;
export const displayStatus = (plugin, capability, ctx) => !plugin.enabled ? '工作区已停用' :
  plugin.id === 'operations' && !ctx.manager ? '需要工作区管理员权限' : capability.available ? '可用' : '服务未配置';

function catalogLink(name, route, detail) {
  return '<a class="live-catalog-link" href="#' + h(route) + '"><strong>' + h(name) +
    '</strong><small>' + h(detail) + '</small></a>';
}

function catalogGroup(title, markup) {
  return '<details class="card live-panel live-fold"><summary>' + h(title) +
    '</summary><div class="live-catalog-grid">' + markup + '</div></details>';
}

export function creationStart(plugins, ctx) {
  const primary = ['image', 'video', 'copywriting'];
  const entry = plugin => catalogLink(plugin.name, 'create/' + plugin.id,
    !plugin.enabled ? '当前未开放' : plugin.id === 'operations' && !ctx.manager ? '需要管理员权限' :
      plugin.capabilities.length + ' 项能力');
  const featured = primary.map(id => plugins.find(p => p.id === id)).filter(Boolean);
  const others = plugins.filter(p => !primary.includes(p.id));
  return heading('创作台') + panel('制作内容', '<div class="live-catalog-grid">' + featured.map(entry).join('') + '</div>') +
    (others.length ? catalogGroup('其他创作能力（' + others.length + '）', others.map(entry).join('')) : '') +
    link('浏览完整工具库', 'library');
}

export function capabilityLinks(plugin, ctx) {
  const options = [...plugin.capabilities].sort((a, b) => Number(b.available) - Number(a.available));
  return options.map(cap => catalogLink(cardTitle(cap), capLink(cap), displayStatus(plugin, cap, ctx) + ' · ' + cap.cost + ' 积分'));
}

export function capabilityList(plugin, ctx, localTools) {
  const links = capabilityLinks(plugin, ctx);
  return heading(plugin.name) + (localTools ? '<div class="live-row">' + localTools + '</div>' : '') +
    panel('制作功能', '<div class="live-catalog-grid">' + links.slice(0, 3).join('') + '</div>') +
    (links.length > 3 ? catalogGroup('更多功能（' + (links.length - 3) + '）', links.slice(3).join('')) : '');
}

export async function library(ctx) {
  if (ctx.args[0] === 'experts') return experts(ctx);
  const [plugins, settings] = await Promise.all([getCatalog(ctx), ctx.api('/v1/settings')]);
  const favorites = new Set(settings.preferences.favoriteCapabilities ?? []);
  const tile = (plugin, capability, editable) => item(cardTitle(capability),
    displayStatus(plugin, capability, ctx) + ' · ' + capability.cost + ' 积分',
    link('详情', capLink(capability)) + (editable ? action(favorites.has(capability.id) ? '取消收藏' : '收藏', 'favorite', capability.id) : ''));
  const savedItems = () => {
    const cards = plugins.flatMap(plugin => plugin.capabilities.filter(c => favorites.has(c.id)).map(c => tile(plugin, c, false)));
    return cards.length ? '<div class="live-grid">' + cards.join('') + '</div>' : notice('暂无收藏。');
  };
  ctx.html(heading('工具库') + '<div class="live-row">'+link('技能运行','skills')+link('专家与专家团','library/experts')+
    link('平台文案校验','copy-review')+link('图片与视频处理','media')+'</div>' +
    panel('我的收藏', '<div data-live-favorites>' + savedItems() + '</div>') +
    plugins.map(plugin => '<details class="card live-panel live-fold"><summary>' + h(plugin.name) +
      '（' + plugin.capabilities.length + '）</summary><div class="live-grid">' +
      plugin.capabilities.map(c => tile(plugin, c, true)).join('') + '</div></details>').join(''));
  let pendingFavorite = false;
  ctx.click('favorite', async id => {
    if (pendingFavorite) return;
    pendingFavorite = true;
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      await ctx.api('/v1/settings', { method:'PATCH', body:{ favoriteCapabilities:[...next] } });
      if (!ctx.active()) return;
      if (next.has(id)) favorites.add(id); else favorites.delete(id);
      for (const control of document.querySelectorAll('#main [data-favorite]')) {
        control.textContent = favorites.has(control.dataset.favorite) ? '取消收藏' : '收藏';
      }
      document.querySelector('[data-live-favorites]').innerHTML = savedItems();
    } finally { pendingFavorite = false; }
  });
}

export async function manager(ctx) {
  const plugins = await getCatalog(ctx);
  const merchant = ctx.enterprise && ctx.manager ? '<p><a class="smallbtn" href="/merchant#features">在商家后台设置</a></p>' : '';
  ctx.html(heading('插件能力', '查看当前工作区可用的功能。') + merchant + grid(...plugins.map(plugin => panel(plugin.name,
    item(plugin.enabled ? '已启用' : '已停用', plugin.capabilities.filter(cap => cap.available).length + ' 项已配置能力',
      ctx.manager && !ctx.enterprise ? action(plugin.enabled ? '停用' : '启用', 'plugin-state', plugin.id) : '') +
    link('查看能力', 'create/' + plugin.id)))));
  ctx.click('plugin-state', async id => {
    const plugin = plugins.find(plugin => plugin.id === id);
    await ctx.api('/v1/plugins/' + path(id) + '/state', { method: 'PUT', body: { enabled: !plugin.enabled } });
    ctx.reload();
  });
}
