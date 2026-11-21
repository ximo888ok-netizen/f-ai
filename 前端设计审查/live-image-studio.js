import { action, field, form, heading, input, item, link, list, notice, panel, path, retryKey, select, toast } from './live.js';
import { downloadFile } from './live-files.js';
import { assetField, editRows, imageFiles, numeric, rowControls, toggleFields } from './live-media-controls.js';

const root='/v1/media/images/batches';
const profiles=[
  ['square','800 × 800 方形'],['portrait','900 × 1200 竖图'],['story','720 × 1280 竖屏'],
  ['wide','1280 × 720 横屏'],['detail','800 × 4800 详情长图'],['custom','自定义宽高'],['scale','按倍数放大'],
];
const failures={
  SOURCE_UNAVAILABLE:'素材不存在、访问受限或不属于当前账号',
  SOURCE_INVALID:'图片无法读取',
  MASK_DIMENSIONS:'蒙版和替换图需与主体图片同尺寸',
  OUTPUT_DIMENSIONS:'放大后的宽高或总像素超过限制',
  OUTPUT_TOO_LARGE:'导出的文件大于 10 MiB',
};

function imageRow(files,assetId) {
  return '<fieldset data-edit-row><legend>处理项</legend>' +
    field('SKU 或处理名称',input('key','required maxlength="100"')) +
    field('图片组成',select('composition',[['single','单张图片'],['stack','纵向拼接']], 'single')) +
    assetField('主体图片','source',files,assetId,true,'选择图片') +
    '<div class="live-fields" data-image-stack>' + [2,3,4,5,6].map(index=>
      assetField('第 '+index+' 张图','panel',files)).join('') + '</div>' +
    field('画布尺寸',select('size',profiles,'square')) +
    '<div class="live-fields" data-image-size>' + numeric('自定义宽度','width',800,32,1920) +
    numeric('自定义高度','height',800,32,6144) + '</div>' +
    '<div data-image-scale>'+numeric('放大倍数','scale',2,2,4)+'</div>' +
    field('适配方式',select('fit',[['contain','等比保留完整图片'],['cover','等比裁切填满']], 'contain')) +
    field('格式',select('format',[['png','PNG'],['jpeg','JPG']], 'png')) +
    field('背景方式',select('backgroundMode',[['default','使用默认背景'],['color','纯色背景'],['transparent','透明背景'],
      ['asset','使用背景图片']], 'default')) +
    '<div data-image-color>'+field('纯色背景颜色',input('background','type="color" value="#ffffff"'))+'</div>' +
    '<div data-image-background>'+assetField('背景素材','backgroundAssetId',files,'',true,'选择背景图片')+'</div>' +
    '<div class="live-fields" data-image-edit>'+field('局部编辑',select('edit',
      [['','不编辑'],['cutout','按蒙版抠图'],['tint','按蒙版着色'],['replace-region','按蒙版替换选区']],'')
    )+'<div data-image-mask>'+assetField('蒙版图片','maskAssetId',files,'',true,'选择蒙版图片')+'</div>' +
    '<div data-image-tint>'+field('着色颜色',input('color','type="color" value="#2867af"'))+'</div>' +
    '<div data-image-replace>'+assetField('替换图片','replacementAssetId',files,'',true,'选择替换图片')+'</div></div>' +
    rowControls('移除处理项') + '</fieldset>';
}

function imageFields(row) {
  const controls=row.elements;
  const value=name=>controls.namedItem(name).value;
  const stack=value('composition')==='stack';
  const size=controls.namedItem('size');
  const scaleOption=size.querySelector('option[value=scale]');
  scaleOption.disabled=stack;
  if (stack && size.value==='scale') size.value='detail';
  const background=controls.namedItem('backgroundMode');
  background.querySelector('option[value=asset]').disabled=stack;
  if (stack && background.value==='asset') background.value='default';
  toggleFields(row,'[data-image-stack]',stack);
  toggleFields(row,'[data-image-size]',size.value==='custom');
  toggleFields(row,'[data-image-scale]',size.value==='scale');
  toggleFields(row,'[data-image-color]',background.value==='color');
  toggleFields(row,'[data-image-background]',background.value==='asset');
  toggleFields(row,'[data-image-edit]',!stack);
  if (stack) return;
  const edit=value('edit');
  toggleFields(row,'[data-image-mask]',Boolean(edit));
  toggleFields(row,'[data-image-tint]',edit==='tint');
  toggleFields(row,'[data-image-replace]',edit==='replace-region');
}

function readJob(row) {
  const value=name=>row.elements.namedItem(name).value;
  const stack=value('composition')==='stack';
  const panels=stack?[...row.querySelectorAll('[name=panel]')].map(node=>node.value).filter(Boolean):[];
  if (stack && !panels.length) throw new Error('纵向拼接需要至少两张图片。');
  const body={key:value('key').trim(),assetIds:[value('source'),...panels],fit:value('fit'),format:value('format')};
  const size=value('size');
  if (size==='custom') Object.assign(body,{width:Number(value('width')),height:Number(value('height'))});
  else if (size==='scale') body.scale=Number(value('scale'));
  else body.profile=size;
  const background=value('backgroundMode');
  if (background==='color') body.background=value('background');
  if (background==='transparent') body.background='transparent';
  if (background==='asset') {
    body.backgroundAssetId=value('backgroundAssetId');
    body.background='#ffffff';
  }
  const method=stack?'':value('edit');
  if (method) {
    body.edit={method,maskAssetId:value('maskAssetId')};
    if (method==='tint') body.edit.color=value('color');
    if (method==='replace-region') body.edit.replacementAssetId=value('replacementAssetId');
  }
  if (body.format==='jpeg' && (background==='transparent' || (background==='default' && method==='cutout'))) {
    throw new Error('透明背景需要 PNG，请更换格式或选择背景。');
  }
  return body;
}

function batchResults(batch) {
  return panel('批次结果',list(batch.items,entry=>entry.state==='succeeded'?
    item(entry.key,entry.width+' × '+entry.height+' · '+(entry.mediaType==='image/jpeg'?'JPG':'PNG')+
      (entry.aiGenerated?' · AI 标识':''),
      action('预览图片','image-preview',entry.assetId)+action('下载图片','image-download',entry.assetId)) :
    item(entry.key,failures[entry.error] ?? entry.error)) + '<div data-image-preview-area aria-live="polite"></div>');
}

export async function imageStudio(ctx,id,assetId,navigation) {
  const [assets,batch]=await Promise.all([ctx.all('/v1/assets'),id?ctx.api(root+'/'+path(id)):null]);
  const files=imageFiles(assets);
  const controls=files.length?form('image-batch','<div class="live-fields" data-edit-rows>'+imageRow(files,assetId)+'</div>'+
    '<button type="button" class="plain" data-row-command="add">添加处理项</button>','开始处理') :
    notice('请先在素材库上传 PNG 或 JPEG 图片。');
  ctx.html(heading('图片处理')+navigation+link('打开素材库','assets')+
    (batch?batchResults(batch):'')+panel('新批次',controls));
  if (!ctx.active()) return;
  const editor=document.querySelector('[data-form=image-batch]');
  if (editor) editRows(editor,()=>imageRow(files),8,{update:imageFields});
  const key=retryKey();
  ctx.submit('image-batch',async (_data,node)=>{
    const items=[...node.querySelectorAll('[data-edit-row]')].map(readJob);
    const saved=await ctx.api(root,{method:'POST',body:{id:key(items),items}});
    toast('批次处理完成，结果已记录');
    ctx.go('media/images/'+saved.id);
  });
  let preview;
  ctx.signal.addEventListener('abort',()=>{if (preview) URL.revokeObjectURL(preview);},{once:true});
  ctx.click('image-preview',async assetId=>{
    const response=await ctx.api('/v1/assets/'+path(assetId)+'/content',{raw:true});
    const blob=await response.blob();
    if (!ctx.active()) return;
    if (preview) URL.revokeObjectURL(preview);
    preview=URL.createObjectURL(blob);
    const img=new Image();
    img.className='live-media';
    img.alt='处理结果预览';
    img.src=preview;
    document.querySelector('[data-image-preview-area]').replaceChildren(img);
  });
  ctx.click('image-download',assetId=>{
    const entry=batch.items.find(item=>item.assetId===assetId);
    return downloadFile(ctx,'/v1/assets/'+path(assetId)+'/content',
      assetId+(entry.mediaType==='image/jpeg'?'.jpg':'.png'));
  });
}
