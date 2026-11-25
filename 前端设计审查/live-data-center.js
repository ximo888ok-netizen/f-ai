import { date, h, heading, item, link, path } from './live-ui.js';
import { studioIcon } from './studio-icons.js';

const tabs = { knowledge: '知识库', files: '工作区素材' };

export async function dataCenter(ctx) {
  const tab = ctx.args[0] === 'files' ? 'files' : 'knowledge';
  const endpoint = tab === 'files' ? '/v1/assets' : '/v1/knowledge/bases';
  const { items } = await ctx.api(endpoint + '?limit=25');
  const information = tab === 'files' ? '当前账号最近上传的素材。' : '当前账号有权访问的知识库。';
  const record = row => '<a class="data-record" href="#' + (tab === 'files' ? 'assets/' : 'resources/') + path(row.id) + '">' +
    '<strong>' + h(row.name) + '</strong><span>' + h(tab === 'files' ? row.mediaType : '知识库') + '</span><time>' +
    h(date(row.createdAt)) + '</time></a>';
  ctx.html('<div class="studio-data">' + heading('资料库') +
    '<aside class="data-rail" aria-label="资料导航"><nav>' +
    Object.entries(tabs).map(([id, label]) => '<a class="smallbtn" href="#data/' + id + '"' +
      (id === tab ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') + '</nav>' +
    '<div class="data-shortcuts">' + link('个人记忆', 'resources/memory/personal') + link('我的项目', 'projects') + '</div></aside>' +
    '<section class="card data-main data-records"><div class="data-list-heading"><div><h2>' + tabs[tab] +
    '</h2><p class="live-muted">' + information + '</p></div>' +
    (tab === 'files' ? link('打开素材库', 'assets') : link('管理与检索知识库', 'resources')) + '</div>' +
    (items.length ? items.map(record).join('') : '<div class="data-empty">' + studioIcon('data') +
      item(tab === 'files' ? '暂无工作区素材' : '暂无可访问的知识库') + '</div>') + '</section></div>');
}
