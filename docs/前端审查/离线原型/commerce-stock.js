function fileDownload(filename,obj){
 const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),4000);
}
function packageParts(item,d){
 const styles=item.id==='variant'?d.extra.split(/[、，,\n]/).map(v=>v.trim()).filter(Boolean):['标准版'];
 return styles.map(style=>({方案:style,主图:'展示'+(d.name.trim()||'商品')+'的主体和外观',规格:d.skus||'标准款',详情:['商品全貌','关键细节','使用场景'],属性说明:d.content}));
}
function packagePage(item){
 const d=getDeskDraft(item.id),base=deskState.inventory;
 const picker='<label for="base-product">从商品档案带入</label><select id="base-product"><option value="">选择档案</option>'+base.map(x=>'<option value="'+x.id+'" '+(Number(d.base)===x.id?'selected':'')+'>'+safe(x.name)+'</option>').join('')+'</select>';
 const source=deskField('name','商品名称',d.name,'例如：弧形手柄托特包')+deskField('content','材质、规格与卖点',d.content,'填写有依据的商品事实',true)+deskField('skus','SKU 规格',d.skus||'','例如：奶油白、雾灰')+'<label for="desk-category">商品分类</label><select id="desk-category" data-desk-field="category">'+selectOpts(deskState.cats,d.category)+'</select>';
 const style=item.id==='variant'?deskField('extra','展示主题（用顿号分隔）',d.extra,'如：影棚、通勤、质感特写'):'';
 const hasSource=item.id==='duplicate'||item.id==='variant';
 const materialOptions=Object.entries(scenes).map(([key,v])=>'<option value="'+key+'" '+(d.scene===key?'selected':'')+'>'+safe(v.product)+'</option>').join('');
 const assetSelect='<label for="desk-scene">关联样例素材</label><select id="desk-scene" data-desk-field="scene"><option value="">仅登记商品资料</option>'+materialOptions+'</select>';
 return recipeHeader(item)+'<div class="deskSplit">'+draftPanel('商品资料', (hasSource?picker:'')+source+assetSelect+style+'<div class="buttons spaceTop"><button class="plain" data-stock-seed>带入样例</button><button class="primary" data-stock-save>'+((deskState.edit&&item.id==='bundle')?'保存修改':'保存并入库')+'</button></div>')+draftPanel('商品包结构','<div class="packageCover" id="stockCover">'+coverMarkup(d)+'</div><div id="packSummary">'+packSummary(item,d)+'</div><p class="muted">导出内容为商品字段、SKU 与视觉制作清单。成品图片可从图片工作室制作。</p>')+'</div>';
}
function coverMarkup(d){return d.scene&&scenes[d.scene]?'<img src="'+srcFor(d.scene)+'" alt="'+safe(scenes[d.scene].product)+'"><span>关联素材</span>':'<div class="coverEmpty">'+glyph('folder')+'选择素材后可预览商品参考图</div>'}
function packSummary(item,d){const parts=packageParts(item,d);return '<h2 class="previewTitle">'+safe(d.name||'待命名商品')+'</h2><p>'+safe(d.category)+' · '+parts.length+' 套方案</p><div class="tags spaceTop">'+['主图','SKU','详情','属性'].map(deskTag).join('')+'</div>';}
const stockIds=['products','categories','imports','exports'];
function stockPage(item){
 const bars='<div class="tabs">'+stockIds.map(id=>deskButton(id,deskIndex.get(id).name,'pill '+(id===item.id?'sel':''))).join('')+'</div>';
 let body='';
 if(item.id==='products'){const items=deskState.inventory.filter(x=>deskState.stockFilter==='全部'||x.category===deskState.stockFilter);
 body='<div class="stockbar"><label>筛选分类<select id="stock-filter">'+selectOpts(['全部',...deskState.cats],deskState.stockFilter)+'</select></label>'+deskButton('bundle','新建资料包','primary')+'</div>'+
 (items.length?'<div class="stocklist">'+items.map(x=>'<div class="stockrow"><div><strong>'+safe(x.name)+'</strong><small>'+safe(x.category)+' · '+x.parts.length+' 套方案 · '+safe(x.skus||'标准款')+'</small></div><div class="buttons"><button class="smallbtn" data-stock-edit="'+x.id+'">编辑</button><button class="smallbtn" data-make-image="'+x.id+'">制作主图</button><button class="smallbtn" data-export="'+x.id+'">导出 JSON</button></div></div>').join('')+'</div>':'<p class="notice">当前分类还没有商品。创建资料包或导入此前导出的 JSON。</p>')}
 if(item.id==='categories')body='<label for="new-cat">新分类名称</label><div class="buttons"><input id="new-cat" maxlength="40" placeholder="如：家居"><button class="plain" data-add-cat>添加</button></div><div class="tags spaceTop">'+deskState.cats.map(c=>deskTag(c+' · '+deskState.inventory.filter(x=>x.category===c).length)).join('')+'</div>';
 if(item.id==='imports'||item.id==='exports'){
 const imp=item.id==='imports',list=deskState.transfers.filter(x=>x.type===item.id);
 body=(imp?'<label class="uploadButton stockupload">导入商品包<input type="file" accept=".json,application/json" id="stock-import"></label>':deskButton('products','前往商品档案导出','plain'))+
 (list.length?list.map(x=>'<div class="stockrow"><strong>'+safe(x.name)+'</strong><small>'+safe(x.time)+'</small></div>').join(''):'<p class="notice">本次会话暂无'+(imp?'导入':'导出')+'记录。</p>')}
 return recipeHeader(item)+bars+draftPanel(item.name,body);
}
function updateDraft(d,x){Object.assign(d,{name:x.name,content:x.content,skus:x.skus,category:x.category,extra:x.parts.map(a=>a.方案).join('、'),base:x.id,scene:x.scene||''});}
function makeTransfer(type,name){deskState.transfers.unshift({type,name,time:new Date().toLocaleTimeString('zh-CN')})}
function validPackage(x){
 if(!x||!['name','category','content','skus'].every(k=>typeof x[k]==='string'&&x[k].length<=20000)||!x.name.trim()||!x.category.trim())return false;
 return Array.isArray(x.parts)&&x.parts.length>0&&x.parts.length<=100&&x.parts.every(a=>a&&['方案','主图','规格','属性说明'].every(k=>typeof a[k]==='string')&&Array.isArray(a.详情)&&a.详情.every(v=>typeof v==='string'));
}
document.addEventListener('change',async e=>{
 const item=entryByPage(state.page),el=e.target;
 if(el.id==='base-product'&&item){const d=getDeskDraft(item.id),x=deskState.inventory.find(x=>x.id===Number(el.value));if(x)updateDraft(d,x);else d.base='';render()}
 if(el.id==='stock-filter'){deskState.stockFilter=el.value;render()}
 if(el.id!=='stock-import'||!el.files[0])return;
 try{const file=el.files[0];if(file.size>2*1024*1024)throw Error('文件超过 2 MB');
 const obj=JSON.parse(await file.text());if(obj.format!=='fai-product-v1'||!validPackage(obj.product))throw Error('文件格式不匹配，请导入本工作台导出的商品包');
 const x=obj.product;x.id=++deskState.sequence;x.scene=Object.hasOwn(scenes,x.scene)?x.scene:'';deskState.inventory.unshift(x);if(!deskState.cats.includes(x.category))deskState.cats.push(x.category);
 makeTransfer('imports',x.name);render();toast('商品包已导入')}catch(err){toast(err instanceof SyntaxError?'无法解析 JSON 文件':err.message);el.value=''}
});
document.addEventListener('input',e=>{const item=entryByPage(state.page);if(item?.kind==='package'&&e.target.dataset.deskField){byId('packSummary').innerHTML=packSummary(item,getDeskDraft(item.id));byId('stockCover').innerHTML=coverMarkup(getDeskDraft(item.id))}});
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;const a=b.dataset,item=entryByPage(state.page);
 if(a.stockSeed!==undefined&&item){Object.assign(getDeskDraft(item.id),{name:'弧形手柄托特包',content:'粒面皮革，顶部弧形手柄，内置拉链袋。',skus:'奶油白、烟灰',extra:'棚拍、日常通勤',category:'箱包',scene:'leather'});render()}
 if(a.stockSave!==undefined&&item){const d=getDeskDraft(item.id);if(!d.name.trim()||!d.content.trim()||(item.id==='variant'&&!packageParts(item,d).length)){toast('请填写商品名、商品事实和所需主题');return}
 const id=(item.id==='bundle'&&deskState.edit)||++deskState.sequence,x={id,name:d.name.trim(),content:d.content,category:d.category,skus:d.skus||'标准款',parts:packageParts(item,d),scene:d.scene||''};
 deskState.inventory=[x,...deskState.inventory.filter(o=>o.id!==id)];deskState.edit=null;deskState.drafts.delete(item.id);deskState.stockFilter='全部';saveDeskJob(item,x.name,x);deskOpen('products');toast('商品资料已入库')}
 if(a.makeImage){const x=deskState.inventory.find(v=>v.id===Number(a.makeImage));if(!x||state.disabled.has('image')){toast('请先启用图片插件');return}
 const d=draft('image');Object.assign(d,{action:'商品主图',mode:'flow',step:0,scene:x.scene||'leather',asset:null,source:x.name,prompt:x.content+'；规格：'+x.skus,confirmed:false});go('image');return}
 if(a.stockEdit){const x=deskState.inventory.find(v=>v.id===Number(a.stockEdit));deskOpen('bundle');deskState.edit=x.id;updateDraft(getDeskDraft('bundle'),x);render()}
 if(a.export){const x=deskState.inventory.find(v=>v.id===Number(a.export));fileDownload(x.name.replace(/[\\/:*?"<>|]/g,'_')+'.json',{format:'fai-product-v1',product:x});makeTransfer('exports',x.name);toast('商品资料包已导出')}
 if(a.addCat!==undefined){const c=byId('new-cat').value.trim();if(!c||c==='全部'||deskState.cats.includes(c)){toast('请输入未使用的分类名称');return}deskState.cats.push(c);render()}
});

