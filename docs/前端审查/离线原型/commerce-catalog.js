/* A route may open an existing plugin capability or a dedicated local review page. */
const deskGroups = [
 ['goods','商品生产','photo',[
  ['bundle','整套商品资料','创建主图、SKU、详情和属性清单','package'],
  ['variant','多方案派生','同一商品按不同展示主题编排','package'],
  ['duplicate','复用商品档案','从已有档案创建独立副本','package'],
  ['mainimg','商品主视觉','按平台和画幅设定商品主图','image','商品主图'],
  ['skuimg','多规格商品图','组织同款商品的多个 SKU','image','SKU批量生成'],
  ['detailimg','长图详情页','为详情页安排连续的商品信息','image','详情页长图'],
  ['retouch','局部精修','调整指定区域的商品图','image','局部重绘'],
  ['facts','商品信息提炼','整理事实、特征和待核验卖点','brief']
 ]],
 ['films','视频制作','film',[
  ['inspire','案例选片','按品类选择参考视觉','gallery'],
  ['quickfilm','商品快创','从商品图进入短片工作流','video','图片转视频'],
  ['direct','分镜导演','分镜头编辑画面说明与节奏','video','可编辑脚本分镜与提示词'],
  ['promptfilm','提示词成片','用创作说明编排影片','video','智能成片'],
  ['structure','参考片结构','按参考片安排镜头与转场','video','爆款结构复刻'],
  ['replace','替换视频主体','指定参考商品和替换对象','video','产品替换'],
  ['analyze','镜头与脚本拆解','逐镜登记时长、画面和旁白','sequence'],
  ['enhance','视频清晰度','设置画幅与细节修复目标','brief'],
  ['speech','文案配音','编辑文稿、语速和声音风格','brief'],
  ['canvas','流程画板','连接素材、分析和输出步骤','board']
 ]],
 ['talent','数字人与声音','shirt',[
  ['talk','虚拟形象讲解','选择有授权的形象并编辑口播稿','brief'],
  ['talkmix','虚拟形象套剪','用讲解片段串联商品镜头','sequence'],
  ['talkcustom','虚拟形象分场','逐场安排讲解和商品特写','sequence'],
  ['profiles','形象与音色档案','管理授权范围和素材引用','brief']
 ]],
 ['cut','剪辑编排','layout',[
  ['livecut','真人讲解套剪','交替编排人物和商品素材','sequence'],
  ['livetimeline','真人讲解时间线','设置每段入点、时长和说明','sequence'],
  ['materialcut','商品素材套剪','使用开场、细节、收尾结构','sequence'],
  ['customcut','自由素材分场','手动增加、排序和调整镜头','sequence'],
  ['news','资讯短片','以标题、事实、来源组成资讯片','sequence']
 ]],
 ['business','店铺经营','store',[
  ['roi','投放收益测算','按售价、成本和广告费试算','calc'],
  ['mentor','运营顾问','整理选品、投放和店铺咨询提纲','brief'],
  ['cloud','店铺云工作区','核对授权店铺与计划执行的操作','brief'],
  ['publish','商品发布确认','确认目标平台和商品变更','ops','自动上架发布'],
  ['promotion','推广与归因','记录渠道、活动及归因口径','brief']
 ]],
 ['warehouse','商品与资产','folder',[
  ['products','商品档案','查看、编辑和导出商品包','stock'],
  ['categories','分类管理','添加分类并整理商品档案','stock'],
  ['imports','导入历史','校验并导入本地商品包','stock'],
  ['exports','导出历史','查看本次会话的数据包记录','stock'],
  ['saved','我的收藏','快速回到收藏的工具','favorites'],
  ['history','制作记录','查看方案记录与生成演练','history']
 ]]
];
const toolIcons={bundle:'folder',variant:'grid',duplicate:'layout',mainimg:'photo',skuimg:'palette',detailimg:'layout',retouch:'brush',facts:'spark',roi:'grid',profiles:'folder',speech:'film',canvas:'layout'};
const deskIndex = new Map();
for(const [group,groupName,icon,items] of deskGroups){
 for(const [id,name,desc,kind,cap] of items)deskIndex.set(id,{id,name,desc,kind,cap,group,groupName,icon:toolIcons[id]||icon});
}
const deskState = {
 group:'goods', expanded:null, hero:0, collapsed:false, favorites:new Set(), savedScenes:new Set(), inventory:[], cats:['未分类','数码','箱包','服饰','食品'],
 transfers:[],jobs:[],drafts:new Map(),edit:null,stockFilter:'全部', sequence:0,
 roi:{price:'100',cost:'35',shipping:'5',rate:'5',ad:'20',units:'100'},
 board:[{type:'素材',name:'商品原图',parent:null}]
};
const briefFields={
 facts:['商品事实','产地、材质、尺寸和使用场景','核验重点','商品标签、说明书或检测文件','商品事实核验清单'],
 enhance:['素材名称','待处理视频文件名','处理目标','目标分辨率、降噪及纹理保留要求','画质处理参数'],
 speech:['配音稿','请输入待配音的文案','声音设定','语速、停顿和音色','配音制作单'],
 talk:['口播稿','填写已核对的商品介绍','授权形象','填写形象档案名称与使用范围','口播制作单'],
 profiles:['档案名称','输入自有或已授权形象名称','授权用途','素材来源、授权范围、到期日期','形象与音色授权卡'],
 mentor:['经营问题','明确咨询目标与已知现状','已有数据','填写销量、库存或投放观察','运营咨询提纲'],
 cloud:['店铺别名','填写计划操作的测试店铺','任务范围','要处理的商品、操作、审批人','云端作业审批单'],
 promotion:['活动名称','填写一个推广活动','渠道及归因规则','如渠道、统计周期与订单归属','推广活动草案']
};
const deskPage=id=>'desk-'+id;
const entryByPage=p=>p.startsWith('desk-')?deskIndex.get(p.slice(5)):undefined;
function deskAvailable(item){
 const owner={goods:'image',films:'video',talent:'video',cut:'video',business:'ops'};
 return !state.disabled.has(item.cap?item.kind:owner[item.group]);
}
function deskButton(id,label,css='plain'){
 return '<button class="'+css+'" data-desk="'+id+'">'+safe(label)+'</button>';
}
function deskOpen(id){
 const item=deskIndex.get(id);
 if(!item||!deskAvailable(item)){toast('对应插件已停用');return}
 deskState.group=item.group;deskState.expanded=item.group;
 if(item.cap){openTask(item.kind,item.cap,null);return}
 go(deskPage(id));
}
function getDeskDraft(id){
 if(!deskState.drafts.has(id))deskState.drafts.set(id,{name:'',content:'',extra:'',category:'未分类',base:'',steps:null,confirmed:false});
 return deskState.drafts.get(id);
}
function saveDeskJob(item,name,data){
 const job={id:++deskState.sequence,tool:item.id,title:name,when:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),data:structuredClone(data)};
 deskState.jobs.unshift(job);return job;
}
function favorAction(id){
 const yes=deskState.favorites.has(id);return '<button class="fav" data-favorite="'+id+'" aria-pressed="'+yes+'" aria-label="'+(yes?'取消收藏':'收藏')+safe(deskIndex.get(id).name)+'">'+(yes?'★':'☆')+'</button>';
}

