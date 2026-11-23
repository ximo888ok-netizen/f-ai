import { h, heading, link, notice, path } from './live-ui.js';

const tabs = { experts: '专家', skills: '技能', connections: '连接器' };

async function connectedEntries(ctx) {
  const [cloud, feishu] = await Promise.all([
    ctx.api('/v1/cloud-assets/status'),
    ctx.manager ? ctx.api('/v1/channels/feishu?limit=1') : null,
  ]);
  return [
    { name: 'WebDAV 网盘', description: '备份素材与恢复文件', state: cloud.available ? '已接入' : '待配置', route: 'cloud-assets' },
    { name: '飞书消息', description: '接收并回复工作区私聊消息', state: feishu ? (feishu.available ? '已接入' : '待配置') : '管理员可管理', route: 'feishu' },
  ];
}

async function catalogEntries(ctx, tab) {
  if (tab === 'connections') return connectedEntries(ctx);
  const entries = await ctx.all('/v1/library' + (tab === 'skills' ? '?kind=skill' : ''));
  return entries.filter(entry => tab === 'skills' || entry.kind === 'expert' || entry.kind === 'team')
    .map(entry => ({
      name: entry.name,
      description: entry.description,
      state: entry.enabled ? '已启用' : '已停用',
      category: entry.kind === 'team' ? '专家团' : tabs[tab],
      route: (tab === 'skills' ? 'skills/' : 'library/experts/') + path(entry.id),
    }));
}

function capabilityCard(entry) {
  const icon = [...entry.name][0];
  return '<a class="card directory-card" href="#' + h(entry.route) + '"><span class="directory-icon" aria-hidden="true">' +
    h(icon) + '</span><div><h2>' + h(entry.name) + '</h2>' + notice(entry.description) +
    '<small>' + h([entry.category, entry.state].filter(Boolean).join(' · ')) + '</small></div><span aria-hidden="true">↗</span></a>';
}

export async function capabilityCenter(ctx) {
  const tab = Object.hasOwn(tabs, ctx.args[0]) ? ctx.args[0] : 'experts';
  const entries = await catalogEntries(ctx, tab);
  if (!ctx.active()) return;
  const actions = tab === 'skills' && ctx.manager ? link('新增技能', 'skills/new')
    : tab === 'experts' && ctx.manager ? link('管理专家', 'library/experts')
    : tab === 'connections' && ctx.enterprise && ctx.manager ? '<a class="smallbtn" href="/merchant#connections">管理接入</a>' : '';
  ctx.html('<section class="studio-directory" aria-label="能力中心">' + heading('能力中心') +
    '<div class="directory-toolbar"><nav aria-label="能力类别">' + Object.entries(tabs).map(([id, label]) =>
      '<a class="smallbtn" href="#capabilities/' + id + '"' + (id === tab ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') +
    '</nav><div><input type="search" aria-label="搜索' + tabs[tab] + '" placeholder="搜索' + tabs[tab] + '">' + actions + '</div></div>' +
    '<div class="directory-grid">' + entries.map(capabilityCard).join('') + '</div><p class="live-muted" data-directory-empty role="status"' +
    (entries.length ? ' hidden' : '') + '>没有符合条件的' + tabs[tab] + '。</p></section>');
  const search = document.querySelector('.studio-directory input');
  const cards = [...document.querySelectorAll('.directory-card')];
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    for (const card of cards) card.hidden = !card.textContent.toLowerCase().includes(query);
    document.querySelector('[data-directory-empty]').hidden = cards.some(card => !card.hidden);
  });
}
