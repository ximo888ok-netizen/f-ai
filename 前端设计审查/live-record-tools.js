import { action, date, field, h, form, heading, input, link, notice, panel, path } from './live-ui.js';
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


const reviewReasons = {
  SHORT_SIDE: '图片短边不足 1024 像素', PERSON_COUNT: '人物数量不符合本工具要求',
  OCCLUSION: '服装遮挡超过 5%', DURATION: '视频不在 1–10 秒范围内',
  RESOLUTION: '视频短边不在 720–1080 像素范围内', MULTIPLE_SHOTS: '需要单镜头',
  FACING_ANGLE: '最大正脸偏转角超过 60°',
};
const imageReview = [
  ['personCount', '画面人数（纯商品图填 0）', 0, 10000, 1],
  ['occlusionPercent', '服装遮挡比例（%）', 0, 100, 'any'],
];
const videoReview = [
  ['shotCount', '镜头数量', 1, 10000, 1],
  ['personCount', '画面人数', 0, 10000, 1],
  ['maxFacingAngle', '人物最大正脸偏转角（度）', 0, 180, 'any'],
];

async function sourceReview(ctx, kind, id) {
  const url = '/v1/media/' + kind + '/' + path(id) + '/preflight';
  const fields = kind === 'images' ? imageReview : videoReview;
  let saved;
  try { saved = await ctx.api(url); }
  catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
  const status = saved ? notice(saved.width + ' × ' + saved.height +
    (saved.durationSeconds === undefined ? '' : ' · ' + saved.durationSeconds.toFixed(2) + ' 秒') +
    ' · ' + (saved.eligible ? '已通过预检' : '未通过：' + saved.reasons.map(reason => reviewReasons[reason] ?? reason).join('、'))) :
    notice('换装或替换商品前，请核对素材并填写实际观察结果。尺寸和时长由服务端检测。');
  const editor = form('source-review', fields.map(([key, label, min, max, step]) => field(label, input(key,
    'type="number" required min="' + min + '" max="' + max + '" step="' + step + '" value="' + h(saved?.[key]) + '"'))).join(''), '保存素材预检');
  return { html: panel('素材预检', status + editor), async save(data) {
    const values = Object.fromEntries(fields.map(([key]) => [key, Number(data.get(key))]));
    await ctx.api(url, { method: 'PUT', body: { revision: saved?.revision ?? 0, ...values } });
    ctx.reload();
  } };
}

export async function assetDetails(ctx,id) {
  const endpoint='/v1/assets/'+path(id);
  const asset=await ctx.api(endpoint);
  const isImage = ['image/png', 'image/jpeg'].includes(asset.mediaType);
  const kind = isImage ? 'images' : asset.mediaType === 'video/mp4' ? 'videos' : null;
  const review = kind ? await sourceReview(ctx, kind, id) : null;
  const pairs=[['类型',asset.mediaType],['大小',asset.sizeBytes+' 字节'],['来源',asset.source],['用途',asset.purpose],
    ['上传时间',date(asset.createdAt)],['授权凭证',asset.consentReference||'未登记'],['授权期限',date(asset.consentExpiresAt)],['SHA-256',asset.sha256]];
  ctx.html(heading(asset.name)+link('返回素材库','assets')+panel('文件与授权',
    '<dl class="live-facts">'+pairs.map(([k,v])=>'<dt>'+h(k)+'</dt><dd>'+h(v)+'</dd>').join('')+'</dl>'+
    action('下载原文件','asset-file')+action('校验原文件','asset-verify')+'<p data-check-file role="status"></p>')+
    (isImage ? link('以这张图开始处理','media/images/new/'+path(id)) : '') + (review?.html ?? ''));
  if (review) ctx.submit('source-review', review.save);
  ctx.click('asset-file',()=>downloadFile(ctx,endpoint+'/content',asset.name));
  ctx.click('asset-verify',async()=>{
    const response=await ctx.api(endpoint+'/content',{raw:true});
    const hash=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
    const digest=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
    if(ctx.active())document.querySelector('[data-check-file]').textContent=digest===asset.sha256?'校验通过，文件内容与登记摘要一致。':'校验失败，下载内容与登记摘要不一致。';
  });
}
