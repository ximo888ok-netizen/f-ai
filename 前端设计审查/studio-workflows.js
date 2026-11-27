import { confirmDialog, h } from './live-ui.js';
import { studioIcon } from './studio-icons.js';
export { dualModePanel, bindDualModePanel } from './studio-dual-mode.js';

export const deskSections = {
  image: { label: '图片生成' },
  'customer-service': { label: 'AI客服', links: [['快捷话术', 'customer/replies'], ['查看知识库', 'resources']] },
  operations: { label: 'AI运营', links: [['查看店铺', 'shops'], ['运营台账', 'commerce'], ['商品档案', 'products'], ['投放收益测算', 'roi']] },
  video: { label: '视频生成' },
  copywriting: { label: '电商文案', links: [['创作文案', 'create/copywriting']] },
};

export function productionSection(route, args) {
  if (route === 'desk') return Object.hasOwn(deskSections, args[0]) ? args[0] : 'image';
  if (route === 'create' && Object.hasOwn(deskSections, args[0])) return args[0];
  if (['shops', 'products', 'roi', 'drafts', 'commerce'].includes(route)) return 'operations';
  if (route === 'customer') return 'customer-service';
  if (['copy-review', 'copy-drafts'].includes(route)) return 'copywriting';
  if (['psd', 'image-plans'].includes(route) || (route === 'media' && args[0] === 'images')) return 'image';
  if (route === 'media' && ['storyboards', 'video'].includes(args[0])) return 'video';
  return '';
}

const spaces = {
  customer: ['AI 客服','根据买家问题和店铺资料拟写回复，在接待会话中核对并发送。','service'],
  operations: ['AI 运营','汇总经营日报、查询授权店铺，在台账中跟进业务记录。','operations'],
  copywriting: ['电商文案','从商品资料生成平台文案，发布前校验标题和卖点。','copywriting'],
};

// The three fixed-size materials are painted once per session, outside the form layout.
const sculptureCache = new Map();
function paintSculpture(canvas, kind) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (sculptureCache.has(kind)) { ctx.drawImage(sculptureCache.get(kind),0,0); return; }
  const { width, height } = canvas;
  const tau = 2 * Math.PI, faces = [];
  const hue = {customer:216,operations:168,copywriting:259}[kind];
  function point(u,v) {
    let x,y,z;
    if (kind === 'customer') {
      const tube = .37 + .055 * Math.cos(u * 38);
      const radius = .83 + tube * Math.cos(v);
      x = radius * Math.cos(u); y = radius * Math.sin(u); z = tube * Math.sin(v) + .17 * Math.sin(u*2);
    } else if (kind === 'operations') {
      const a = u + .52 * Math.sin(v), edge = .79 + .09 * Math.cos(v * 32);
      const radius = edge * Math.pow(Math.max(0,Math.cos(v)), .28);
      x = radius * Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)),.58);
      y = radius * Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)),.58);
      z = .83 * Math.sin(v);
    } else {
      const r = .72 + .10*Math.cos(u*28 - 2*v);
      x = (r + .40 * Math.cos(v)) * Math.cos(u);
      y = (r + .40 * Math.cos(v)) * Math.sin(u);
      z = .26*Math.sin(v) + .39*Math.sin(2*u+.45);
    }
    const pitch = kind === 'operations' ? .94 : .82;
    const tilt = kind === 'copywriting' ? -.42 : -.24;
    const b = y*Math.cos(pitch)-z*Math.sin(pitch);
    return [x*Math.cos(tilt)-b*Math.sin(tilt),x*Math.sin(tilt)+b*Math.cos(tilt),y*Math.sin(pitch)+z*Math.cos(pitch)];
  }
  const rows = kind === 'operations' ? 96 : 28, columns = kind === 'operations' ? 48 : 160;
  const rings = Array.from({length:rows+1}, (_,j) => Array.from({length:columns+1}, (_,i) =>
    point(i/columns*tau,kind === 'operations' ? (j/rows-.5)*Math.PI : j/rows*tau)));
  for (let j=0;j<rows;j++) for (let i=0;i<columns;i++) {
    const a=rings[j][i], b=rings[j][i+1], c=rings[j+1][i+1], d=rings[j+1][i];
    const dx=b[0]-a[0], dy=b[1]-a[1], dz=b[2]-a[2], ex=d[0]-a[0], ey=d[1]-a[1], ez=d[2]-a[2];
    const nz=dx*ey-dy*ex;
    if (nz<=0) continue;
    const nx=dy*ez-dz*ey, ny=dz*ex-dx*ez, length=Math.hypot(nx,ny,nz);
    const light=(-.46*nx-.7*ny+.54*nz)/length;
    const sheen=.5+.5*Math.sin((nx*.67+ny*.45+nz*.36)/length*7);
    const luminosity=25+33*Math.max(0,light)+30*sheen+9*Math.pow(Math.max(0,light),8);
    faces.push({vertices:[a,b,c,d], depth:(a[2]+b[2]+c[2]+d[2])/4, color:'hsl('+hue+' 29% '+luminosity+'%)'});
  }
  faces.sort((a,b)=>a.depth-b.depth);
  const scale=height*.545;
  for (const {vertices,color} of faces) {
    ctx.beginPath();
    vertices.forEach(([x,y],i)=>ctx[i?'lineTo':'moveTo'](width*.50+x*scale,height*.52+y*scale));
    ctx.closePath(); ctx.fillStyle=color; ctx.strokeStyle=color; ctx.lineWidth=.7; ctx.fill(); ctx.stroke();
  }
  const cached = document.createElement('canvas'); cached.width=width; cached.height=height;
  cached.getContext('2d').drawImage(canvas,0,0); sculptureCache.set(kind,cached);
}

export function sceneDesk(ctx, kind, sections, initial, actions = '') {
  const [title,description] = spaces[kind];
  const key = ctx.workspace.id + ':' + location.hash;
  const saved = history.state?.sceneDesk;
  let current = saved?.key === key && sections.some(s=>s.id===saved.tab) ? saved.tab : initial;
  const tabId = id => 'scene-' + kind + '-' + id;
  ctx.html('<section class="scene-desk" data-scene-kind="'+kind+'"><header class="scene-header">' +
    '<div class="scene-heading">' +
    '<h1>'+h(title)+'</h1><p>'+h(description)+'</p></div><div class="scene-art" aria-hidden="true"><canvas width="590" height="330"></canvas></div></header>'+
    '<div class="scene-toolbar"><div role="tablist" aria-label="'+h(title)+'工具">'+sections.map(s=>
      '<button type="button" role="tab" id="'+tabId(s.id)+'-tab" aria-controls="'+tabId(s.id)+'" aria-selected="'+(s.id===current)+'" tabindex="'+(s.id===current?0:-1)+'">'+studioIcon(s.icon)+h(s.label)+
      (s.count!=null?'<span class="scene-tab-count">'+h(s.count)+'</span>':'')+'</button>').join('')+'</div>'+
    (actions?'<nav aria-label="相关工具">'+actions+'</nav>':'')+'</div>'+
    sections.map(s=>'<div class="scene-page" role="tabpanel" id="'+tabId(s.id)+'" aria-labelledby="'+tabId(s.id)+'-tab"'+(s.id===current?'':' hidden')+'>'+s.body+'</div>').join('')+'</section>');
  const root = document.querySelector('.scene-desk');
  if (!ctx.active() || !root) return;
  paintSculpture(root.querySelector('canvas'),kind);
  const tabs = [...root.querySelectorAll('[role=tab]')];
  function activate(index, focus) {
    current = sections[index].id;
    for (const [i, tab] of tabs.entries()) {
      const selected=i===index;
      tab.setAttribute('aria-selected',String(selected)); tab.tabIndex=selected?0:-1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden=!selected;
    }
    history.replaceState({...history.state,sceneDesk:{key,tab:current}},'');
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab,i)=>{
    tab.onclick=()=>activate(i,false);
    tab.onkeydown=e=>{
      const keys={ArrowRight:(i+1)%tabs.length,ArrowLeft:(i+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1};
      if (Object.hasOwn(keys,e.key)) { e.preventDefault(); activate(keys[e.key],true); }
    };
  });
}

export async function commerceHome(ctx) {
  const [catalog, policies] = await Promise.all([ctx.api('/v1/plugins'),
    ctx.enterprise && ctx.manager ? ctx.api('/v1/merchant/features') : null]);
  if (!ctx.active()) return;
  const layout = document.querySelector('#native-directory-template').content.firstElementChild.cloneNode(true);
  const plugins = new Map(catalog.items.map(plugin => [plugin.id, plugin]));
  const features = new Map(policies?.items.map(policy => [policy.id, policy]) ?? []);
  const working = catalog.items.filter(plugin => plugin.enabled).length;
  layout.querySelector('[data-live-plan]').textContent = ctx.enterprise ? '企业工作区' : ctx.workspace.kind === 'agent' ? '代理工作区' : '个人工作区';
  layout.querySelector('#enabledPluginCount').textContent = working + ' / ' + plugins.size;
  layout.querySelector('#pluginStatus').textContent = working + ' 个已启用';
  const cards = Array.from(layout.querySelectorAll('[data-scene]'));
  for (const card of cards) {
    const id = card.dataset.scene;
    const plugin = plugins.get(id), policy = features.get(id);
    if (!plugin) { card.remove(); continue; }
    const button = card.querySelector('[data-switch-scene]');
    const status = policy?.enabled ?? plugin.enabled;
    button.setAttribute('aria-checked',String(status));
    button.disabled = !ctx.manager;
    card.querySelector('[data-scene-count]').textContent = plugin.capabilities.length + ' 项能力';
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const enabled = !status;
      if (!enabled && !(await confirmDialog('停用场景插件', '停用「' + plugin.name + '」将阻止提交该插件的新任务。继续？'))) return;
      button.disabled = true;
      try {
        if (policy) {
          const { mode, version, revision, memberIds } = policy;
          await ctx.api('/v1/merchant/features/' + encodeURIComponent(id), { method: 'PUT', body: { enabled, mode, version, revision, memberIds } });
        } else {
          await ctx.api('/v1/plugins/' + encodeURIComponent(id) + '/state', { method: 'PUT', body: { enabled } });
        }
        if (ctx.active()) ctx.reload();
      } catch (error) {
        if (ctx.active()) { layout.querySelector('[data-directory-status]').textContent = error.message; button.disabled = !ctx.manager; }
      }
    });
  }
  const status = document.createElement('p');
  status.dataset.directoryStatus = '';
  status.setAttribute('role','status');
  layout.append(status);
  const library = layout.querySelector('.slot');
  layout.querySelector('#workbenchSearch').addEventListener('input', event => {
    const term = event.target.value.trim().toLowerCase();
    let matches = 0;
    for (const card of cards) {
      const plugin = plugins.get(card.dataset.scene);
      if (!plugin) continue;
      const words = [card.dataset.pluginName, ...plugin.capabilities.map(c => c.name)].join(' ').toLowerCase();
      card.hidden = !words.includes(term);
      if (!card.hidden) matches++;
    }
    library.hidden = !!term;
    status.textContent = matches ? '' : '没有匹配的插件或能力。';
  });
  const business = document.querySelector('.business-root');
  business.before(layout);
  business.hidden = true;
  ctx.signal.addEventListener('abort', () => { layout.remove(); business.hidden = false; }, { once: true });
}
