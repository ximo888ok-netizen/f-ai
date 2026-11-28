import { confirmDialog } from './live-ui.js';
import { action, field, form, h, input, select } from './live-ui.js';
import { toast } from './live.js';
import { studioIcon } from './studio-icons.js';

export const platformNames={taobao:'淘宝 / 天猫',doudian:'抖店',douyin:'抖店',pinduoduo:'拼多多',jd:'京东',kuaishou:'快手小店',xiaohongshu:'小红书',weixin_store:'微信小店',oceanengine:'巨量引擎',youzan:'有赞'};
const portals={taobao:'https://myseller.taobao.com/',pinduoduo:'https://mms.pinduoduo.com/',doudian:'https://fxg.jinritemai.com/',douyin:'https://fxg.jinritemai.com/',jd:'https://shop.jd.com/',kuaishou:'https://s.kwaixiaodian.com/',xiaohongshu:'https://ark.xiaohongshu.com/',weixin_store:'https://store.weixin.qq.com/',oceanengine:'https://business.oceanengine.com/',youzan:'https://www.youzan.com/'};
const inboxUrls={pinduoduo:'https://mms.pinduoduo.com/chat-merchant/index.html',douyin:'https://im.jinritemai.com/pc_seller_v2/',doudian:'https://im.jinritemai.com/pc_seller_v2/'};
export const portalLink=(platform,label='登录商家后台',inbox=false)=>{
  const url=(inbox && inboxUrls[platform]) || portals[platform];
  return url?'<a class="shop-external" target="_blank" rel="noopener noreferrer" href="'+url+'">'+h(label)+studioIcon('outward')+'</a>':'';
};
export const storesFor=ctx=>ctx.manager?ctx.api('/v1/desk-shops'):Promise.resolve({items:[],taobaoOAuth:false});
export function rememberedShop(ctx,items) {
  const id=sessionStorage.getItem('desk-shop:'+ctx.workspace.id);
  return items.some(s=>s.id===id && s.enabled)?id:'';
}
export function rememberShop(ctx,id) { sessionStorage.setItem('desk-shop:'+ctx.workspace.id,id); }
const stateLabel=(s,kind)=>!s.enabled?'已停用':s[kind]?(kind==='customer'?'已绑定资料库':'已配置授权'):s.expiresAt && new Date(s.expiresAt)<=new Date()?'授权已到期':kind==='customer'?'未绑定资料库':'待接入授权';

export function shopPane(ctx,directory,kind) {
  const owner=ctx.workspace.role==='owner';
  const platforms=kind==='customer'?['pinduoduo','doudian','taobao']:Object.keys(platformNames).filter(k=>k!=='douyin');
  const records=directory.items.map(s=>{
    const canAuth=owner && s.source==='managed' && s.platform==='taobao' && s.enabled && directory.taobaoOAuth;
    return '<article class="shop-record"><span class="scene-tile-icon">'+studioIcon('desk')+'</span><div><strong>'+h(s.name)+'</strong><small>'+h(platformNames[s.platform])+' · '+h(stateLabel(s,kind))+'</small></div>'+
      '<div class="shop-record-tools">'+portalLink(s.platform)+(canAuth?action(s.granted?'重新授权':'授权经营数据','shop-auth',s.id):'')+'</div>'+
      (owner && s.source==='managed'?'<details><summary>管理店铺</summary>'+form('shop-edit-'+s.id,field('店铺名称',input('name','required maxlength="100" value="'+h(s.name)+'"'))+
      field('使用状态',select('enabled',[['yes','启用'],['no','停用并清除本地经营授权']],s.enabled?'yes':'no')),'保存店铺')+'</details>':
      s.source==='configured'&&ctx.enterprise?'<a href="/merchant#connections">管理部署连接</a>':'')+'</article>';
  }).join('');
  const setup=kind==='customer'?'店铺档案可用于分配工作台会话。读取平台历史消息需绑定该店在 Customer-Agent 中的资料库。':
    '店铺档案用于归集业务。在线经营查询需有效的平台授权。';
  return '<div class="shop-layout"><section class="scene-sheet"><header class="scene-panel-title">'+studioIcon('desk')+'<h2>我的店铺</h2><small>'+directory.items.length+' 家</small></header>'+
    (records||'<div class="scene-void">'+studioIcon('desk')+'<h3>还没有店铺档案</h3><p>'+h(owner?'添加第一家店铺，开始管理接待与经营数据。':'工作区所有者可以添加店铺。')+'</p></div>')+'</section>'+
    '<section class="scene-sheet"><header class="scene-panel-title">'+studioIcon('connections')+'<h2>登录与接入</h2></header>'+
    (owner?form('shop-add',field('所属平台',select('platform',platforms.map(p=>[p,platformNames[p]])))+
      '<div data-platform-login></div>'+field('店铺名称',input('name','required maxlength="100" placeholder="输入门店的常用名称"'))+'<p class="scene-hint">'+setup+'</p>','添加店铺'):
      '<p>'+setup+'</p>')+'<p class="scene-hint" data-shop-auth-note></p></section></div>';
}

export function bindShopPane(ctx,directory) {
  const box=document.querySelector('[data-form="shop-add"]');
  if (box) {
    const field=box.elements.platform, note=document.querySelector('[data-shop-auth-note]');
    const refresh=()=>{
      box.querySelector('[data-platform-login]').innerHTML=portalLink(field.value,'前往'+platformNames[field.value]+'登录');
      note.textContent=field.value==='taobao'?(directory.taobaoOAuth?'添加档案后可发起淘宝官方授权。':'本部署尚未配置淘宝授权应用。登录商家后台后，仍需接入店铺授权。'):
        '平台登录在官方页面完成。接入数据时，请由部署方为本工作区配置对应店铺连接。';
    };
    field.onchange=refresh; refresh();
    ctx.submit('shop-add',async data=>{
      const s=await ctx.api('/v1/desk-shops',{method:'POST',body:Object.fromEntries(data)});
      rememberShop(ctx,s.id); toast('店铺档案已添加');ctx.reload();
    });
  }
  for (const s of directory.items) {
    if(s.source!=='managed') continue;
    ctx.submit('shop-edit-'+s.id,async data=>{
      const enabled=data.get('enabled')==='yes';
      if(s.granted && !enabled && !await confirmDialog('确认操作', '停用后将清除工作台保存的经营授权。继续停用？'))return;
      await ctx.api('/v1/desk-shops/'+s.id,{method:'PATCH',body:{name:data.get('name'),enabled,revision:s.revision}});
      toast('店铺信息已保存');ctx.reload();
    });
  }
  ctx.click('shop-auth',async id=>{
    const result=await ctx.api('/v1/desk-shops/'+encodeURIComponent(id)+'/authorize',{method:'POST'});
    const auth=new URL(result.url);
    if(auth.origin!=='https://oauth.taobao.com') throw new Error('无法打开授权地址。');
    location.assign(auth.href);
  });
}
