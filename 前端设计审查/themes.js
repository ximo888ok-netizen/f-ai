/* Loaded before styles so the saved appearance is used on the first paint. */
(() => {
  const themes=[
    {id:'studio',name:'雾白工作台',detail:'雾白 · 松绿强调色'},
    {id:'glass',name:'冰蓝玻璃',detail:'透光 · 极光折射'},
    {id:'paper',name:'暖白纸笺',detail:'暖白 · 朱砂细线'},
    {id:'jade',name:'雨后青玉',detail:'松绿 · 柔雾釉面'},
    {id:'noir',name:'曜石鎏金',detail:'炭黑 · 香槟金属'}
  ];
  const storageKey='fai.studio.theme.v1';
  const valid=id=>themes.some(t=>t.id===id);
  const params=new URLSearchParams(location.search);
  let current=params.get('theme');
  if(!valid(current)){
    try{current=localStorage.getItem(storageKey);}catch{current=null;}
  }
  if(!valid(current))current='studio';
  const root=document.documentElement;
  root.dataset.theme=current;
  function setTheme(id,save=false){
    if(!valid(id))return;
    current=id;root.dataset.theme=id;
    if(save){
      try{localStorage.setItem(storageKey,id);}catch{}
      const url=new URL(location.href);
      url.searchParams.set('theme',id);
      try{history.replaceState(history.state,'',url);}catch{}
    }
    const choice=themes.find(t=>t.id===id);
    document.querySelectorAll('[data-theme-open]').forEach(button=>{
      button.title='切换主题 · '+choice.name;
      button.setAttribute('aria-label',button.title);
      button.querySelector('span').textContent=choice.name;
    });
    document.querySelectorAll('input[name="faiAppearance"]').forEach(r=>r.checked=r.value===id);
    document.querySelectorAll('a[href*=".html"]').forEach(link=>{
      const target=new URL(link.href);
      if(!['打开设计稿.html','前端详细设计.html'].includes(decodeURIComponent(target.pathname.split('/').pop())))return;
      target.searchParams.set('theme',id);link.href=target.href;
    });
    if(typeof StudioGlass!=='undefined')StudioGlass.schedule();
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const dialog=document.createElement('dialog');
    dialog.id='themeDialog';dialog.className='ui-dialog';dialog.setAttribute('aria-labelledby','themeTitle');
    dialog.innerHTML='<header class="ui-dialog-header"><h2 id="themeTitle">外观主题</h2><button class="ui-icon-button themeClose" type="button" aria-label="关闭主题选择"><span aria-hidden="true">×</span></button></header><div class="ui-dialog-body">'+
      '<fieldset class="themeGrid"><legend class="themeSr">选择工作区主题</legend>'+themes.map(t=>
      '<label class="themeChoice"><input type="radio" name="faiAppearance" value="'+t.id+'"><span class="themeDemo demo-'+t.id+'" aria-hidden="true"><i></i><b></b><em></em></span><span class="themeMeta"><strong>'+t.name+'</strong><small>'+t.detail+'</small></span><span class="themeCheck" aria-hidden="true">✓</span></label>').join('')+
      '</fieldset></div><form class="ui-dialog-footer" method="dialog"><button class="primary">完成</button></form>';
    document.body.append(dialog);
    dialog.querySelector('.themeClose').onclick=()=>dialog.close();
    window.applyStudioTheme = id => setTheme(id);
    dialog.addEventListener('change',e=>{
      if(e.target.name!=='faiAppearance')return;
      setTheme(e.target.value,true);
      document.dispatchEvent(new CustomEvent('studio-theme', { detail: e.target.value }));
    });
    document.querySelectorAll('[data-theme-open]').forEach(b=>b.onclick=()=>{
      dialog.showModal();dialog.querySelector('input:checked')?.focus({preventScroll:true});
    });
    window.addEventListener('storage',e=>{if(e.key===storageKey && valid(e.newValue))setTheme(e.newValue);});
    setTheme(current);
    // Local file links may have separate storage areas in the same browser.
    document.addEventListener('click',e=>{
      const link=e.target.closest('a[href*=".html"]');
      if(!link)return;
      const url=new URL(link.href), name=decodeURIComponent(url.pathname.split('/').pop());
      if(name==='打开设计稿.html'||name==='前端详细设计.html'){url.searchParams.set('theme',current);link.href=url.href;}
    },true);
  });
})();
