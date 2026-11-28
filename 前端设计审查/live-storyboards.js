import { confirmDialog } from './live-ui.js';
import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, result, select, textarea, toast, uid } from './live.js';
import { downloadFile } from './live-files.js';
import { assetField, editRows, imageFiles, mediaRatios, rowControls } from './live-media-controls.js';

const root='/v1/media/storyboards';
const templates=[['product-showcase','商品展示'],['feature-details','细节与卖点'],['steps','使用步骤']];
const empty={ratio:'16:9',template:'product-showcase',shots:[{durationMs:1500}],audioAssetId:null};

function shotFields(files,shot={durationMs:1500}) {
  return '<fieldset data-edit-row><legend>镜头</legend>' +
    assetField('镜头图片','assetId',files,shot.assetId,true,'选择图片') +
    field('时长（秒）',input('duration','type="number" min="0.5" max="10" step="0.001" required value="'+h(shot.durationMs/1000)+'"')) +
    field('字幕（选填）',input('caption','maxlength="120" value="'+h(shot.caption)+'"')) +
    field('镜头提示词（选填）',textarea('prompt','maxlength="600"',shot.prompt)) +
    rowControls('移除镜头',true)+'</fieldset>';
}

function readShot(row) {
  const value=name=>row.elements.namedItem(name).value;
  return {assetId:value('assetId'),durationMs:Math.round(Number(value('duration'))*1000),
    caption:value('caption').trim(),prompt:value('prompt').trim()};
}

export async function storyboards(ctx,id,navigation,deskRoute) {
  const route = deskRoute ?? 'media/storyboards';
  const listRoute = deskRoute ? route + '/storyboards' : route;
  const title = deskRoute ? value => '<h3>'+h(value)+'</h3>' : heading;
  if (!id) {
    const entries=await ctx.all(root);
    ctx.html(title('视频分镜')+navigation+link('新建视频分镜',route+'/new')+
      panel('我的分镜',list(entries,entry=>item(entry.title,
        entry.configuration.shots.length+' 个镜头 · '+date(entry.updatedAt),link('编辑分镜',route+'/'+entry.id)))));
    return;
  }
  const [fileList,entry,status]=await Promise.all([
    ctx.all('/v1/assets'),
    id==='new'?{id:uid(),revision:0,title:'',configuration:empty}:ctx.api(root+'/'+path(id)),
    ctx.api('/v1/video-export/status'),
  ]);
  const images=imageFiles(fileList);
  const audio=fileList.filter(file=>file.mediaType==='audio/mpeg');
  const {ratio,template,shots,audioAssetId}=entry.configuration;
  const target=root+'/'+path(entry.id);
  const editor=images.length?form('storyboard-save',
    field('分镜名称',input('title','required maxlength="120" value="'+h(entry.title)+'"')) +
    field('画幅',select('ratio',mediaRatios,ratio)) +
    field('模板',select('template',templates,template)) +
    assetField('背景音轨','audioAssetId',audio,audioAssetId) +
    '<div class="live-fields" data-edit-rows>'+shots.map(shot=>shotFields(images,shot)).join('')+'</div>' +
    '<button type="button" class="plain" data-row-command="add">添加镜头</button>','保存分镜') :
    notice('请先上传 PNG 或 JPEG 图片。');
  const saved=entry.revision?panel('已保存版本',
    notice('版本 '+entry.revision+' · '+date(entry.updatedAt)) +
    action('查看提示词','storyboard-prompts')+
    (status.available?action('合成并下载 MP4','storyboard-export'):notice('当前部署未启用视频合成。')) +
    action('删除分镜','storyboard-delete')+'<div data-story-prompts aria-live="polite"></div>'):'';
  ctx.html(title(entry.title || '新建视频分镜') + navigation +
    '<div class="live-row">'+link('返回分镜列表',listRoute)+link('打开素材库','assets')+'</div>' +
    grid(panel('分镜编辑',editor),saved));
  if (!ctx.active()) return;
  const formNode=document.querySelector('[data-form=storyboard-save]');
  if (formNode) editRows(formNode,()=>shotFields(images),12,{update:(row,index)=>{
    row.querySelector('legend').textContent='镜头 '+(index+1);
  }});
  ctx.submit('storyboard-save',async (data,node)=>{
    const shots=[...node.querySelectorAll('[data-edit-row]')].map(readShot);
    const updated=await ctx.api(target,{method:'PUT',body:{
      revision:entry.revision,title:data.get('title').trim(),ratio:data.get('ratio'),template:data.get('template'),
      audioAssetId:data.get('audioAssetId') || null,shots,
    }});
    toast('分镜已保存');
    ctx.go(route+'/'+updated.id);
  });
  ctx.click('storyboard-prompts',async ()=>{
    const response=await ctx.api(target+'/prompts');
    if (ctx.active()) document.querySelector('[data-story-prompts]').innerHTML=list(response.items,
      shot=>item('镜头 '+(shot.position+1),shot.durationMs/1000+' 秒',result(shot.prompt)));
  });
  ctx.click('storyboard-export',async ()=>{
    toast('正在合成已保存的分镜');
    await downloadFile(ctx,target+'/export','storyboard-'+entry.id+'.mp4',{method:'POST',body:{revision:entry.revision}});
  });
  ctx.click('storyboard-delete',async ()=>{
    if (!await confirmDialog('确认操作', '删掉这份分镜？')) return;
    await ctx.api(target+'?revision='+entry.revision,{method:'DELETE'});
    ctx.go(listRoute);
  });
}
