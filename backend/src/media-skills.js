import { mediaSources } from './media-skill-sources.js';

export const shopChannels=['淘宝/天猫','拼多多','京东','抖音电商','小红书','亚马逊','速卖通','通用/其他'];
const domestic=shopChannels.slice(0,4);
const image='image',video='video', all=shopChannels;
const imageInput=['image/png','image/jpeg'], movie=['video/mp4'];

// An entry points to a skill file at an immutable revision, not an arbitrary URL from a request.
function skill(kind,slug,title,source,file,group,channels,config={}) {
  const id=kind+'.skill-'+slug, alias=kind+'-'+slug;
  return {id,alias,kind,title,source,file,group,channels,mediaTypes:imageInput,min:1,max:5,
    output:kind, minOutputs:1,consent:false,...config,
    origin:'https://github.com/'+mediaSources[source].repo+'/blob/'+mediaSources[source].revision+'/'+file};
}
const market=(slug,title,channels,group,config)=>skill(image,slug,title,'commerce','skills/'+slug+'/SKILL.md',group,channels,config);
const linkpix=(kind,slug,title,group,config)=>skill(kind,'linkpix-'+slug,title,'linkpix','skills/linkpix-'+slug+'/SKILL.md',group,all,config);
const byted=(slug,title,file,group,config)=>skill(video,slug,title,'byte','skills/'+file+'/SKILL.md',group,all,config);
const general=(kind,source,file,title,config={})=>skill(kind,source+'-generate',title,source,file,'生成与编辑',all,config);
export const mediaSkills=[
  market('ecommerce-listing-suite','平台商品套图',all,'套图与详情',{minOutputs:2,slots:['主图','卖点图','场景图','材质细节','尺寸说明','对比图','包装图']}),
  market('taobao-detail-long-image','详情页分屏与长图',['淘宝/天猫','拼多多'],'套图与详情',{minOutputs:2,slots:['首屏','商品卖点','材质细节','使用场景','规格参数']}),
  market('amazon-white-background','Amazon 白底主图',['亚马逊'],'主图与规格'),
  market('amazon-a-plus','Amazon A+ 模块',['亚马逊'],'套图与详情',{slots:['品牌横幅','核心卖点','场景模块','细节模块']}),
  market('xiaohongshu-cover','小红书种草封面',['小红书'],'主图与规格'),
  market('multi-angle-set','多角度展示',all,'套图与详情',{minOutputs:2}),
  market('lifestyle-scene','商品场景图',all,'主图与规格'),
  market('selling-point-infographic','卖点信息图',all,'主图与规格'),
  market('size-chart','尺寸说明图',all,'主图与规格'),
  market('sale-banner','活动横幅',all,'主图与规格'),
  market('model-try-on','模特试穿',all,'换装与修图',{min:2,consent:true}),
  market('batch-background-swap','批量更换背景',all,'换装与修图'),
  linkpix(image,'ecom-image','青虎商品视觉','套图与详情',{minOutputs:5}),
  linkpix(image,'main-image-set','青虎主图轮播','套图与详情',{minOutputs:5}),
  linkpix(image,'clothing-recolor','服饰 SKU 换色','换装与修图'),
  linkpix(image,'detail-page','商品详情图','套图与详情'),
  linkpix(image,'image-translate','多语言商品译图','主图与规格'),
  skill(image,'dlazy-item-detail','中文排版详情模块','dlazy','skills/item-detail/skill.md','套图与详情',all,{slots:['首屏','卖点','材质','细节','参数']}),
  skill(image,'product-suite','商品分析与套图','suite','SKILL.md','套图与详情',[...domestic,'亚马逊','通用/其他'],{max:3,minOutputs:2}),
  skill(image,'fal-product-photos','按 SKU 生成摄影组图','fal','skills/ecommerce-product-photography/SKILL.md','套图与详情',all,{minOutputs:2,slots:['商品主图','细节特写','生活场景']}),
  general(image,'wan','skills/wan2.7-image-skill/SKILL.md','万相图片生成与编辑',{min:0}),
  {...general(video,'wan','skills/wan2.7-image-skill/SKILL.md','万相首尾帧成片',{min:2,max:2,native:'wan-frames'}),
    origin:'https://help.aliyun.com/en/model-studio/legacy-image-to-video-by-first-and-last-frame-api-reference'},
  {...general(image,'wan','skills/wan2.7-image-skill/SKILL.md','阿里云 Aidge 虚拟试穿',{min:2,max:2,consent:true}),
    id:'image.skill-aidge-tryon',alias:'image-aidge-tryon',source:'aidge',file:'aidge/SKILL.md',group:'换装与修图',
    origin:'https://help.aliyun.com/zh/aidge/api-aidge-2026-04-28-virtualtryon'},
  general(image,'ark','skills/arkcli-gen/SKILL.md','方舟 Seedream 生成与编辑',{min:0}),
  general(image,'kling','SKILL.md','可灵参考图与主体',{min:0}),
  general(image,'vidu','SKILL.md','Vidu 参考图生成',{min:0}),
  general(image,'pixverse','skills/SKILL.md','PixVerse 图片与模板',{min:0}),
  general(image,'minimax','skills/minimax-multimodal-toolkit/SKILL.md','MiniMax 商品图',{min:0}),
  general(image,'runway','skills/runway-media/SKILL.md','Runway 图片编辑',{min:0}),
  byted('product-storyboard','商品分镜提示词','byted-ind-ecom-product-video-prompt','分镜策划',{min:1,output:'text',local:'storyboard'}),
  byted('seedance-film','Seedance 商品展示片','byted-ind-ecom-prompt-to-video','商品成片',{min:0,max:9,alsoNative:'ark-video'}),
  byted('ad-rewrite','参考广告改编','byted-bp-seedance-viral-creative-rewrite-skill','参考与剪辑',{min:2,mediaTypes:[...imageInput,...movie],needsMovie:true,needsImage:true,consent:true}),
  linkpix(video,'ad-film','青虎商品广告片','商品成片'),
  general(video,'ark','skills/arkcli-gen/SKILL.md','方舟视频生成与编辑',{min:0}),
  general(video,'minimax','skills/minimax-multimodal-toolkit/SKILL.md','海螺首尾帧成片',{min:0,max:2}),
  general(video,'kling','SKILL.md','可灵主体与动作参考',{mediaTypes:[...imageInput,...movie],consent:true}),
  general(video,'vidu','SKILL.md','Vidu 多参考与首尾帧',{max:9,mediaTypes:[...imageInput,...movie]}),
  general(video,'pixverse','skills/SKILL.md','PixVerse 转场与特效',{min:0,mediaTypes:[...imageInput,...movie]}),
  general(video,'runway','skills/runway-media/SKILL.md','Runway 视频制作',{min:0,mediaTypes:[...imageInput,...movie]}),
  skill(video,'openstoryline','FireRed 实拍素材剪辑','firered','.claude/skills/openstoryline-use/SKILL.md','参考与剪辑',all,{mediaTypes:movie,needsMovie:true,max:10}),
  market('amazon-white-background','白底主图检查与修正',['亚马逊'],'本地交付',{id:'image.skill-white-check',alias:'image-white-check',local:'white',max:1}),
  market('taobao-detail-long-image','拼接已选详情分屏',all,'本地交付',{id:'image.skill-stitch',alias:'image-stitch',local:'stitch',min:2,max:10}),
];
