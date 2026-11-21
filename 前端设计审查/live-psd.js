import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, select, toast, uid } from './live.js';

const endpoint = '/v1/studio/psd-documents';
const standard = { width:800,height:800,backgroundColor:'#ffffff',placement:{x:80,y:190,width:640,height:530},
  caption:{text:'',x:40,y:105,size:48,color:'#242a35',font:'chinese'} };
const valueField = (label,name,value,attrs) => field(label,input(name,attrs+' value="'+h(value)+'"'));
const number = (label,name,value,min,max) => valueField(label,name,value,'type="number" required min="'+min+'" max="'+max+'"');
const color = (label,name,value) => valueField(label,name,value,'type="color" required');

function editorFields(doc, images) {
  const {width,height,backgroundColor,placement,caption} = doc.layout;
  return valueField('设计名称','title',doc.title,'maxlength="120" required') +
    '<fieldset><legend>画布和背景</legend>' + number('画布宽度','width',width,64,2048) + number('画布高度','height',height,64,2048) +
    color('纯色背景','backgroundColor',backgroundColor) +
    field('背景图片',select('backgroundAssetId',[['','使用纯色背景'],...images],doc.backgroundAssetId ?? '')) + '</fieldset>' +
    '<fieldset><legend>商品主体</legend>' +
    field('主体图片',select('subjectAssetId',[['','选择素材'],...images],doc.subjectAssetId ?? '','required')) +
    number('主体左距','subjectX',placement.x,0,2047) + number('主体上距','subjectY',placement.y,0,2047) +
    number('主体宽度','subjectWidth',placement.width,1,2048) + number('主体高度','subjectHeight',placement.height,1,2048) + '</fieldset>' +
    '<fieldset><legend>可编辑文字</legend>' + valueField('文字内容','caption',caption.text,'maxlength="140" required') +
    number('文字左距','textX',caption.x,0,2047) + number('文字基线','textY',caption.y,1,2048) +
    number('字号','size',caption.size,8,256) + color('文字颜色','textColor',caption.color) +
    field('字体',select('font',[['chinese','中文无衬线'],['sans','Arial']],caption.font)) + '</fieldset>';
}

function readEditor(data, revision) {
  const num = name => Number(data.get(name));
  return { title:data.get('title'),subjectAssetId:data.get('subjectAssetId'),
    backgroundAssetId:data.get('backgroundAssetId') || null,revision,layout:{
      width:num('width'),height:num('height'),backgroundColor:data.get('backgroundColor'),
      placement:{x:num('subjectX'),y:num('subjectY'),width:num('subjectWidth'),height:num('subjectHeight')},
      caption:{text:data.get('caption'),x:num('textX'),y:num('textY'),size:num('size'),color:data.get('textColor'),font:data.get('font')},
    } };
}

export async function psdPage(ctx) {
  const [id] = ctx.args;
  if (!id) {
    const items = await ctx.all(endpoint);
    ctx.html(heading('分层设计') + link('新建设计','psd/new') +
      panel('我的设计',list(items,doc=>item(doc.title,date(doc.updatedAt),link('编辑设计','psd/'+doc.id)),'暂无已保存的设计。')));
    return;
  }

  const [doc, files] = await Promise.all([
    id === 'new' ? {id:uid(),revision:0,layout:standard} : ctx.api(endpoint+'/'+path(id)),
    ctx.all('/v1/assets'),
  ]);
  const images = files.filter(file=>['image/png','image/jpeg'].includes(file.mediaType)).map(file=>[file.id,file.name]);
  const target = endpoint+'/'+path(doc.id);
  ctx.html(heading(doc.title ?? '新建分层设计') + link('返回分层设计','psd') + link('上传图片素材','assets') +
    grid(panel('图层编辑',images.length ? form('psd-save',editorFields(doc,images),'保存设计') : notice('请先在素材库上传 PNG 或 JPEG 图片。')),
      panel('已保存的效果',doc.revision ? action('加载预览','psd-preview') + action('下载分层 PSD','psd-download') +
        '<div data-psd-preview aria-live="polite"></div>' + action('删除设计','psd-delete') : notice('保存设计后可以预览和下载。'))));
  ctx.submit('psd-save',async data=>{
    const saved=await ctx.api(target,{method:'PUT',body:readEditor(data,doc.revision)});
    toast('设计已保存');
    ctx.go('psd/'+saved.id);
  });
  let previewUrl;
  ctx.signal.addEventListener('abort',()=>{ if(previewUrl) URL.revokeObjectURL(previewUrl); },{once:true});
  ctx.click('psd-preview',async ()=>{
    const response=await ctx.api(target+'/preview',{raw:true});
    const blob=await response.blob();
    if (!ctx.active()) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl=URL.createObjectURL(blob);
    const image=new Image();
    image.className='live-media';
    image.alt='分层设计合成预览';
    image.src=previewUrl;
    document.querySelector('[data-psd-preview]').replaceChildren(image);
  });
  ctx.click('psd-download',async ()=>{
    const response=await ctx.api(target+'/export',{raw:true});
    const blob=await response.blob();
    if (!ctx.active()) return;
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;
    link.download='design-'+doc.id+'.psd';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),3000);
  });
  ctx.click('psd-delete',async ()=>{
    if (!confirm('删除这份分层设计？')) return;
    await ctx.api(target,{method:'DELETE'});
    ctx.go('psd');
  });
}
