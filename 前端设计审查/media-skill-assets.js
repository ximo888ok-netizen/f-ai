import {field,h,input,select} from './live-ui.js';
import {describeError} from './studio-errors.js';

export function skillAssetFields(spec){
  return '<fieldset class="skill-assets"><legend>输入素材</legend><p>'+h(spec.min===0?'可选素材':'至少 '+spec.min+' 份素材')+' · 最多 '+spec.max+' 份 · 每份 10 MiB</p>'+
    (spec.native?'<p>第一张为首帧，第二张为尾帧。</p>':spec.source==='aidge'?'<p>先选模特图，再选服装图。</p>':spec.needsMovie&&spec.needsImage?'<p>同时提供参考视频和自己的商品图。</p>':'')+
    '<div data-asset-select></div><ol data-asset-order></ol>'+
    '<details class="scene-fold"><summary>上传到素材库</summary>'+field('选择文件',input('upload','type="file" multiple accept="'+h(spec.types.join(','))+'"'))+
    (spec.consent?field('素材使用授权凭证',input('consent','maxlength="200"'))+field('授权到期时间',input('expires','type="datetime-local"')):'')+
    '<button type="button" data-upload-files>上传所选文件</button></details><p role="status" data-asset-status></p></fieldset>';
}
const readBase64=file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('读取文件失败。'));r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(file);});
export function bindSkillAssets(ctx,box,spec,assets,onChange,initial=[]){
  const ids=initial.filter(id=>assets.some(a=>a.id===id&&eligible(a))).slice(0,spec.max),status=box.querySelector('[data-asset-status]'),order=box.querySelector('[data-asset-order]');
  let busy=false;
  function eligible(a){return spec.types.includes(a.mediaType)&&(!spec.consent||(a.consentReference && Date.parse(a.consentExpiresAt)>Date.now()));}
  function draw(){
    const choices=assets.filter(a=>eligible(a)&&!ids.includes(a.id));
    box.querySelector('[data-asset-select]').innerHTML=select('library',[['','从素材库选择…'],...choices.map(a=>[a.id,a.name])],'','aria-label="从素材库添加"'+(ids.length>=spec.max?' disabled':''));
    order.innerHTML=ids.map((id,i)=>'<li><span>'+h(assets.find(s=>s.id===id)?.name)+'</span><button type="button" data-up="'+i+'" aria-label="上移第 '+(i+1)+' 份素材"'+(!i?' disabled':'')+'>↑</button><button type="button" data-remove="'+i+'" aria-label="移除第 '+(i+1)+' 份素材">移除</button></li>').join('');
    onChange();
  }
  box.onchange=e=>{if(e.target.name==='library'&&e.target.value && ids.length<spec.max){ids.push(e.target.value);draw();}};
  order.onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-up')){const i=Number(b.dataset.up);[ids[i],ids[i-1]]=[ids[i-1],ids[i]];}else ids.splice(Number(b.dataset.remove),1);draw();};
  box.querySelector('[data-upload-files]').onclick=async e=>{
    if(busy)return;
    const files=Array.from(box.querySelector('[name=upload]').files);
    if(!files.length){status.textContent='请先选择文件。';return;}
    if(files.length+ids.length>spec.max || files.some(f=>!spec.types.includes(f.type)||f.size>10*1024**2||!f.size)){status.textContent='请检查文件数量、类型与大小。';return;}
    let grant={};
    if(spec.consent){
      const ref=box.querySelector('[name=consent]').value.trim(),expires=Date.parse(box.querySelector('[name=expires]').value);
      if(!ref||!(expires>Date.now())){status.textContent='请填写有效授权凭证和未来的到期时间。';return;}
      grant={consentReference:ref,consentExpiresAt:new Date(expires).toISOString()};
    }
    busy=true;const btn=e.currentTarget;btn.disabled=true;
    try{
      for(const f of files){
        const dataBase64=await readBase64(f);if(!ctx.active()||!box.isConnected)return;
        const a=await ctx.api('/v1/assets',{method:'POST',body:{name:f.name,mediaType:f.type,purpose:spec.id,source:'工作台技能上传',dataBase64,...grant}});
        assets.unshift(a);if(!ctx.active()||!box.isConnected)return;ids.push(a.id);draw();
      }
      box.querySelector('[name=upload]').value='';status.textContent='已上传并加入输入素材。';
    }catch(err){if(ctx.active())status.textContent=describeError(err);}finally{busy=false;btn.disabled=false;onChange();}
  };
  draw();
  return {values:()=>[...ids],valid:()=>{
    const used=assets.filter(a=>ids.includes(a.id));
    return !busy && ids.length>=spec.min && ids.length<=spec.max && used.reduce((n,a)=>n+a.sizeBytes,0)<=20*1024**2 &&
      (!spec.needsMovie||used.some(a=>a.mediaType==='video/mp4'))&&(!spec.needsImage||used.some(a=>a.mediaType.startsWith('image/')));
  }};
}
