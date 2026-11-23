import { bindNavigationSearch, findNavigation } from './live-nav-search.js';
import { h } from './live-ui.js';

const shortcuts = ['home', 'desk', 'capabilities', 'data', 'tasks'];
const sections = [
  ['创作工具', ['create', 'media', 'psd', 'models', 'copy-review', 'library', 'skills']],
  ['商品与经营', ['products', 'drafts', 'commerce', 'shops', 'roi', 'customer', 'feishu']],
  ['项目与资料', ['projects', 'resources', 'assets', 'cloud-assets', 'rights']],
  ['工作区设置', ['schedules', 'team', 'manager', 'inbox', 'account', 'settings']],
];

export function workspaceNavigation(pages) {
  const nav = document.querySelector('#nav');
  bindNavigationSearch(nav);
  const toggle = document.querySelector('#studioMenu');
  const rail = nav.closest('.rail');
  function setOpen(open) {
    rail.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', event => {
    if (event.target.closest('a') && rail.classList.contains('menu-open')) {
      setOpen(false);
      document.querySelector('#main').focus({ preventScroll: true });
    }
  });
  rail.addEventListener('keydown', event => {
    if (event.key === 'Escape' && rail.classList.contains('menu-open')) {
      setOpen(false);
      toggle.focus();
    }
  });
  return (route, authenticated) => {
    toggle.hidden = !authenticated;
    if (!authenticated) {
      setOpen(false);
      nav.replaceChildren();
      delete nav.dataset.route;
      return;
    }
    if (nav.dataset.route === route) return;
    const entry = id => '<a class="navitem' + (route === id ? ' active' : '') + '" href="#' + id + '"' +
      (route === id ? ' aria-current="page"' : '') + '><span>' + h(pages[id][0]) + '</span></a>';
    nav.innerHTML = '<div class="live-shortcuts"><a class="smallbtn workspace-new" href="#home/new">' +
      '<span aria-hidden="true">＋</span> 新对话</a>' + shortcuts.map(entry).join('') + '</div>' + findNavigation +
      sections.map(([label, ids]) => '<details name="workspace-navigation" class="live-nav-section"' +
        (ids.includes(route) ? ' open' : '') + '><summary>' + h(label) + '</summary>' +
        ids.map(entry).join('') + '</details>').join('');
    nav.dataset.route = route;
    setOpen(false);
  };
}
