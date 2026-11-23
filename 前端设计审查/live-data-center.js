import { date, h, heading, item, link, path } from './live-ui.js';

const tabs = { knowledge: '知识库', files: '工作区素材' };

export async function dataCenter(ctx) {
  const tab = ctx.args[0] === 'files' ? 'files' : 'knowledge';
  const endpoint = tab === 'files' ? '/v1/assets' : '/v1/knowledge/bases';
  const { items } = await ctx.api(endpoint + '?limit=25');
  const information = tab === 'files' ? '当前账号最近上传的素材。' : '当前账号有权访问的知识库。';
  const record = row => '<a class="data-record" href="#' + (tab === 'files' ? 'assets/' : 'resources/') + path(row.id) + '">' +
    '<strong>' + h(row.name) + '</strong><span>' + h(tab === 'files' ? row.mediaType : '知识库') + '</span><time>' +
    h(date(row.createdAt)) + '</time></a>';
  ctx.html('<div class="studio-data"><aside class="card data-rail" aria-label="资料导航"><h2>资料库</h2><nav>' +
    Object.entries(tabs).map(([id, label]) => '<a class="smallbtn" href="#data/' + id + '"' +
      (id === tab ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') +
    '<hr>' + link('个人记忆', 'resources/memory/personal') + link('我的项目', 'projects') + '</nav></aside>' +
    '<section class="data-main">' + heading(tabs[tab], information) +
    '<div class="live-row">' + (tab === 'files' ? link('打开素材库', 'assets') : link('管理与检索知识库', 'resources')) + '</div>' +
    '<div class="card data-records">' + (items.length ? items.map(record).join('') :
      item(tab === 'files' ? '暂无工作区素材' : '暂无可访问的知识库')) + '</div></section></div>');
}
