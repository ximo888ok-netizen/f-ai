import { h } from './live-ui.js';
import { studioIcon as icon } from './studio-icons.js';
import { bindPopover } from './live-popover.js';
import { collections, directoryRecords, matchingRecords } from './library-collections.js';

const sections = { experts:['专家','members'], skills:['技能','capabilities'], connections:['连接器','connections'] };
const sorts = [['default','综合'], ['links','最多关联'], ['recent','最新']];
const choice = (key,value,label) => '<button type="button" data-lib-' + key + '="' + h(value) + '">' + h(label) + '</button>';
const link = (route,label) => '<a href="#' + h(route) + '">' + h(label) + '</a>';

export function libraryTabs(current) {
  return '<nav class="lib-tabs" aria-label="能力类别">' + Object.entries(sections).map(([id,[label,glyph]]) =>
    '<a href="#capabilities/' + id + '"' + (id === current ? ' aria-current="page"' : '') + '>' + icon(glyph) + label + '</a>').join('') + '</nav>';
}

function featureCard(group, records) {
  const picks = records.filter(item => item.enabled && item.groups.has(group.id)).slice(0,3);
  return '<section class="card lib-feature"><button class="lib-banner lib-tone-' + group.id +
    '" type="button" data-lib-collection="' + group.id + '" aria-label="浏览' + group.label + '"><strong>' + group.label +
    '</strong></button><div class="lib-picks">' + (picks.map(item => '<a href="#' + h(item.route) + '">' +
      '<span>' + h(item.name) + '</span><i aria-hidden="true">›</i></a>').join('') || '<span class="lib-none">暂无已启用条目</span>') + '</div></section>';
}

function catalogCard(entry) {
  const group = entry.kind === 'team' ? collections[3] : collections.find(item => entry.groups.has(item.id));
  const chips = [entry.builtin ? '内置' : '工作区自建', ...entry.tags.slice(0,2)];
  const avatar = '<span class="lib-avatar ' + (entry.builtin && entry.kind !== 'skill' && group ? 'lib-portrait ' : '') + 'lib-tone-' + (group?.id ?? 'plain') + '">' +
    icon(entry.kind === 'team' ? 'members' : group?.icon ?? 'capabilities') + '</span>';
  return '<a class="card lib-record" href="#' + h(entry.route) + '"><div class="lib-record-head">' + avatar +
    '<div><h3>' + h(entry.name) + '</h3><p>' + h(entry.description || entry.instructions) + '</p></div></div>' +
    '<div class="lib-tags">' + chips.map(tag => '<span>' + h(tag) + '</span>').join('') + '</div><div class="lib-meta">' +
    '<span>' + icon('connections') + h(entry.detail) + '</span><small>' + (entry.enabled ? '已启用' : '已停用') + '</small></div></a>';
}

function actions(ctx, skills) {
  const label = skills ? '技能' : '专家';
  const links = [link('library','工具库')];
  if (skills) links.unshift(link('copy-review','平台文案校验'));
  if (ctx.manager) {
    if (skills) links.unshift(link('skills/new','新增技能'));
    else links.unshift(link('library/experts/new/expert','新建专家'), link('library/experts/new/team','组建专家团'));
  }
  return '<button class="smallbtn lib-manage" type="button" popovertarget="library-menu">' + icon('data') +
    (ctx.manager ? '管理' + label : '更多操作') + '</button><div id="library-menu" class="studio-popover lib-menu" popover>' +
    links.join('') + '</div>';
}

export async function libraryDirectory(ctx, tab, initialQuery = '') {
  const records = directoryRecords(await ctx.all('/v1/library'));
  if (!ctx.active()) return;
  const skills = tab === 'skills', label = skills ? '技能' : '专家';
  const featured = records.filter(entry => skills ? entry.kind === 'skill' : entry.kind !== 'skill');
  const scope = ctx.account.id + '/' + ctx.workspace.id + '/' + tab;
  const saved = history.state?.libraryDirectory;
  const state = saved?.scope === scope ? {...saved} :
    { scope, kind:skills ? 'skill' : 'expert', group:'all', sort:'default', query:initialQuery };
  const kinds = skills ? [['skill','技能'],['custom','自建技能']] : [['expert','专家'],['team','专家团']];
  const filters = [['all','全部'], ...collections.map(g => [g.id,g.label]), ...(skills ? [] : [['custom','工作区自建']])];
  ctx.html('<section class="lib-directory" aria-label="专家库与技能库"><h1 class="lib-sr">能力中心</h1>' +
    '<div class="lib-top">' + libraryTabs(tab) + '<div class="lib-tools"><label class="lib-search">' + icon('search') +
    '<input type="search" maxlength="100" aria-label="搜索' + label + '" placeholder="搜索' + label + '" value="' +
    h(state.query) + '"></label>' + actions(ctx,skills) + '</div></div>' +
    '<div class="lib-features">' + collections.map(group => featureCard(group,featured)).join('') + '</div>' +
    '<div class="lib-catalog-top"><div class="lib-kinds" role="group" aria-label="条目类型">' +
    kinds.map(([id,title]) => choice('kind',id,title)).join('') + '</div><div class="lib-sorts" role="group" aria-label="排序">' +
    sorts.map(([id,title]) => choice('sort',id,title)).join('') + '</div></div>' +
    '<div class="lib-filters" role="group" aria-label="分类筛选">' + filters.map(([id,title]) => choice('group',id,title)).join('') +
    '</div><div class="lib-records"></div><div class="lib-empty" hidden><p role="status">没有符合条件的条目。</p>' +
    '<button type="button" class="smallbtn" data-lib-reset>重置筛选</button></div></section>');
  const root = document.querySelector('.lib-directory');
  const grid = root.querySelector('.lib-records');
  const search = root.querySelector('input[type=search]');
  const menu = root.querySelector('#library-menu');
  bindPopover(root.querySelector('[popovertarget]'),menu,{end:true,signal:ctx.signal});
  function update() {
    const matches = matchingRecords(records,state);
    grid.innerHTML = matches.map(catalogCard).join('');
    root.querySelector('.lib-empty').hidden = matches.length > 0;
    for (const key of ['kind','sort','group']) {
      for (const b of root.querySelectorAll('[data-lib-' + key + ']')) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-lib-' + key) === state[key]));
      }
    }
    history.replaceState({...history.state, libraryDirectory:state},'');
  }
  for (const key of ['kind','sort','group']) ctx.click('lib-' + key, value => { state[key] = value; update(); });
  ctx.click('lib-collection',value => {
    state.group = value;
    state.query = search.value = '';
    update();
    root.querySelector('[data-lib-group="' + value + '"]').focus();
  });
  ctx.click('lib-reset',() => {
    state.query = search.value = '';
    state.group = 'all';
    state.kind = skills ? 'skill' : 'expert';
    state.sort = 'default';
    update();
    search.focus();
  });
  search.addEventListener('input',() => { state.query = search.value; update(); });
  update();
}
