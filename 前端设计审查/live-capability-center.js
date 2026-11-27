import { h, notice } from './live-ui.js';
import { studioIcon } from './studio-icons.js';
import { libraryDirectory, libraryTabs } from './library-directory.js';

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

export async function capabilityCenter(ctx) {
  const tab = ctx.args[0] ?? 'experts';
  if (tab !== 'connections') return libraryDirectory(ctx, tab === 'skills' ? 'skills' : 'experts');
  const entries = await connectedEntries(ctx);
  if (!ctx.active()) return;
  const manage = ctx.enterprise && ctx.manager ? '<a class="smallbtn" href="/merchant#connections">管理接入</a>' : '';
  ctx.html('<section class="studio-directory lib-directory"><h1 class="lib-sr">能力中心</h1><div class="lib-top">' +
    libraryTabs(tab) + '<div class="lib-tools"><label class="lib-search">' + studioIcon('search') +
    '<input type="search" aria-label="搜索连接器" placeholder="搜索连接器"></label>' + manage + '</div></div>' +
    '<div class="directory-grid">' + entries.map(entry => '<a class="card directory-card" href="#' + h(entry.route) +
      '"><div class="directory-card-head"><span class="directory-icon">' + studioIcon('connections') + '</span><small>' +
      h(entry.state) + '</small></div><h2>' + h(entry.name) + '</h2><div class="directory-card-detail">' +
      notice(entry.description) + studioIcon('outward') + '</div></a>').join('') +
    '</div><p class="live-muted" data-directory-empty hidden>没有符合条件的连接器。</p></section>');
  const root = document.querySelector('.studio-directory');
  const input = root.querySelector('input');
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    const cards = [...root.querySelectorAll('.directory-card')];
    for (const card of cards) card.hidden = !card.textContent.toLowerCase().includes(query);
    root.querySelector('[data-directory-empty]').hidden = cards.some(card => !card.hidden);
  });
}
