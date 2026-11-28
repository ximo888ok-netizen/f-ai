import { bindNavigationSearch } from './live-nav-search.js';
import { recentTasks } from './live-agent-tools.js';
import { studioIcon } from './studio-icons.js';
import { h, path } from './live-ui.js';

const panels = { desk: 'workbench', chat: 'chat', library: 'plugins', data: 'knowledge', resources: 'knowledge',
  capabilities: 'experts', skills: 'experts', customer: 'ai-service', commerce: 'ai-ops', 'copy-review': 'copywriting' };
const scenePanels = { image: 'image-studio', video: 'video-studio', operations: 'ai-ops', 'customer-service': 'ai-service', copywriting: 'copywriting' };

export function workspaceNavigation(pages) {
  const rail = document.querySelector('#appSidebar'), nav = document.querySelector('#nav');
  const menu = document.querySelector('#studioMenu'), veil = document.querySelector('#sidebarBackdrop');
  const switcher = document.querySelector('#stageSwitcher'), thumb = document.querySelector('#switcherThumb');
  const business = document.querySelector('.business-root'), mobile = matchMedia('(max-width:900px)');
  bindNavigationSearch(nav, Object.entries(pages).filter(([route]) => route !== 'admin').map(([route,[label]]) => ['#' + route, label]));
  let collapsed = false;
  function layoutMenu(open = false) {
    rail.classList.toggle('mobile-open', mobile.matches && open);
    rail.classList.toggle('desktop-hidden', !mobile.matches && collapsed);
    veil.hidden = !(mobile.matches && open);
    veil.classList.toggle('open', !veil.hidden);
    menu.setAttribute('aria-expanded', String(mobile.matches ? open : !collapsed));
  }
  menu.onclick = () => {
    if (!mobile.matches) collapsed = !collapsed;
    layoutMenu(!rail.classList.contains('mobile-open'));
  };
  veil.onclick = () => { layoutMenu(); menu.focus(); };
  nav.addEventListener('click', event => { if (event.target.closest('a')) layoutMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !veil.hidden && !document.querySelector('dialog[open]')) { layoutMenu(); menu.focus(); }
  });
  mobile.addEventListener('change', () => layoutMenu());
  function positionThumb() {
    const current = switcher.querySelector('[aria-current="page"]');
    thumb.hidden = !current;
    if (current) {
      thumb.style.width = current.offsetWidth + 'px';
      thumb.style.left = current.offsetLeft + 'px';
      thumb.style.transform = 'none';
    }
  }
  new ResizeObserver(positionThumb).observe(switcher);

  return (route, ctx) => {
    rail.hidden = menu.hidden = switcher.hidden = !ctx.account;
    layoutMenu();
    for (const section of document.querySelectorAll('.main-stage > .view-panel')) section.classList.remove('active');
    const id = ctx.account && (ctx.section ? scenePanels[ctx.section] : panels[route]);
    const stage = document.getElementById('view-' + (id || 'workbench'));
    stage.classList.add('active');
    stage.append(business);
    stage.scrollTop = 0;
    const selected = route === 'chat' ? 'chat' : ctx.section === 'image' ? 'image' : route === 'home' || ctx.section ? 'desk' : '';
    for (const item of switcher.querySelectorAll('[data-stage]')) {
      if (item.dataset.stage === 'desk') item.href = '#home';
      item.classList.toggle('active', item.dataset.stage === selected);
      if (item.dataset.stage === selected) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    positionThumb();
    if (!ctx.account) return;
    const imageTool = route === 'create' && ctx.args[0] === 'image';
    document.querySelector('#sidebarImageMode').classList.toggle('active', imageTool);
    document.querySelector('#sidebarMainMode').classList.toggle('active', !imageTool);
    const navState = route === 'library' && ctx.args[0] === 'experts' ? 'experts' : selected || ({ library:'plugins', data:'knowledge', resources:'knowledge', capabilities:'experts', skills:'experts' })[route];
    for (const item of nav.querySelectorAll('[data-nav]')) {
      if (item.dataset.nav === 'workbench') item.href = '#home';
      const current = (item.dataset.nav === 'workbench' ? 'desk' : item.dataset.nav) === navState;
      item.classList.toggle('active', current);
      if (current) item.setAttribute('aria-current','page'); else item.removeAttribute('aria-current');
    }
    if (imageTool) {
      const items = document.querySelector('#imageToolsNav');
      items.replaceChildren();
      ctx.api('/v1/plugins').then(catalog => {
        if (!ctx.active()) return;
        const tools = catalog.items.find(p => p.id === 'image')?.capabilities ?? [];
        document.querySelector('#sidebarImageMode .tabular').textContent = tools.length + ' 项';
        items.innerHTML = tools.map(tool => '<a class="nav-item' + (tool.id === ctx.args[1] ? ' active' : '') +
          '" href="#' + (tool.id === 'image.main-image' ? 'desk/image' : 'create/image/' + path(tool.id)) + '">' +
          studioIcon('image') + h(tool.name) + '</a>').join('');
      }).catch(() => { if (ctx.active()) items.textContent = '工具读取失败'; });
    } else {
      const items = nav.querySelector('[data-rail-items]'), count = nav.querySelector('[data-recent-count]');
      items.replaceChildren(); count.textContent = '';
      recentTasks(ctx).then(data => {
        if (!ctx.active()) return;
        const tasks = data.items.slice(0,3);
        count.textContent = tasks.length;
        items.innerHTML = tasks.length ? tasks.map(t => '<a class="recent-item" href="#' + h(t.route) + '" title="' + h(t.detail) +
          '"><span class="recent-dot"></span>' + h(t.title) + '</a>').join('') : '<span class="recent-item">暂无任务</span>';
      }).catch(() => { if (ctx.active()) items.textContent = '任务读取失败'; });
    }
  };
}
