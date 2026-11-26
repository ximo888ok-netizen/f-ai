import { field,h,input,link,path,select,textarea,uid } from './live-ui.js';
import { skillAssetFields,bindSkillAssets } from './media-skill-assets.js';
import { skillResults } from './media-skill-output.js';
import { describeError } from './studio-errors.js';
import { downloadContent } from './live-text-delivery.js';

const states={local_ready:'本机脚本已就绪',configured:'已配置执行服务，授权以供应商响应为准',executor_required:'待配置技能执行服务',credentials_required:'待配置供应商授权',
  source_missing:'待安装固定版本的上游技能',python_required:'待配置 Python 运行环境',source_mismatch:'本机脚本版本不匹配',
  runtime_unavailable:'执行环境不可用',model_required:'待配置对应模型',disabled:'工作区已停用',service_required:'待配置服务端点或成品域名',planner_required:'待配置视觉策划模型'};
const vendors={commerce:'电商图片技能集',linkpix:'青虎 LinkPix',dlazy:'dlazy',suite:'Ecommerce Image Suite',fal:'fal',wan:'阿里万相',aidge:'阿里云 Aidge',byte:'字节 AgentKit',kling:'可灵',vidu:'Vidu',firered:'FireRed OpenStoryline',minimax:'MiniMax',pixverse:'PixVerse',runway:'Runway',ark:'火山方舟'};
const requirements={
  commerce:'生成使用 OpenAI 图片服务和视觉策划模型。',linkpix:'准备青虎账号授权和 qhkit 运行环境。',
  dlazy:'准备 dlazy CLI 和 DLAZY_API_KEY。',suite:'选择已开通的图片供应商及其模型密钥。',fal:'准备 fal 账号、genmedia 与视觉策划模型。',
  wan:'准备同地域的百炼 API Key 和万相模型。',aidge:'开通 Aidge 虚拟试穿并配置用于临时签名的 OSS 存储。',byte:'国内成片使用方舟 Endpoint，参考广告改编使用 BytePlus Endpoint 与视觉策划服务。',
  kling:'使用与可灵账号区域匹配的 CLI 登录环境，再配置有权限使用的模型。',vidu:'为当前工作区配置 Vidu Token 或专属 CLI 登录环境。',
  firered:'将工作区绑定到已部署的 OpenStoryline 服务。',minimax:'准备海螺模型权限、MiniMax CLI 和账号授权。',
  pixverse:'配置有 CLI 权限的 PixVerse 订阅账号。',runway:'连接该工作区的 Runway MCP 账号；使用参考素材时还需要临时素材存储。',ark:'配置已登录的 arkcli 及有权限使用的模型资源。'};
const drafts=new Map();

export async function mediaSkillDesk(ctx,plugin,wallet,preferred){
  const kind=plugin.id;
  const [directory,assets,recentTasks]=await Promise.all([ctx.api('/v1/media-skills/'+kind),ctx.all('/v1/assets'),ctx.api('/v1/tasks?limit=30')]);
  if(!ctx.active())return;
  const items=directory.items,allowed=new Map(plugin.capabilities.map(c=>[c.id,c.available]));
  const ready=s=>allowed.get(s.id)&&s.models.length>0;
  const sourceLabel=s=>states[s.state]||'暂不可用';
  const channels=[...new Set(items.flatMap(s=>s.channels))];
  let selected=items.find(s=>s.id===preferred)||items.find(ready)||items[0],channel=selected.channels[0],busy=false;
  ctx.html('<section class="media-skill-desk"><header><h2>'+h(kind==='image'?'商品图片技能':'商品视频技能')+'</h2><span>'+items.length+' 项 · '+items.filter(ready).length+' 项可运行</span></header>'+
    '<div class="skill-workspace"><aside><label>销售平台'+select('skill-platform',[['','全部平台'],...channels.map(v=>[v,v])])+'</label>'+
    field('查找技能',input('search','type="search" placeholder="输入技能名称或供应商"'))+'<label class="only-available"><input name="onlyReady" type="checkbox">只看可运行</label><div data-skill-list></div></aside>'+
    '<div data-skill-editor></div><section data-skill-delivery><h3>任务与成品</h3><div data-results></div></section></div></section>');
  const desk=document.querySelector('.media-skill-desk'),editor=desk.querySelector('[data-skill-editor]'),list=desk.querySelector('[data-skill-list]');
  const results=skillResults(ctx,desk.querySelector('[data-results]')),filter=desk.querySelector('[name=skill-platform]'),search=desk.querySelector('[name=search]');
  const recentById=new Map();
  for(const task of recentTasks.items)if(!recentById.has(task.capabilityId))recentById.set(task.capabilityId,task);
  function filterList(){
    const needle=search.value.trim().toLowerCase();
    const shown=items.filter(s=>(!desk.querySelector('[name=onlyReady]').checked||ready(s))&&(!filter.value||s.channels.includes(filter.value))&&[s.title,s.group,vendors[s.source],s.id].join(' ').toLowerCase().includes(needle)).sort((a,b)=>Number(ready(b))-Number(ready(a)));
    list.innerHTML=[...new Set(shown.map(s=>s.group))].map(group=>'<h4>'+h(group)+'</h4>'+shown.filter(s=>s.group===group).map(s=>
      '<button type="button" data-select="'+h(s.id)+'" aria-pressed="'+(s===selected)+'"><span>'+h(s.title)+'</span><small>'+h(ready(s)?'可用':sourceLabel(s))+'</small></button>').join('')).join('')||'<p>没有匹配的技能。</p>';
    return shown;
  }
  const key=()=>[ctx.workspace.id,ctx.account.id,selected.id].join('/');
  function render(){
    const s=selected, cached=drafts.get(key())??{}, available=ready(s);
    const mechanical=['white','stitch'].includes(s.local);
    channel=s.channels.includes(filter.value)?filter.value:s.channels.includes(cached.channel)?cached.channel:s.channels[0];
    editor.innerHTML='<header><h3>'+h(s.title)+'</h3><small>'+h(vendors[s.source])+' · '+h(sourceLabel(s))+'</small></header>'+
      '<form class="live-form" data-skill-run>'+field('交付平台',select('platform',s.channels.map(v=>[v,v]),channel))+
      (!s.native && !['white','stitch'].includes(s.local)?field('成品画幅',select('ratio',(s.local==='storyboard'?['9:16','16:9','1:1','4:3']:['1:1','3:4','4:3','9:16','16:9']).map(x=>[x,x]),cached.ratio??(kind==='video'?'9:16':'1:1'))):'')+
      (mechanical?input('prompt','type="hidden" maxlength="3000" value="'+h(s.title)+'"'):field(s.local==='storyboard'?'商品名称与已确认卖点':'商品资料与制作要求',textarea('prompt','required maxlength="'+(s.native?800:2800)+'" rows="4" placeholder="填写商品名称、真实卖点和本次交付要求"',cached.prompt??'')))+
      (s.alias==='image-linkpix-image-translate'?field('译图语言',select('language',['英语','西班牙语','法语','德语','日语','韩语','简体中文','繁体中文'].map(v=>[v,v]))):'')+
      (s.alias==='image-linkpix-clothing-recolor'?field('目标 SKU 颜色',input('color','required maxlength="60" placeholder="如雾灰色，可附品牌色值"')):'')+
      (s.slots?.length?'<fieldset class="skill-slots"><legend>本次交付图位</legend>'+s.slots.map(v=>'<label><input type="checkbox" name="slot" value="'+h(v)+'"'+((cached.slots??s.slots).includes(v)?' checked':'')+'>'+h(v)+'</label>').join('')+'</fieldset>':'')+
      (s.frameMode?field('素材用途',select('frameMode',[['frames','首帧 / 尾帧（最多两张）'],['references','商品参考图（最多九张）']])):'')+skillAssetFields(s)+(s.models.length>1?field('执行服务',select('model',s.models.map(m=>[m,m]))):'')+
      '<p class="scene-hint">每次 '+s.cost+' 工作台积分'+(s.local?' · 本机处理':' · 供应商或技能执行服务另行计费')+'</p><p role="status" data-run-status></p>'+
      '<div class="scene-related"><button type="submit" class="primary">运行技能</button><button type="button" data-brief>导出制作单</button></div></form>'+
      (s.usesPlanner?'<p class="scene-hint">通过技能执行服务制作时，视觉策划模型会读取商品图缩略图或参考片采样帧。</p>':'')+
      '<details class="scene-fold"><summary>来源与运行要求</summary><p>'+h(sourceLabel(s))+' · '+h(s.local?'原版 Python 脚本':s.native?'原生 API':'上游工作流适配')+' · '+h(s.installed?'技能文件已就位':s.native?'按模型配置调用':'待准备源码')+'</p>'+
      '<p>'+h(s.local?'在部署机准备固定版本的上游源码和 Python。':requirements[s.source])+'</p>'+
      '<a href="'+h(s.origin)+'" target="_blank" rel="noopener noreferrer">查看技能或接口原文 ↗</a></details>';
    const f=editor.querySelector('form'),status=f.querySelector('[data-run-status]'),submit=f.querySelector('[type=submit]');
    let inputs=null,lastRequest='',requestId='';
    const validInput=()=>inputs?.valid()&&f.elements.prompt.value.trim().length&&f.elements.prompt.value.length<=f.elements.prompt.maxLength&&(!s.slots?.length||f.querySelectorAll('[name=slot]:checked').length>=s.minOutputs)&&(!s.frameMode||f.elements.frameMode.value!=='frames'||inputs.values().length<=2);
    function sync(){
      const valid=validInput();
      submit.disabled=busy||!available||!valid||wallet.available<s.cost;
      status.textContent=!available?(s.state==='local_ready'||s.state==='configured'?'当前工作区不能运行此技能。':sourceLabel(s)+'。仍可整理素材并导出制作单。'):
        wallet.available<s.cost?'可用积分不足。':!valid?'请填写制作要求并按顺序选择所需素材。':'';
    }
    inputs=bindSkillAssets(ctx,f.querySelector('.skill-assets'),s,assets,sync,cached.assetIds);
    const parameters=()=>({prompt:[f.elements.prompt.value.trim(),f.elements.language?'目标语言：'+f.elements.language.value:'',f.elements.color?'目标颜色：'+f.elements.color.value.trim():''].filter(Boolean).join('\n'),platform:f.elements.platform.value,assetIds:inputs.values(),
      ...(s.slots?.length?{slots:[...f.querySelectorAll('[name=slot]:checked')].map(n=>n.value)}:{}),
      ...(s.frameMode?{frameMode:f.elements.frameMode.value}:{}),...(f.elements.ratio?{ratio:f.elements.ratio.value}:{})});
    f.oninput=()=>{const p=parameters();drafts.set(key(),{...p,prompt:f.elements.prompt.value,channel:p.platform});sync();};
    async function continueFrom(task,delivery){
      if(s.local!=='storyboard'||!task.result?.text)return;
      const use=document.createElement('button');use.type='button';use.textContent='编辑分镜并带入 Seedance 成片';delivery.append(use);
      use.onclick=async()=>{
        try{
          const origin=await ctx.api('/v1/tasks/'+path(task.id)+'/inputs');if(!ctx.active()||selected!==s)return;
          selected=items.find(item=>item.id==='video.skill-seedance-film');
          drafts.set(key(),{prompt:task.result.text,channel:origin.parameters.platform,ratio:origin.parameters.ratio,assetIds:origin.parameters.assetIds});
          history.replaceState(history.state,'','#desk/video/skills/'+selected.id);render();
        }catch(error){if(ctx.active())status.textContent=describeError(error);}
      };
    }
    f.querySelector('[data-brief]').onclick=()=>downloadContent(s.alias+'-制作单.json',JSON.stringify({skill:s.id,source:s.origin,revision:s.revision,parameters:parameters()},null,2),'application/json');
    f.onsubmit=async e=>{
      e.preventDefault();if(submit.disabled||busy)return;
      const payload={capabilityId:s.id,modelId:f.elements.model?.value??s.models[0],parameters:parameters(),mode:'workflow'};
      const rec=JSON.stringify(payload);
      if(lastRequest!==rec){requestId=uid();lastRequest=rec;}
      busy=true;submit.disabled=true;status.textContent='正在提交…';
      try{
        const t=await ctx.api('/v1/tasks',{method:'POST',body:{...payload,idempotencyKey:requestId}});if(!ctx.active())return;
        recentById.set(s.id,t);status.textContent='任务已提交。';const finished=await results.show(t,continueFrom);
        if(finished)lastRequest='';if(ctx.active())wallet.available=(await ctx.api('/v1/credits/wallet')).available;
      }catch(err){if(ctx.active())status.textContent=describeError(err);}
      finally{busy=false;submit.disabled=!available||!validInput()||wallet.available<s.cost;}
    };
    sync();filterList();results.clear();
    const t=recentById.get(s.id);if(t)void results.show(t,continueFrom);else desk.querySelector('[data-results]').innerHTML='<p>此技能暂无最近任务。</p>'+link('查看所有任务','tasks');
  }
  list.onclick=e=>{const btn=e.target.closest('[data-select]');if(!btn||busy)return;
    selected=items.find(s=>s.id===btn.dataset.select);
    history.replaceState(history.state,'','#desk/'+kind+'/skills/'+encodeURIComponent(selected.id));render();};
  filter.onchange=()=>{
    if(busy){filter.value='';return;}
    const shown=filterList();if(shown.length&&!shown.includes(selected)){selected=shown[0];render();}
    else if(filter.value&&selected.channels.includes(filter.value))editor.querySelector('[name=platform]').value=filter.value;
  };
  search.oninput=filterList;desk.querySelector('[name=onlyReady]').onchange=filter.onchange;render();
}
