const deskSlides=[
 {id:'bundle',title:'商品上新工作台',text:'将商品事实、SKU 和视觉需求整理成一套可编辑、可导出的商品资料。',action:'创建商品资料包',pic:'leather',alt:'奶油色手提包的商品摄影'},
 {id:'materialcut',title:'短片制作工作台',text:'给素材排好镜头顺序，编辑每一段的时长与旁白，保存可交接的剪辑方案。',action:'编排商品短片',pic:'audio',alt:'影棚中的头戴耳机'},
 {id:'roi',title:'店铺经营工作台',text:'从单笔订单的售价与成本入手，测算广告保本线，再制定投放计划。',action:'开始收益测算',pic:'citrus',alt:'鲜橙气泡饮的产品摄影'}
];
function heroPanel(){
 const slide=deskSlides[deskState.hero];const usable=deskAvailable(deskIndex.get(slide.id));
 return '<section class="deskHero"><div class="deskLead"><div class="slideTabs" aria-label="切换工作场景">'+['商品上新','视频制作','店铺经营'].map((s,i)=>'<button data-slide="'+i+'" aria-pressed="'+(deskState.hero===i)+'">'+s+'</button>').join('')+'</div><h1>'+slide.title+'</h1><p>'+slide.text+'</p><div class="buttons"><button class="primary" data-desk="'+slide.id+'" '+(usable?'':'disabled')+'>'+slide.action+'　→</button><button class="plain" data-nav="create">自由创作</button></div></div><div class="deskArt"><img src="'+srcFor(slide.pic)+'" alt="'+slide.alt+'"></div>'+DeskFloat.markup(deskState.hero)+'</section>';
}
function deskTiles(group){
 return [...deskIndex.values()].filter(item=>item.group===group&&deskAvailable(item)).map(item=>'<article class="deskTile"><div>'+glyph(item.icon)+favorAction(item.id)+'</div><button class="tileLink" data-desk="'+item.id+'"><strong>'+safe(item.name)+'</strong><small>'+safe(item.desc)+'</small></button></article>').join('')||'<p class="notice">此组插件已停用，可在插件管理中恢复。</p>';
}
function desktop(){
 return heroPanel()+'<section class="homeSection"><div class="labelRow"><h2>生产工具</h2><button data-nav="library">全部插件工具 '+glyph('arrow')+'</button></div><div class="deskCategories">'+deskGroups.map(([id,n])=>'<button data-desk-group="'+id+'" aria-pressed="'+(id===deskState.group)+'">'+n+'</button>').join('')+'</div><div class="deskTiles">'+deskTiles(deskState.group)+'</div></section><section class="homeSection"><div class="labelRow"><h2>商品与交付</h2>'+deskButton('history','查看制作记录 →','smallbtn')+'</div><div class="miniStats">'+[['products','商品档案',deskState.inventory.length],['saved','收藏项目',deskState.favorites.size+deskState.savedScenes.size],['exports','已导出商品包',deskState.transfers.filter(x=>x.type==='exports').length]].map(([id,k,v])=>'<button data-desk="'+id+'"><span>'+k+'</span><b>'+v+'</b> ↗</button>').join('')+'</div></section>';
}
function historyPage(item){
 const jobs=deskState.jobs.map(x=>'<div class="stockrow"><div><strong>'+safe(x.title)+'</strong><small>'+safe(deskIndex.get(x.tool).name)+' · '+safe(x.when)+'</small></div><button class="smallbtn" data-job="'+x.id+'">查看制作单</button></div>').join('');
 return recipeHeader(item)+draftPanel('已保存的制作单',jobs||'<p class="muted">保存资料、镜头编排或运营提纲后会显示在这里。</p>')+'<section class="card spaceTop"><div class="panelhead"><strong>插件演练任务</strong></div>'+taskRows(state.records)+'</section>';
}
function renderDeskPage(p){
 if(p==='desk')return desktop();const item=entryByPage(p);
 switch(item.kind){
 case 'package':return packagePage(item);
 case 'brief':return briefPage(item);
 case 'sequence':return sequencePage(item);
 case 'calc':return calcPage(item);
 case 'board':return showBoard(item);
 case 'stock':return stockPage(item);
 case 'history':return historyPage(item);
 case 'favorites':{const tools=[...deskState.favorites].map(k=>deskIndex.get(k));const cases=[...deskState.savedScenes].map(k=>sceneCard(k)).join('');
 return recipeHeader(item)+draftPanel('收藏的工具',tools.length?tools.map(x=>'<div class="stockrow"><div><strong>'+safe(x.name)+'</strong><small>'+safe(x.groupName)+'</small></div><div class="buttons">'+favorAction(x.id)+deskButton(x.id,'打开')+'</div></div>').join(''):'<p class="muted">点击工具卡上的星标即可收藏。</p>')+'<div class="spaceTop">'+draftPanel('收藏的案例',cases?'<div class="gallery">'+cases+'</div>':'<p class="muted">在案例选片页收藏需要再次使用的案例。</p>')+'</div>';}
 case 'gallery':return recipeHeader(item)+'<div class="gallery">'+Object.keys(scenes).map(k=>sceneCard(k)).join('')+'</div>';
 }}
function sceneCard(key){
 const s=scenes[key],saved=deskState.savedScenes.has(key);return '<article class="sceneFrame"><button class="example" data-scene="'+key+'"><div class="casePhoto"><img src="'+srcFor(key)+'" alt="'+safe(s.product)+'"></div><div class="caseLine"><strong>'+safe(s.title)+'</strong></div></button><button class="sceneSave" data-save-scene="'+key+'" aria-label="收藏案例 '+safe(s.title)+'" aria-pressed="'+saved+'">'+(saved?'★':'☆')+'</button></article>';
}
function sideGroups(){
 return '<div class="sideGroups">'+deskGroups.map(([id,n,icon,items])=>'<button class="sideGroup" data-expand="'+id+'" aria-expanded="'+(deskState.expanded===id)+'" title="'+n+'">'+glyph(icon)+'<span>'+n+'</span><i>⌄</i></button>'+(deskState.expanded===id?'<div class="sideChildren">'+items.filter(([key])=>deskAvailable(deskIndex.get(key))).map(([key,name])=>'<button data-desk="'+key+'" '+(state.page===deskPage(key)?'aria-current="page"':'')+'>'+name+'</button>').join('')+'</div>':'')).join('')+'</div>';
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;const a=b.dataset;
 if(a.desk){if(a.desk==='bundle'&&deskState.edit){deskState.edit=null;deskState.drafts.delete('bundle')}deskOpen(a.desk);return}
 if(a.expand){deskState.expanded=deskState.expanded===a.expand?null:a.expand;deskState.group=a.expand;if(document.body.classList.contains('compactRail')||window.innerWidth<=1000){go('desk')}else{nav()}return}
 if(a.deskGroup){deskState.group=a.deskGroup;render();return}
 if(a.slide!==undefined){deskState.hero=Number(a.slide);render();return}
 if(a.saveScene){if(deskState.savedScenes.has(a.saveScene))deskState.savedScenes.delete(a.saveScene);else deskState.savedScenes.add(a.saveScene);render();return}
 if(a.favorite){if(deskState.favorites.has(a.favorite))deskState.favorites.delete(a.favorite);else deskState.favorites.add(a.favorite);render();return}
 if(a.job){const j=deskState.jobs.find(v=>v.id===Number(a.job));modal('<h2>'+safe(j.title)+'</h2><pre class="jobData">'+safe(JSON.stringify(j.data,null,2))+'</pre><button class="plain" data-job-download="'+j.id+'">下载制作单</button>');return}
 if(a.jobDownload){const j=deskState.jobs.find(v=>v.id===Number(a.jobDownload));fileDownload('制作单-'+j.id+'.json',j.data);return}
 if(a.railToggle!==undefined){const collapsed=document.body.classList.toggle('compactRail');b.setAttribute('aria-expanded',String(!collapsed));b.textContent=collapsed?'展开导航':'收起导航';return}
});

