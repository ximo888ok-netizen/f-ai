import { date, h, path } from './live-ui.js';
import { studioIcon as icon } from './studio-icons.js';
import { bindPopover } from './live-popover.js';
import { createBaseForm, uploadDocumentForm, saveKnowledgeDocument } from './knowledge-forms.js';

const endpoint = '/v1/knowledge/bases';
const baseRoute = id => 'resources/' + path(id);
const anchor = (route, label) => '<a href="#' + h(route) + '">' + h(label) + '</a>';
const iconButton = (label, name, attrs) => '<button type="button" class="kb-icon" title="' + h(label) +
  '" aria-label="' + h(label) + '" ' + attrs + '>' + icon(name) + '</button>';

function menu(id, label, items) {
  return iconButton(label, 'more', 'popovertarget="' + id + '"') +
    '<div class="kb-menu" id="' + id + '" popover="auto">' + items.join('') + '</div>';
}

function spaceGroup(ctx, spaces, kind, bases, selected) {
  const personal = kind === 'personal';
  const links = spaces.map(space => {
    const active = space.id === ctx.workspace.id;
    const name = personal ? '我的个人知识库' : space.name;
    const row = icon(personal ? 'book' : 'members') + '<span>' + h(name) + '</span>';
    if (!active) return '<a class="kb-space" href="#resources/space/' + path(space.id) + '">' + row + '</a>';
    if (!bases.length) return '<div class="kb-space is-current" aria-current="true">' + row + '</div>';
    return '<details class="kb-branch"' + (bases.length > 1 ? ' open' : '') + '><summary class="kb-space is-current">' + row +
      '<i aria-hidden="true"></i></summary><div class="kb-tree">' + bases.map(b => '<a href="#' + baseRoute(b.id) + '"' +
        (b.id === selected?.id ? ' aria-current="page"' : '') + '>' + icon('book') + '<span>' + h(b.name) + '</span></a>').join('') + '</div></details>';
  }).join('');
  return '<section><h3>' + (personal ? '个人空间' : kind === 'agent' ? '代理空间' : '企业空间') + '</h3>' +
    (links || '<p class="kb-no-space">' + (personal ? '暂无个人空间' : '尚未加入企业') + '</p>') + '</section>';
}

function documentsView(base, docs, canCreate, gridView) {
  if (!docs.length) return '<div class="kb-empty">' + icon('document') + '<p>' +
    (base ? '暂无内容' : canCreate ? '尚未创建知识库' : '暂无已授权的知识库') + '</p></div>';
  return '<ul class="kb-docs" data-kb-docs data-view="' + (gridView ? 'grid' : 'list') + '">' +
    docs.map(doc => '<li><a href="#' + baseRoute(base.id) + '/' + path(doc.id) + '">' + icon('document') +
      '<span><strong>' + h(doc.name) + '</strong>' + (doc.category ? '<small>' + h(doc.category) + '</small>' : '') +
      '</span><time datetime="' + h(doc.createdAt) + '">' + h(date(doc.createdAt)) + '</time></a></li>').join('') + '</ul>';
}

export async function knowledgeCenter(ctx) {
  const [requested, spaceId] = ctx.args;
  if (requested === 'space' && spaceId !== ctx.workspace.id) {
    ctx.switchWorkspace(spaceId);
    return;
  }
  const bases = await ctx.all(endpoint);
  const base = requested && requested !== 'space' ? bases.find(item => item.id === requested) : bases[0];
  if (requested && requested !== 'space' && !base) throw new Error('当前工作区无法访问这个知识库。');
  const docsUrl = base && endpoint + '/' + path(base.id) + '/documents';
  const docs = docsUrl ? await ctx.all(docsUrl) : [];
  if (!ctx.active()) return;

  const personal = ctx.workspace.kind === 'personal';
  const title = base?.name ?? (personal ? '个人知识库' : ctx.enterprise ? '企业知识库' : ctx.workspace.name);
  const topMenu = [anchor('resources/manage/search', '检索知识库'), anchor('resources/web', '联网检索'),
    anchor('resources/memory/personal', '个人记忆')];
  if (ctx.enterprise) topMenu.push(anchor('resources/memory/enterprise', '企业记忆'));
  topMenu.push(anchor('resources/manage', '知识库管理'));
  if (ctx.manager) topMenu.unshift('<button type="button" data-kb-add="base">新建知识库</button>');
  const actions = [];
  if (ctx.manager) actions.push(iconButton(base ? '添加文档' : '新建知识库', 'plus', 'data-kb-add="' + (base ? 'doc' : 'base') + '"'));
  if (base) {
    const route = baseRoute(base.id);
    const links = [anchor(route + '/categories', '文档分类'), anchor('resources/manage/search/' + path(base.id), '检索文档')];
    if (ctx.manager) links.push(anchor(route + '/manage', ctx.enterprise ? '库设置与授权' : '库设置'));
    actions.push(menu('kb-library-menu', '知识库操作', links),
      '<a class="primary kb-to-task" href="#chat/new/knowledge/' + path(base.id) + '">' + icon('tasks') + '添加到任务</a>');
  }
  const sidebar = ['personal', 'enterprise', ...(ctx.workspaces.some(s => s.kind === 'agent') ? ['agent'] : [])]
    .map(kind => spaceGroup(ctx, ctx.workspaces.filter(s => s.kind === kind), kind, bases, base)).join('');
  let gridView = false;
  try { gridView = sessionStorage.getItem('fai.knowledge.view') === 'grid'; } catch {}
  const viewSwitch = '<div class="kb-views" role="group" aria-label="文档视图">' +
    iconButton('列表视图', 'lines', 'data-kb-view="list" aria-pressed="' + !gridView + '"') +
    iconButton('网格视图', 'features', 'data-kb-view="grid" aria-pressed="' + gridView + '"') + '</div>';
  ctx.html('<section class="card kb-center" aria-label="知识库中心"><header class="kb-top"><h1>知识库中心</h1>' +
    menu('kb-global-menu', '知识库中心操作', topMenu) + '</header><div class="kb-layout"><nav class="kb-rail" aria-label="知识库空间">' +
    sidebar + '</nav><section class="kb-content"><header class="kb-summary"><div class="kb-mark">' + icon('book') +
    '</div><div class="kb-title"><h2>' + h(title) + '</h2><p>' +
    (ctx.enterprise ? h(ctx.workspace.name) + ' · 仅已授权的成员可见' : personal ? '个人空间 · 仅你自己可见' : h(ctx.workspace.name)) +
    '</p></div><div class="kb-actions">' + actions.join('') + '</div></header>' +
    '<div class="kb-collection"><h3>所有知识</h3>' + viewSwitch + '</div>' + documentsView(base, docs, ctx.manager, gridView) +
    '</section></div><dialog class="kb-dialog" aria-labelledby="kb-dialog-title"></dialog></section>');
  const root = document.querySelector('.kb-center');
  for (const trigger of root.querySelectorAll('[popovertarget]')) {
    bindPopover(trigger, root.querySelector('#' + trigger.getAttribute('popovertarget')), { end: true, signal: ctx.signal });
  }
  ctx.click('kb-view', (view) => {
    const records = root.querySelector('[data-kb-docs]');
    if (records) records.dataset.view = view;
    for (const control of root.querySelectorAll('[data-kb-view]')) control.setAttribute('aria-pressed', String(control.dataset.kbView === view));
    try { sessionStorage.setItem('fai.knowledge.view', view); } catch {}
  });
  ctx.click('kb-add', async kind => {
    for (const popover of root.querySelectorAll(':popover-open')) popover.hidePopover();
    const upload = kind === 'doc';
    const products = upload ? await ctx.all('/v1/studio/products') : [];
    if (!ctx.active()) return;
    const dialog = root.querySelector('dialog');
    dialog.innerHTML = '<header><h2 id="kb-dialog-title">' + (upload ? '添加文档' : '新建知识库') +
      '</h2><button type="button" class="smallbtn" data-kb-close>关闭</button></header><p class="kb-dialog-scope">' +
      h(upload ? title : ctx.workspace.name) + '</p>' + (upload ? uploadDocumentForm(products) : createBaseForm());
    dialog.querySelector('[data-kb-close]').onclick = () => dialog.close();
    ctx.submit(upload ? 'add-doc' : 'new-base', async data => {
      if (upload) { await saveKnowledgeDocument(ctx, docsUrl, data); ctx.reload(); }
      else {
        const created = await ctx.api(endpoint, { method: 'POST', body: { name: data.get('name') } });
        ctx.go(baseRoute(created.id));
      }
    });
    dialog.showModal();
    dialog.querySelector('input[name=name]').focus();
  });
}
