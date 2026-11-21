import { field, form, h, heading, input, link, notice, panel, path, select, toast } from './live.js';
import { downloadFile } from './live-files.js';
import { imageStudio } from './live-image-studio.js';
import { assetField, mediaRatios, toggleFields } from './live-media-controls.js';
import { storyboards } from './live-storyboards.js';

const pages={images:'图片处理',video:'视频导出',storyboards:'视频分镜'};

export async function mediaPage(ctx) {
  const [page,id,source]=ctx.args;
  const selected=Object.hasOwn(pages,page)?page:'images';
  const navigation='<nav class="live-row" aria-label="媒体处理功能">'+
    Object.entries(pages).map(([name,title])=>name===selected
      ? '<strong aria-current="page">'+h(title)+'</strong>':link(title,'media/'+name)).join('')+'</nav>';
  if (selected==='storyboards') return storyboards(ctx,id,navigation);
  if (selected==='video') return videoExport(ctx,id,navigation);
  return imageStudio(ctx,id==='new'?null:id,id==='new'?source:null,navigation);
}

async function videoExport(ctx,id,navigation) {
  const [files,status]=await Promise.all([ctx.all('/v1/assets'),ctx.api('/v1/video-export/status')]);
  const videos=files.filter(file=>file.mediaType==='video/mp4');
  let controls=notice('请先在素材库上传 MP4 视频。');
  if (!status.available) controls=notice('当前部署未启用视频处理。');
  else if (videos.length) {
    controls=form('video-export',assetField('源视频','assetId',videos,id,true,'选择 MP4') +
      field('导出格式',select('format',[['mp4','MP4 视频'],['png','PNG 抽帧'],['jpg','JPG 抽帧'],['mp3','MP3 音轨']],'mp4')) +
      '<div data-video-ratio>'+field('导出画幅',select('ratio',[['original','原始画幅'],...mediaRatios],'original'))+'</div>' +
      '<div data-video-audio>'+field('音轨','<select name="keepAudio"><option value="true">保留音轨</option>'+
        '<option value="false">静音</option></select>')+'</div>' +
      '<div data-video-frame>'+field('抽帧时间（秒）',input('frameSeconds','type="number" min="0" max="59.999" step="0.001" value="0" required'))+'</div>' +
      field('这段上传的视频由 AI 生成',input('aiGenerated','type="checkbox"')),'导出并下载');
  }
  ctx.html(heading('视频导出')+navigation+link('打开素材库','assets')+panel('导出参数',controls));
  if (!ctx.active()) return;
  const node=document.querySelector('[data-form=video-export]');
  if (!node) return;
  const refresh=()=>{
    const format=node.elements.format.value;
    toggleFields(node,'[data-video-ratio]',format!=='mp3');
    toggleFields(node,'[data-video-audio]',format==='mp4');
    toggleFields(node,'[data-video-frame]',format==='png' || format==='jpg');
  };
  refresh();
  ctx.on('[data-form=video-export] [name=format]','change',refresh);
  ctx.submit('video-export',async data=>{
    const assetId=data.get('assetId');
    const format=data.get('format');
    const body={format};
    if (format!=='mp3') body.ratio=data.get('ratio');
    if (format==='mp4') body.keepAudio=data.get('keepAudio')==='true';
    if (format==='png' || format==='jpg') body.frameMs=Math.round(Number(data.get('frameSeconds'))*1000);
    if (data.has('aiGenerated')) body.aiGenerated=true;
    toast('正在处理视频');
    await downloadFile(ctx,'/v1/media/videos/'+path(assetId)+'/export','video-'+assetId+'.'+format,{method:'POST',body});
  });
}
