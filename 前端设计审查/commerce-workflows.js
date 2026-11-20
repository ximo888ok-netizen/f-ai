const selectOpts=(values,selected)=>values.map(v=>'<option '+(v===selected?'selected':'')+'>'+safe(v)+'</option>').join('');
function deskField(key,label,value,placeholder='',multi=false){
 const attr=' id="desk-'+key+'" data-desk-field="'+key+'" placeholder="'+safe(placeholder)+'"';
 return '<label for="desk-'+key+'">'+safe(label)+'</label>'+(multi?'<textarea'+attr+'>'+safe(value)+'</textarea>':'<input'+attr+' value="'+safe(value)+'">');
}
function deskTag(text){return '<span class="tag">'+safe(text)+'</span>'}
function recipeHeader(item){return title(item.name,item.desc,favorAction(item.id))}
function draftPanel(name,content){return '<section class="card"><div class="panelhead"><strong>'+safe(name)+'</strong></div><div class="pad">'+content+'</div></section>'}
function recipePreview(item,rows,extra=''){
 return draftPanel('交付预览',deskTag('本地草案')+'<h2 class="previewTitle">'+safe(item.name)+'</h2><dl class="recipeList">'+rows.map(([k,v])=>'<dt>'+safe(k)+'</dt><dd>'+safe(v||'待填写')+'</dd>').join('')+'</dl>'+extra);
}
function briefPage(item){
 const d=getDeskDraft(item.id),[one,oneHint,two,twoHint,output]=briefFields[item.id];
 const fields=deskField('content',one,d.content,oneHint,true)+deskField('extra',two,d.extra,twoHint,true);
 const consent=['talk','profiles','cloud'].includes(item.id)?'<label class="checkline"><input type="checkbox" data-desk-field="confirmed" '+(d.confirmed?'checked':'')+'> 已核对素材授权或店铺操作范围</label>':'';
 return recipeHeader(item)+'<div class="deskSplit">'+draftPanel('编写'+output,fields+consent+'<button class="primary spaceTop" data-save-brief>保存'+output+'</button>')+recipePreview(item,[['输出',output],[one,d.content],[two,d.extra]],'<p class="muted">保存后可在制作记录中检查或下载制作单。</p>')+'</div>';
}
function sequenceDraft(item){
 const d=getDeskDraft(item.id);if(!d.steps){
 const plan={analyze:['参考片开场','主体镜头','收束镜头'],talkmix:['虚拟形象开场','商品演示','形象收尾'],talkcustom:['讲解场景'],livecut:['真人开场','产品示范','购买提示'],livetimeline:['真人讲解'],materialcut:['商品全景','材质细节','结尾定格'],customcut:['素材场景'],news:['标题导入','事实陈述','来源说明']};
 d.steps=plan[item.id].map((name,i)=>({name,seconds:i===1?4:3,script:''}));
 }return d;
}
function sequencePage(item){
 const d=sequenceDraft(item);return recipeHeader(item)+'<div class="deskSplit">'+draftPanel('镜头编排',d.steps.map((s,i)=>'<div class="shotRow"><span>'+String(i+1).padStart(2,'0')+'</span><div><input data-shot-field="name" data-i="'+i+'" aria-label="镜头名称 '+(i+1)+'" value="'+safe(s.name)+'"><input data-shot-field="script" data-i="'+i+'" aria-label="镜头说明 '+(i+1)+'" placeholder="素材、旁白或画面要求" value="'+safe(s.script)+'"></div><label>秒<input type="number" min="1" max="600" data-shot-field="seconds" data-i="'+i+'" value="'+safe(s.seconds)+'"></label><button class="smallbtn" data-shot-up="'+i+'" '+(i?'':'disabled')+' aria-label="上移镜头">↑</button><button class="smallbtn" data-shot-remove="'+i+'" '+(d.steps.length===1?'disabled':'')+' aria-label="删除镜头">×</button></div>').join('')+'<div class="buttons spaceTop"><button class="plain" data-add-shot>添加镜头</button><button class="primary" data-save-sequence>保存编排</button></div>')+draftPanel('时间线预览','<div id="sequencePreview">'+timeline(d)+'</div>')+'</div>';
}
function timeline(d){
 let total=0;return d.steps.map(s=>{const start=total;total+=Math.max(0,Number(s.seconds)||0);return '<div class="timeLine"><small>'+start+'–'+total+' s</small><div><strong>'+safe(s.name)+'</strong><p>'+safe(s.script||'待填写镜头说明')+'</p></div></div>'}).join('')+'<b>总时长 '+total+' 秒</b>';
}
const numFields=[['price','客单价（元）'],['cost','单件货品成本（元）'],['shipping','单件履约成本（元）'],['rate','平台费率（%）'],['ad','每单广告支出（元）'],['units','成交单数']];
function calcResults(){
 const data=deskState.roi,n=key=>Number(data[key]);
 if(numFields.some(([k])=>data[k]===''||!Number.isFinite(n(k))||n(k)<0)||n('rate')>100||!Number.isInteger(n('units'))||n('price')<=0)return '<p class="notice warn">请输入正数客单价、非负成本、0–100% 费率和整数单量。</p>';
 const margin=n('price')*(1-n('rate')/100)-n('cost')-n('shipping'),net=margin-n('ad');
 const values=[['单件贡献利润','¥ '+net.toFixed(2)],['预计贡献利润','¥ '+(net*n('units')).toFixed(2)],['保本投产比',margin>0?(n('price')/margin).toFixed(2):'无正向空间'],['实际投产比',n('ad')>0?(n('price')/n('ad')).toFixed(2):'无广告支出']];
 return values.map(([k,v])=>'<div class="resultItem"><small>'+k+'</small><strong>'+v+'</strong></div>').join('');
}
function calcPage(item){return recipeHeader(item)+'<div class="deskSplit">'+draftPanel('单笔订单假设','<div class="numericGrid">'+numFields.map(([k,n])=>'<label>'+n+'<input data-roi="'+k+'" type="number" step="'+(k==='units'?'1':'.01')+'" min="0" value="'+safe(deskState.roi[k])+'"></label>').join('')+'</div>')+draftPanel('即时测算','<div id="roiResults" class="numericGrid">'+calcResults()+'</div><p class="muted spaceTop">投产比为销售额除以广告支出。贡献利润扣除货品、履约、平台和广告成本；此模型假设无退款，不计税费与固定费用。</p>')+'</div>';}
function workflowInput(e){
 const item=entryByPage(state.page);if(!item)return;
 const el=e.target,a=el.dataset;
 if(a.deskField){const d=getDeskDraft(item.id);d[a.deskField]=el.type==='checkbox'?el.checked:el.value;
 const list=document.querySelector('.recipeList');if(item.kind==='brief'&&list){const cells=list.querySelectorAll('dd');cells[1].textContent=d.content||'待填写';cells[2].textContent=d.extra||'待填写'} }
 if(a.roi){deskState.roi[a.roi]=el.value;byId('roiResults').innerHTML=calcResults()}
 if(a.shotField){const d=sequenceDraft(item);d.steps[Number(a.i)][a.shotField]=el.value;byId('sequencePreview').innerHTML=timeline(d)}
 if(a.nodeName!==undefined){deskState.board[Number(a.nodeName)].name=el.value;document.querySelectorAll('[data-node-parent] option').forEach(o=>{if(Number(o.value)===Number(a.nodeName))o.textContent=(Number(a.nodeName)+1)+' · '+el.value})}
 if(a.nodeParent!==undefined)deskState.board[Number(a.nodeParent)].parent=Number(el.value);
}
document.addEventListener('input',workflowInput);
function finished(item,title,data){saveDeskJob(item,title,data);go(deskPage('history'));toast('已保存到本次会话的制作记录')}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;const a=b.dataset,item=entryByPage(state.page);if(!item)return;
 if(a.saveBrief!==undefined){const d=getDeskDraft(item.id);if(!d.content.trim()||!d.extra.trim()){toast('请填写两项制作信息');return}
 if(['talk','profiles','cloud'].includes(item.id)&&!d.confirmed){toast('请先核对授权范围');return}
 finished(item,briefFields[item.id][4],{[briefFields[item.id][0]]:d.content,[briefFields[item.id][2]]:d.extra,已核对范围:d.confirmed})}
 if(a.saveSequence!==undefined||a.addShot!==undefined||a.shotRemove!==undefined||a.shotUp!==undefined){
 const d=sequenceDraft(item);if(a.addShot!==undefined)d.steps.push({name:'新镜头',seconds:3,script:''});
 if(a.shotRemove!==undefined&&d.steps.length>1)d.steps.splice(Number(a.shotRemove),1);
 if(a.shotUp!==undefined){const i=Number(a.shotUp);if(i>0)[d.steps[i-1],d.steps[i]]=[d.steps[i],d.steps[i-1]]}
 if(a.saveSequence!==undefined){if(d.steps.some(s=>!s.name.trim()||Number(s.seconds)<=0||Number(s.seconds)>600)){toast('每个镜头需要名称和 1–600 秒的时长');return}finished(item,item.name+' · 镜头清单',d.steps);return}render()}
 if(a.addNode!==undefined){const type=byId('node-type').value;deskState.board.push({type,name:type+'节点',parent:deskState.board.length-1});render()}
 if(a.saveBoard!==undefined){if(deskState.board.some(n=>!n.name.trim())){toast('请补全节点名称');return}finished(item,'素材流程 · '+deskState.board.length+' 个节点',deskState.board)}
});

