import { action, field, form, h, input, link, select, textarea } from './live-ui.js';

export function downloadContent(name, text, type='text/plain;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([text],{type}));
  const anchor=document.createElement('a');anchor.download=name;anchor.href=url;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
}
export function textDelivery(text, name, bases) {
  const fields=field('修订稿',textarea('content','required',text))+action('下载当前修订稿 TXT','text-download')+
    (bases.length ? field('目标知识库',select('baseId',bases.map(b=>[b.id,b.name])))+
      field('文档名称',input('name','required maxlength="200" value="'+h(name)+'"')):'');
  return '<details class="live-fold"><summary>修订与导出文本</summary>'+
    (bases.length?form('text-delivery',fields,'另存为知识文档'):'<div data-text-delivery>'+fields+'</div>')+
    '<div data-text-saved role="status"></div></details>';
}
export function bindTextDelivery(ctx,id) {
  ctx.click('text-download',()=>{const node=document.querySelector('[data-form="text-delivery"],[data-text-delivery]');
    downloadContent('任务修订稿-'+id+'.txt',node.querySelector('[name=content]').value);});
  ctx.submit('text-delivery',async data=>{
    const base=data.get('baseId');
    const doc=await ctx.api('/v1/knowledge/bases/'+encodeURIComponent(base)+'/documents',{method:'POST',body:{name:data.get('name'),content:data.get('content')}});
    if(ctx.active())document.querySelector('[data-text-saved]').innerHTML=link('已保存，打开知识文档','resources/'+base+'/'+doc.id);
  });
}
