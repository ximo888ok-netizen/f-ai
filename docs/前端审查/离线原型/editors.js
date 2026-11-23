function imageControls(d) {
 const fit=d.fit||'contain', zoom=d.zoom||100;
 return '<div class="editorTools"><div class="hubTabs" aria-label="图片显示">'+['contain','cover'].map((v,i)=>
 '<button data-fit="'+v+'" aria-pressed="'+(fit===v)+'">'+['完整显示','填满画布'][i]+'</button>').join('')+
 '</div><label class="zoomLabel">缩放<input id="imageZoom" type="range" min="70" max="160" step="5" value="'+zoom+'"><output id="zoomValue">'+zoom+'%</output></label></div>';
}
function storyboard(d) {
 const shots=d.shots??=['商品全景','材质与细节','定格与品名'],i=d.shot??0;
 const times=d.durations??=[3,4,3],src=d.asset?.url||srcFor(d.scene||'audio');
 return '<div class="sample"><h2>上新短片分镜</h2><div class="story">'+shots.map((s,j)=>
 '<button class="shotCard '+(i===j?'selected':'')+'" data-shot="'+j+'" aria-pressed="'+(i===j)+'"><span class="shotImage"><img src="'+safe(src)+'" alt="" style="object-position:'+([50,75,35][j])+'% center;transform:scale('+([1,1.35,1.1][j])+')"><small>0'+(j+1)+' · '+times[j]+' s</small></span><strong>'+safe(s)+'</strong></button>').join('')+
 '</div>'+field('shotText','镜头 '+(i+1)+' · 画面说明',input('shotText',d.shotEdits?.[i]?.text??shots[i]))+'<label>镜头时长（秒）<input data-clip-time type="number" min="1" max="600" value="'+safe(d.shotEdits?.[i]?.seconds??times[i])+'"></label><div class="buttons spaceTop">'+
 button('saveShot','应用修改','primary')+'<button class="plain" data-export-shots>导出分镜单</button></div></div>';
}
function servicePreview(d){
 const entries=d.replies||[];
 return '<div class="sample"><div class="labelRow"><h2>商品咨询</h2><span class="tag">'+(d.human?'人工接待中':'AI 草稿')+'</span></div>'+
 '<p class="bubble">顾客　这款饮品开封后怎么保存？</p><p class="metric">引用依据　商品库 / 保存指南</p>'+
 entries.map(m=>'<div class="bubble"><small>'+safe(m.kind)+'</small><p>'+safe(m.body)+'</p></div>').join('')+
 '<label>回复内容<textarea id="serviceReply" placeholder="输入回复，或插入快捷话术">'+safe(d.reply||'')+'</textarea></label>'+
 '<div class="buttons editorActions"><button class="smallbtn" data-reply-template>插入保存指南</button>'+button('handoff',d.human?'交回 AI':'转人工接管','plain')+
 '<button class="primary" data-reply-save>'+(d.human?'记录人工回复':'保存回复草稿')+'</button></div></div>';
}
function opsPreview(d){
 const rows=d.items??=[{name:'青提气泡茶 330 mL',status:'草稿',target:'上架'}];
 return '<div class="sample"><h2>店铺操作预览</h2><div class="metric">'+safe(d.source)+' · '+safe(d.option)+'</div>'+
 ''+dataTable('商品变更清单',['商品','当前','拟变更'],rows.map((r,i)=>
 '<tr><td>'+safe(r.name)+'</td><td>'+safe(r.status)+'</td><td><select data-item-status="'+i+'" aria-label="'+safe(r.name)+'拟变更">'+selectOpts(['上架','下架','保持草稿'],r.target)+'</select></td></tr>').join(''))+
 '<label>添加商品<input id="opsItem" maxlength="100" placeholder="商品名或 SKU" value="'+safe(d.newItem||'')+'"></label><button class="plain spaceTop" data-add-item>加入变更清单</button></div>';
}
function copyVersion(d){
 const store=d.versions??={};
 if(!Object.hasOwn(store,d.option))store[d.option]={body:d.option==='英文'?'Muscat grape sparkling tea':'第一款青提气泡茶，清爽气泡搭配青提风味。',saved:[]};
 return store[d.option];
}
function copyTone(body){return /第一/.test(body)?'warning':'neutral';}
function copyWarnings(body){return /第一/.test(body)?'发现待核验用词「第一」。':'当前文案未命中示例词表。';}
function copyPreview(d){
 const v=copyVersion(d);
 return '<div class="sample"><h2>商品文案校阅</h2><label>正文 · '+safe(d.option)+'<textarea id="copyBody">'+safe(v.body)+'</textarea></label>'+
 '<p class="notice" id="copyCheck" role="status" data-tone="'+copyTone(v.body)+'">'+copyWarnings(v.body)+'</p><div class="buttons editorActions"><button class="smallbtn" data-soften>替换「第一」</button><button class="primary" data-save-version>保存版本</button><button class="plain" data-export-copy>导出正文</button></div>'+
 (v.saved.length?'<div class="editorHistory"><b>版本记录</b>'+v.saved.map((body,i)=>hubRow('版本 '+(i+1),body.slice(0,55),'<button class="smallbtn" data-restore-version="'+i+'">载入</button>')).reverse().join('')+'</div>':'')+'</div>';
}
document.addEventListener('input',e=>{
 const el=e.target;
 if(!['image','video','service','ops','copy'].includes(state.page))return;
 const d=current();
 if(el.id==='imageZoom'){d.zoom=Number(el.value);document.querySelector('.crop img').style.transform='scale('+d.zoom/100+')';byId('zoomValue').value=d.zoom+'%';}
 if(el.matches('[data-clip-time]'))((d.shotEdits??={})[d.shot??0]??={}).seconds=el.value;
 if(el.id==='serviceReply')d.reply=el.value;
 if(el.id==='opsItem')d.newItem=el.value;
 if(el.matches('[data-item-status]')){d.items[Number(el.dataset.itemStatus)].target=el.value;d.confirmed=false;const check=document.querySelector('[data-field=confirmed]');if(check)check.checked=false;}
 if(el.id==='copyBody'){copyVersion(d).body=el.value;const feedback=byId('copyCheck');feedback.dataset.tone=copyTone(el.value);feedback.textContent=copyWarnings(el.value);}
});
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||!Object.hasOwn(plugins,state.page))return;
 const d=current(),a=b.dataset;
 if(a.fit){d.fit=a.fit;render();return;}
 if(b.hasAttribute('data-export-shots')){fileDownload('分镜清单.json',d.shots.map((s,i)=>({镜头:i+1,说明:s,秒数:d.durations[i]})));return;}
 if(b.hasAttribute('data-reply-template')){d.reply='请冷藏，并按包装标注的时限饮用。';render();byId('serviceReply').focus();return;}
 if(b.hasAttribute('data-reply-save')){if(!d.reply?.trim()){toast('请先填写回复');return;}(d.replies??=[]).push({kind:d.human?'人工回复 · 本地记录':'待审草稿',body:d.reply.trim()});d.reply='';render();return;}
 if(b.hasAttribute('data-add-item')){
   const name=d.newItem?.trim();if(!name||d.items.some(r=>r.name===name)){toast('请输入尚未添加的商品名或 SKU');return;}
   d.items.push({name,status:'草稿',target:'上架'});d.newItem='';d.confirmed=false;render();return;
 }
 if(state.page!=='copy')return;
 const v=copyVersion(d);
 if(b.hasAttribute('data-soften')){v.body=v.body.replace(/第一/g,'本期推荐');render();}
 if(b.hasAttribute('data-save-version')){if(!v.body.trim()){toast('请填写文案');return;}if(v.saved.at(-1)!==v.body)v.saved.push(v.body);render();toast('已保存当前版本');}
 if(a.restoreVersion!==undefined){v.body=v.saved[Number(a.restoreVersion)];render();}
 if(b.hasAttribute('data-export-copy')){
   if(!v.body.trim()){toast('请填写文案');return;}
   const url=URL.createObjectURL(new Blob([v.body],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');
   link.href=url;link.download='商品文案.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),4000);
 }
});
