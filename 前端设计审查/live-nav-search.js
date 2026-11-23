import { h } from './live-ui.js';
export const findNavigation='<button type="button" class="smallbtn" data-find-navigation aria-haspopup="dialog">查找功能</button>';

export function bindNavigationSearch(nav) {
  let dialog;
  const usable=()=>nav.querySelector('a[href^="#"]')&&!nav.closest('[hidden]');
  function open() {
    if(!usable()||document.querySelector('dialog[open]'))return;
    if(!dialog){
      dialog=document.createElement('dialog');dialog.className='ui-dialog';dialog.setAttribute('aria-labelledby','nav-search-title');
      dialog.innerHTML='<header class="ui-dialog-header"><h2 id="nav-search-title">查找功能</h2><form method="dialog"><button class="ui-icon-button" aria-label="关闭">×</button></form></header>'+
        '<div class="ui-dialog-body"><label>功能名称<input type="search" maxlength="80" placeholder="例如：素材库"></label><nav class="live-row" aria-label="匹配的功能"></nav><p class="live-muted" role="status"></p></div>';
      document.body.append(dialog);
      dialog.querySelector('input').addEventListener('input',filter);
      dialog.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing&&e.target.matches('input')){
        const first=dialog.querySelector('nav a');if(first){e.preventDefault();first.click();}
      }});
      dialog.addEventListener('click',e=>{if(e.target.closest('nav a'))dialog.close();});
    }
    dialog.querySelector('input').value='';filter();dialog.showModal();dialog.querySelector('input').focus();
  }
  function filter(){
    const q=dialog.querySelector('input').value.trim().toLowerCase();
    const links=[...nav.querySelectorAll('a[href^="#"]')].filter(a=>a.textContent.toLowerCase().includes(q));
    dialog.querySelector('nav').innerHTML=links.map(a=>'<a class="smallbtn" href="'+h(a.getAttribute('href'))+'">'+h(a.textContent)+'</a>').join('');
    dialog.querySelector('[role=status]').textContent=links.length?'共 '+links.length+' 项':'没有匹配功能。';
  }
  document.addEventListener('click',e=>{if(e.target.closest('[data-find-navigation]'))open();});
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='k'&&usable()&&!e.isComposing){
      if(!document.querySelector('dialog[open]')||dialog?.open){e.preventDefault();open();}
    }
  });
}
