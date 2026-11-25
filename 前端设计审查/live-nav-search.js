import { studioIcon } from './studio-icons.js';
import { h } from './live-ui.js';
export const findNavigation='<button type="button" class="smallbtn" data-find-navigation aria-haspopup="dialog">' + studioIcon('search') + '<span>查找功能</span><kbd aria-hidden="true">Ctrl K</kbd></button>';

export function bindNavigationSearch(nav, otherPages = []) {
  let dialog;
  const usable=()=>nav.querySelector('a[href^="#"]')&&!nav.closest('[hidden]');
  function open() {
    if(!usable()||document.querySelector('dialog[open]'))return;
    if(!dialog){
      dialog = document.createElement('dialog');
      dialog.id = 'navigationSearch';
      dialog.className = 'ui-dialog';
      dialog.setAttribute('aria-labelledby', 'nav-search-title');
      dialog.innerHTML='<header class="ui-dialog-header"><h2 id="nav-search-title">查找功能</h2><form method="dialog"><button class="ui-icon-button" aria-label="关闭">×</button></form></header>'+
        '<div class="ui-dialog-body"><label>功能名称<input type="search" maxlength="80" placeholder="例如：素材库"></label><nav class="live-row" aria-label="匹配的功能"></nav><p class="live-muted" role="status"></p></div>';
      document.body.append(dialog);
      const search = dialog.querySelector('input');
      search.addEventListener('input',filter);
      dialog.addEventListener('keydown', event => {
        if (event.isComposing) return;
        const active = event.target;
        const first = dialog.querySelector('nav a');
        if (active === search && event.key === 'Enter' && first) {
          event.preventDefault();
          first.click();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          let next;
          if (active === search && event.key === 'ArrowDown') next = first;
          if (active.matches('nav a')) next = event.key === 'ArrowDown'
            ? active.nextElementSibling : active.previousElementSibling ?? search;
          if (next) {
            event.preventDefault();
            next.focus();
          }
        }
      });
      dialog.addEventListener('click',e=>{if(e.target.closest('nav a'))dialog.close();});
    }
    dialog.querySelector('input').value='';filter();dialog.showModal();dialog.querySelector('input').focus();
  }
  function filter(){
    const q=dialog.querySelector('input').value.trim().toLowerCase();
    const visibleLinks = [...nav.querySelectorAll('a[href^="#"]')].map(a => [a.getAttribute('href'), a.textContent]);
    const links = [...new Map([...otherPages, ...visibleLinks])].filter(([, label]) => label.toLowerCase().includes(q));
    dialog.querySelector('nav').innerHTML = links.map(([href, label]) =>
      '<a class="smallbtn" href="' + h(href) + '">' + h(label) + '</a>').join('');
    dialog.querySelector('[role=status]').textContent=links.length?'共 '+links.length+' 项':'没有匹配功能。';
  }
  document.addEventListener('click',e=>{if(e.target.closest('[data-find-navigation]'))open();});
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='k'&&usable()&&!e.isComposing){
      if(!document.querySelector('dialog[open]')||dialog?.open){e.preventDefault();open();}
    }
  });
}
