import { action, date, field, h, heading, input, link, panel, path } from './live-ui.js';
import { downloadFile } from './live-files.js';

export function searchable(label, entries) {
  return '<div data-record-search>'+field(label,input('query','type="search" maxlength="160" data-record-query'))+
    '<div data-record-rows>'+entries+'</div><p class="live-muted" role="status" data-record-count hidden></p></div>';
}
export function bindRecordSearch(main) {
  main.addEventListener('input',event=>{
    if (!event.target.matches('[data-record-query]'))return;
    const query=event.target.value.trim().toLocaleLowerCase();
    const group=event.target.closest('[data-record-search]');
    const rows=[...group.querySelectorAll('[data-record-rows] > .live-item')];
    let count=0;
    for(const row of rows){
      const match=!query||row.textContent.toLocaleLowerCase().includes(query);
      row.hidden=!match;if(match)count++;
    }
    const status=group.querySelector('[data-record-count]');
    status.hidden=!query;status.textContent=count?'匹配 '+count+' 条。':'没有匹配记录。';
  });
}

export async function assetDetails(ctx,id) {
  const endpoint='/v1/assets/'+path(id);
  const asset=await ctx.api(endpoint);
  const pairs=[['类型',asset.mediaType],['大小',asset.sizeBytes+' 字节'],['来源',asset.source],['用途',asset.purpose],
    ['上传时间',date(asset.createdAt)],['授权凭证',asset.consentReference||'未登记'],['授权期限',date(asset.consentExpiresAt)],['SHA-256',asset.sha256]];
  ctx.html(heading(asset.name)+link('返回素材库','assets')+panel('文件与授权',
    '<dl class="live-facts">'+pairs.map(([k,v])=>'<dt>'+h(k)+'</dt><dd>'+h(v)+'</dd>').join('')+'</dl>'+
    action('下载原文件','asset-file')+action('校验原文件','asset-verify')+'<p data-check-file role="status"></p>')+
    (['image/png','image/jpeg'].includes(asset.mediaType)?link('以这张图开始处理','media/images/new/'+path(id)):''));
  ctx.click('asset-file',()=>downloadFile(ctx,endpoint+'/content',asset.name));
  ctx.click('asset-verify',async()=>{
    const response=await ctx.api(endpoint+'/content',{raw:true});
    const hash=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
    const digest=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
    if(ctx.active())document.querySelector('[data-check-file]').textContent=digest===asset.sha256?'校验通过，文件内容与登记摘要一致。':'校验失败，下载内容与登记摘要不一致。';
  });
}
