import { link,path } from './live-ui.js';
import { downloadContent } from './live-text-delivery.js';
import { describeError } from './studio-errors.js';

export function skillResults(ctx,box) {
  let version=0;const urls=new Set();
  const clear=()=>{version++;for(const url of urls)URL.revokeObjectURL(url);urls.clear();box.replaceChildren();};
  ctx.signal.addEventListener('abort',clear,{once:true});
  async function show(task,after){
    clear();const token=version;
    const current=()=>ctx.active()&&version===token;
    box.innerHTML=link('查看任务记录','tasks/'+path(task.id))+'<p role="status" data-task-state></p><div data-delivery></div>';
    const status=box.querySelector('[data-task-state]'),delivery=box.querySelector('[data-delivery]');
    try{
      while(['queued','running'].includes(task.state)){
        if(!current())return;
        status.textContent=task.state==='queued'?'任务已排队。':'正在运行技能…';
        await new Promise(resolve=>setTimeout(resolve,1800));if(!current())return;
        task=await ctx.api('/v1/tasks/'+path(task.id));
      }
      if(!current())return;
      if(task.state!=='succeeded'){status.textContent='任务未完成 · '+(task.errorCode||task.state);return true;}
      status.textContent='任务已完成'; const r=task.result;
      if(r?.text){const pre=document.createElement('pre');pre.className='live-result';pre.textContent=r.text;delivery.append(pre);
        const copy=document.createElement('button');copy.type='button';copy.textContent='下载制作说明';copy.onclick=()=>downloadContent('制作说明-'+task.id+'.txt',r.text);delivery.append(copy);}
      for(const f of (r?.files??(r?.assetId?[r]:[]))){
        if(!current())return;
        const raw=await ctx.api('/v1/assets/'+path(f.assetId)+'/content',{raw:true});const blob=await raw.blob();if(!current())return;
        const url=URL.createObjectURL(blob);urls.add(url);appendMedia(delivery,url,f.mediaType,f.name||'技能成品','#assets/'+path(f.assetId));
      }
      if(!r?.assetId && !r?.files?.length && r?.url && /^https:\/\//i.test(r.url))appendMedia(delivery,r.url,r.type==='video'?'video/mp4':'image/png','打开供应商成品',false);
      if(current()&&after)after(task,delivery);
      return true;
    }catch(e){if(current())status.textContent='读取任务结果失败。'+describeError(e);}
  }
  return {show,clear};
}
function appendMedia(target,url,mime,label,assetRoute){
  const wrap=document.createElement('figure');
  const media=document.createElement(mime?.startsWith('video/')?'video':'img');
  if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';}else{media.alt=label;media.loading='lazy';}
  media.src=url; const a=document.createElement('a');a.href=assetRoute||url;a.textContent=label;
  if(!assetRoute){a.target='_blank';a.rel='noopener noreferrer';}
  wrap.append(media,a);target.append(wrap);
}
