export const deskSections = {
  image: { label: '图片生成' },
  'customer-service': { label: 'AI客服', links: [['快捷话术', 'customer/replies'], ['查看知识库', 'resources']] },
  operations: { label: 'AI运营', links: [['查看店铺', 'shops'], ['运营台账', 'commerce'], ['商品档案', 'products'], ['投放收益测算', 'roi']] },
  video: { label: '视频生成' },
  copywriting: { label: '电商文案', links: [['创作文案', 'create/copywriting']] },
};

export function productionSection(route, args) {
  if (route === 'desk') return Object.hasOwn(deskSections, args[0]) ? args[0] : 'image';
  if (route === 'create' && Object.hasOwn(deskSections, args[0])) return args[0];
  if (['shops', 'products', 'roi', 'drafts', 'commerce'].includes(route)) return 'operations';
  if (route === 'customer') return 'customer-service';
  if (route === 'copy-review') return 'copywriting';
  if (route === 'psd' || (route === 'media' && args[0] === 'images')) return 'image';
  if (route === 'media' && ['storyboards', 'video'].includes(args[0])) return 'video';
  return '';
}

export async function commerceHome(ctx) {
  const [catalog, policies] = await Promise.all([ctx.api('/v1/plugins'),
    ctx.enterprise && ctx.manager ? ctx.api('/v1/merchant/features') : null]);
  if (!ctx.active()) return;
  const layout = document.querySelector('#native-directory-template').content.firstElementChild.cloneNode(true);
  const plugins = new Map(catalog.items.map(plugin => [plugin.id, plugin]));
  const features = new Map(policies?.items.map(policy => [policy.id, policy]) ?? []);
  const working = catalog.items.filter(plugin => plugin.enabled).length;
  layout.querySelector('[data-live-plan]').textContent = ctx.enterprise ? '企业工作区' : '个人工作区';
  layout.querySelector('#enabledPluginCount').textContent = working + ' / ' + plugins.size;
  layout.querySelector('#pluginStatus').textContent = working + ' 个已启用';
  const cards = Array.from(layout.querySelectorAll('[data-scene]'));
  for (const card of cards) {
    const id = card.dataset.scene;
    const plugin = plugins.get(id), policy = features.get(id);
    if (!plugin) { card.remove(); continue; }
    const button = card.querySelector('[data-switch-scene]');
    const status = policy?.enabled ?? plugin.enabled;
    button.setAttribute('aria-checked',String(status));
    button.disabled = !ctx.manager;
    card.querySelector('[data-scene-count]').textContent = plugin.capabilities.length + ' 项能力';
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const enabled = !status;
      if (!enabled && !confirm('停用「' + plugin.name + '」将阻止提交该插件的新任务。继续？')) return;
      button.disabled = true;
      try {
        if (policy) {
          const { mode, version, revision, memberIds } = policy;
          await ctx.api('/v1/merchant/features/' + encodeURIComponent(id), { method: 'PUT', body: { enabled, mode, version, revision, memberIds } });
        } else {
          await ctx.api('/v1/plugins/' + encodeURIComponent(id) + '/state', { method: 'PUT', body: { enabled } });
        }
        if (ctx.active()) ctx.reload();
      } catch (error) {
        if (ctx.active()) { layout.querySelector('[data-directory-status]').textContent = error.message; button.disabled = !ctx.manager; }
      }
    });
  }
  const status = document.createElement('p');
  status.dataset.directoryStatus = '';
  status.setAttribute('role','status');
  layout.append(status);
  const library = layout.querySelector('.slot');
  layout.querySelector('#workbenchSearch').addEventListener('input', event => {
    const term = event.target.value.trim().toLowerCase();
    let matches = 0;
    for (const card of cards) {
      const plugin = plugins.get(card.dataset.scene);
      if (!plugin) continue;
      const words = [card.dataset.pluginName, ...plugin.capabilities.map(c => c.name)].join(' ').toLowerCase();
      card.hidden = !words.includes(term);
      if (!card.hidden) matches++;
    }
    library.hidden = !!term;
    status.textContent = matches ? '' : '没有匹配的插件或能力。';
  });
  const business = document.querySelector('.business-root');
  business.before(layout);
  business.hidden = true;
  ctx.signal.addEventListener('abort', () => { layout.remove(); business.hidden = false; }, { once: true });
}
