const scenes = {
 audio:{title:'耳机新品主视觉',product:'云感头戴耳机',category:'数码',file:'audio',tool:'商品主图',prompt:'为这款头戴耳机制作一张蓝色棚拍主图，突出橙色耳垫和柔软材质。'},
 leather:{title:'皮具质感特写',product:'弧形手柄托特包',category:'箱包',file:'leather',tool:'详情页长图',prompt:'制作一套皮具详情图，展示弧形手柄、皮纹和包体轮廓。'},
 portrait:{title:'春季西装上身图',product:'象牙白廓形西装',category:'服饰',file:'portrait',tool:'模特换装',prompt:'用柔和的紫色影棚光呈现西装上身效果，保留肩线与面料纹理。'},
 citrus:{title:'鲜橙饮品场景图',product:'鲜橙气泡饮',category:'食品',file:'citrus',tool:'场景与背景替换',prompt:'用鲜橙切片和珊瑚色背景布置饮品场景，保留罐身轮廓和冷凝水珠。'}
};
const quickTools=[
 ['商品主图','image','商品主图','photo'],['详情页长图','image','详情页长图','layout'],['模特换装','image','模特换装','shirt'],
 ['场景替换','image','场景与背景替换','sun'],['局部重绘','image','局部重绘','brush'],['商品短片','video','图片转视频','film']
];
const symbols={
 spark:'<path d="m12 2 2.6 6.9L21 12l-6.4 2.6L12 22l-2.7-7.4L3 12l6.3-3.1L12 2Z"/>',
 folder:'<path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
 plugin:'<path d="m4 5 5 1a3 3 0 1 1 6 0l5-1v6a3 3 0 1 0 0 6v3H4v-6a3 3 0 1 0 0-6z"/>',
 ratio:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 10V8h3m9 6v2h-3"/>',
 store:'<path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10c1 2 3 2 4 0 1 2 4 2 5 0 1 2 4 2 5 0 1 2 3 2 4 0M8 20v-5h4v5"/>',
 palette:'<circle cx="12" cy="12" r="8"/><path d="M5 15c4 1 5-1 6-4 2-5 5-4 8-3"/>',
 add:'<path d="M12 4v16M4 12h16"/>',
 
 photo:'<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.5"/><path d="m5 17 5-5 3 3 3-4 3 4"/>',
 layout:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
 shirt:'<path d="m8 4-5 3-2 4 4 2 2-2v9h10v-9l2 2 4-2-2-4-5-3c-1 3-7 3-8 0Z"/>',
 sun:'<circle cx="8" cy="8" r="3"/><path d="m2 21 8-9 4 4 3-4 5 7M15 4h5m-2-2v5"/>',
 brush:'<path d="m8 14 10-11c2-1 4 1 3 3l-10 11Z"/><path d="M8 14c-4 0-3 5-6 6 4 2 9 0 9-4"/>',
 film:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m10 8 5 4-5 4z"/>',
 up:'<path d="M12 16V3m-5 5 5-5 5 5M3 15v5h18v-5"/>',
 arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>', grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>'
};
const glyph=k=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+symbols[k]+'</svg>';
const materials=[];
const launch={medium:'image',platform:'淘宝',ratio:'1:1',note:'',asset:null,sample:'audio',style:'',filter:'全部',tool:0,library:'全部',search:''};
const srcFor = scene=>'assets/'+scenes[scene].file+'.webp';
function uploadPicker(text){
 return '<label class="uploadButton">'+glyph('up')+'<span>'+safe(text)+'</span><input type="file" data-upload accept="image/jpeg,image/png,image/webp" aria-label="选择商品图片"></label>';
}
const formats={
 image:[['商品主图','商品主图'],['详情长图','详情页长图'],['模特穿搭','模特换装'],['场景图','场景与背景替换']],
 video:[['商品运镜','图片转视频'],['智能成片','智能成片'],['连续镜头','多图一镜到底'],['分镜脚本','可编辑脚本分镜与提示词']]
};
const activeFormat={image:0,video:0};
function composer(){
 const m=launch.medium,blocked=state.disabled.has(m);
 const tabs=['image','video'].map((id,i)=>'<button data-medium="'+id+'" aria-pressed="'+(id===m)+'" '+(state.disabled.has(id)?'disabled':'')+'>'+glyph(i?'film':'photo')+['商品图文','商品视频'][i]+'</button>').join('');
 const chips=formats[m].map(([n],i)=>'<button data-format="'+i+'" aria-pressed="'+(i===activeFormat[m])+'">'+n+'</button>').join('');
 const platforms=['淘宝','拼多多','抖店'].map(x=>'<option '+(x===launch.platform?'selected':'')+'>'+x+'</option>').join('');
 const ratios=['1:1','3:4','9:16','16:9'].filter(x=>(m==='image'?x!=='16:9':x!=='3:4')).map(x=>'<option '+(x===launch.ratio?'selected':'')+'>'+x+'</option>').join('');
 const sampleName=m==='image'?'商品图':'参考图';
 const preview=launch.asset?'<img src="'+safe(launch.asset.url)+'" alt="">':glyph('add');
 const material='<div class="materialTile"><label>'+preview+'<span>'+safe(launch.asset?'更换图片':sampleName)+'</span><input type="file" data-upload accept="image/jpeg,image/png,image/webp" aria-label="选择商品图片"></label>'+(launch.asset?'<button data-clear aria-label="移除所选图片">×</button>':'')+'</div>';
 const platform='<label class="parameter">'+glyph('store')+'<select id="platform" aria-label="目标平台">'+platforms+'</select></label>';
 const ratio='<label class="parameter">'+glyph('ratio')+'<select id="ratio" aria-label="画面比例">'+ratios+'</select></label>';
 return '<section class="hero"><div class="hero-heading"><h1>商品视觉<span>工作室</span></h1><p>上传商品素材，制作主图、详情页与上新短片。</p></div>'+
 '<div class="composerShell"><div class="composeHeader"><div class="medium" role="group" aria-label="创作类型">'+tabs+'</div><button class="sampleAction" data-seed>'+glyph('spark')+'试用示例</button></div>'+
 '<div class="compose" data-drop><div class="formats" role="group" aria-label="成品类型">'+chips+'</div><div class="briefRow">'+material+'<textarea id="brief" aria-label="创作需求" placeholder="'+(m==='image'?'描述商品、卖点与场景。比如：保留包身皮纹，使用暖白色背景和柔和侧光。':'描述商品、开场画面与镜头运动。比如：从耳罩特写缓慢拉远，最后定格在产品正面。')+'">'+safe(launch.note)+'</textarea></div>'+
 '<div class="composeFoot"><div class="paramGroup">'+platform+ratio+'<button class="parameter" data-styles>'+glyph('palette')+safe(launch.style||'参考风格')+'</button></div><button class="start" data-launch '+(blocked?'disabled':'')+'>'+glyph('spark')+'进入创作<span>0 积分</span></button></div></div></div></section>';

}
function galleryCards(){
 return Object.entries(scenes).filter(([k,s])=>launch.filter==='全部'||s.category===launch.filter).map(([key,s])=>'<button class="example" data-scene="'+key+'" '+(state.disabled.has('image')?'disabled':'')+'><div class="casePhoto"><img src="'+srcFor(key)+'" alt="'+s.product+'的商业摄影示例"><span class="use">使用案例 ↗</span></div><div class="caseLine"><div><strong>'+s.title+'</strong><small>'+s.category+'　/　'+s.tool+'</small></div><span>↗</span></div></button>').join('');
}
function creativeHome(){
 if(state.disabled.has(quickTools[launch.tool]?.[1])){const idx=quickTools.findIndex(q=>!state.disabled.has(q[1]));launch.tool=idx<0?0:idx}
 if(state.disabled.has(launch.medium)&&!state.disabled.has(launch.medium==='image'?'video':'image'))launch.medium=launch.medium==='image'?'video':'image';
 return composer()+'<section class="homeSection"><div class="labelRow"><h2>常用创作工具</h2><button data-nav="library">全部工具 '+glyph('arrow')+'</button></div><div class="quickGrid">'+quickTools.map(([name,p,a,icon],i)=>state.disabled.has(p)?'':'<button data-quick="'+i+'"><span class="tileIcon tone'+i+'">'+glyph(icon)+'</span><b>'+name+'</b><span class="chev">›</span></button>').join('')+'</div></section><section class="homeSection"><div class="labelRow galleryLabel"><h2>案例灵感</h2><div class="filters">'+['全部','数码','箱包','服饰','食品'].map(s=>'<button data-filter="'+s+'" aria-pressed="'+(s===launch.filter)+'">'+s+'</button>').join('')+'</div></div><div class="gallery">'+galleryCards()+'</div></section>';
}
function matchingTools(){
 return Object.entries(plugins).filter(([id])=>!state.disabled.has(id)&&(launch.library==='全部'||id===launch.library)).map(([id,p])=>{
 const entries=p.actions.split(' ').filter(a=>(p.name+a).toLowerCase().includes(launch.search.toLowerCase().trim()));
 if(!entries.length)return '';return '<section class="toolGroup"><h2>'+p.name+'</h2><div class="toolList">'+entries.map(a=>'<button data-kit="'+id+'" data-cap="'+safe(a)+'">'+safe(a)+'<span>↗</span></button>').join('')+'</div></section>'}).join('')||emptyState('暂无匹配工具','可更换关键词或到插件管理启用对应插件。');
}
function toolbox(){
 return title('全部创作工具','选择具体任务，直接打开对应插件。')+'<div class="libbar"><div class="filters">'+[['全部','全部'],...Object.entries(plugins).filter(([id])=>!state.disabled.has(id)).map(([id,p])=>[id,p.label])].map(([id,n])=>'<button data-lib="'+id+'" aria-pressed="'+(launch.library===id)+'">'+n+'</button>').join('')+'</div><input id="searchTools" type="search" placeholder="搜索工具" aria-label="搜索工具" value="'+safe(launch.search)+'"></div><div id="toolsFound">'+matchingTools()+'</div>';
}
function openTask(id,cap,scene,fromComposer=false){
 if(state.disabled.has(id)){toast('请先启用对应插件');return}
 const d=draft(id);Object.assign(d,{action:cap,step:0,mode:'flow',confirmed:false});
 if(scene||fromComposer){const key=scene||launch.sample;const s=scenes[key];
 const file=fromComposer?launch.asset:null;d.scene=key;d.asset=file;d.source=file?file.name:s.product;
 d.platform=fromComposer?launch.platform:'淘宝';d.option=plugins[id].choices.find(v=>v.startsWith(fromComposer?launch.ratio:'1:1'))||plugins[id].choices[0];d.prompt=fromComposer?[launch.note,launch.style?'参考风格：'+launch.style:''].filter(Boolean).join('\n'):s.prompt;d.chat=[];d.chatInput='';d.allowed=true;d.style=0;
 }
 go(id);
}
function imagePreview(d){
 const key=d.scene||'audio',s=scenes[key],ratio=d.option.startsWith('9:16')?'9/16':d.option.startsWith('3:4')?'3/4':'1';
 return '<div class="photoStage"><div class="crop" style="aspect-ratio:'+ratio+'"><img src="'+safe(d.asset?.url||srcFor(key))+'" alt="'+safe(d.source)+'素材预览" style="object-fit:'+(d.fit||'contain')+';transform:scale('+(d.zoom||100)/100+')"></div></div>'+imageControls(d)+'<div class="canvasfoot"><b>'+safe(d.source)+'</b>'+uploadPicker('更换素材')+'</div>';
}
function attach(file){
 if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>20*1024*1024){toast('请选择 20 MB 以内的 JPG、PNG 或 WebP 图片');return}
 const asset={name:file.name,url:URL.createObjectURL(file)};
 materials.unshift(asset);
 if(state.page==='create'){launch.asset=asset}else if(state.page==='image'){Object.assign(current(),{asset,source:asset.name,confirmed:false,step:0})}
 render();toast('已载入本地商品图');
}
document.addEventListener('change',e=>{if(e.target.matches('[data-upload]'))attach(e.target.files[0]);if(e.target.id==='platform')launch.platform=e.target.value;if(e.target.id==='ratio')launch.ratio=e.target.value});
document.addEventListener('input',e=>{if(e.target.id==='brief')launch.note=e.target.value;if(e.target.id==='searchTools'){launch.search=e.target.value;byId('toolsFound').innerHTML=matchingTools()}});
document.addEventListener('dragover',e=>{if(e.target.closest('[data-drop]'))e.preventDefault()});
document.addEventListener('drop',e=>{if(e.target.closest('[data-drop]')){e.preventDefault();attach(e.dataTransfer.files[0])}});
document.addEventListener('click',e=>{
 const el=e.target.closest('button');if(!el)return;const a=el.dataset;
 if(a.seed!==undefined){
  const sample=scenes[launch.sample];launch.asset={name:sample.product,url:srcFor(launch.sample)};
  launch.note=launch.medium==='video'?'从耳罩细节缓慢拉远至耳机全景，保留蓝色背景，结尾定格。':sample.prompt;
  render();toast('已载入示例素材与需求');return
 }
 if(a.styles!==undefined){
  const styles=[['audio','冷调棚拍'],['leather','柔光静物'],['citrus','明亮撞色']];
  const choices=styles.map(([id,name])=>'<button class="styleChoice" data-style="'+name+'" aria-pressed="'+(launch.style===name)+'"><img src="'+srcFor(id)+'" alt=""><b>'+name+'</b></button>').join('');
  modal('<h2>参考风格</h2><p class="muted">所选风格将写入本次创作要求。</p><div class="styleChoices">'+choices+'</div><button class="plain" data-style="">清除风格</button>');return
 }
 if(a.style!==undefined){launch.style=a.style;byId('modal').close();render();return}
 if(a.medium){launch.medium=a.medium;if((a.medium==='image'&&launch.ratio==='16:9')||(a.medium==='video'&&launch.ratio==='3:4'))launch.ratio='1:1';render();return}
 if(a.format!==undefined){activeFormat[launch.medium]=Number(a.format);render();return}
 if(a.material!==undefined){launch.asset=materials[Number(a.material)];go('create');return}
 if(a.clear!==undefined){launch.asset=null;render();return}
 if(a.filter!==undefined){launch.filter=a.filter;render();return}
 if(a.lib!==undefined){launch.library=a.lib;render();return}
 if(a.scene){openTask('image',scenes[a.scene].tool,a.scene);return}
 if(a.kit){openTask(a.kit,a.cap,null);return}
 if(a.launch!==undefined){openTask(launch.medium,formats[launch.medium][activeFormat[launch.medium]][1],null,true);return}
 if(a.quick!==undefined){const q=quickTools[Number(a.quick)];openTask(q[1],q[2],null,true)}
});

function assetShelf(){
 const items=materials.map((x,i)=>'<button class="example" data-material="'+i+'"><div class="casePhoto"><img src="'+safe(x.url)+'" alt=""></div><div class="caseLine"><strong>'+safe(x.name)+'</strong><span>↗</span></div></button>').join('');
 return title('素材库','查看本次会话添加的商品素材，或使用内置案例开始创作。')+'<div class="labelRow"><h2>我的商品图</h2>'+uploadPicker('添加素材')+'</div>'+(items?'<div class="gallery">'+items+'</div>':emptyState('尚未添加商品图','添加本地素材后，可从素材库进入创作。'))+'<div class="labelRow homeSection"><h2>案例素材</h2></div><div class="gallery">'+Object.entries(scenes).map(([k,s])=>'<button class="example" data-scene="'+k+'" '+(state.disabled.has('image')?'disabled':'')+'><div class="casePhoto"><img src="'+srcFor(k)+'" alt="'+s.product+'"></div><div class="caseLine"><strong>'+s.product+'</strong><span>↗</span></div></button>').join('')+'</div>';
}
