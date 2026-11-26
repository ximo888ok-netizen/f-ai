import { confirmDialog, h } from './live-ui.js';
import { studioIcon } from './studio-icons.js';

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
  layout.querySelector('[data-live-plan]').textContent = ctx.enterprise ? '企业工作区' : '个人工作区';
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

const dualModeConfigs = {
  image: {
    title: '图片创作要求',
    placeholder: '输入图片创意要求、核心卖点、构图光影或目标人群痛点，内容将实时同步至下方创作表单…',
    chips: [
      ['+ 实测数据对比', '增加权威实测数据与对比信息卡，突出核心转化卖点'],
      ['+ 液态微距光影', '强化高级磨砂玻璃微距光影与材质细节质感'],
      ['+ 主体保真锁定', '严格保持商品外观比例、标签文字与Logo完全保真不变形'],
      ['+ 平台规范留白', '遵循电商主图/详情页排版规范，保留清晰视觉焦点与合规留白'],
    ],
    steps: [
      ['素材包络校验', '已准备商品原图校验入口（建议短边 ≥1024px、单主体无遮挡、授权凭证有效），切换步骤已填内容完整保留不丢失。'],
      ['平台与视觉定调', '在左侧锁定目标平台（淘宝/拼多多/抖店）、文案语言与主图风格，确保整套画面色调与字体高度统一。'],
      ['勾选生成参数', '配置图片尺寸、画质档位与生成数量（单张/多张/套图），并可随时切回「对话提问交互」补充卖点文案。'],
      ['生成与PSD导出', '准备就绪！点击下方主按钮提交生成，成品支持高清下载并可直达「PSD 分层设计」继续精修。'],
    ],
  },
  video: {
    title: '视频创作要求',
    placeholder: '描述你想拍的镜头画面、运镜节奏、商品卖点或口播氛围，内容将实时同步至下方视频表单…',
    chips: [
      ['+ 3秒开场钩子', '前3秒用特写微距与动态光线快速抓人眼球，引出核心痛点'],
      ['+ 平稳推镜微距', '镜头缓慢平稳推近商品主体，突出表面纹理、光影反射与质感细节'],
      ['+ 卖点节奏字幕', '按镜号编排清晰卖点节奏，兼顾电商转化信息与画面呼吸感'],
      ['+ 丝滑光影转场', '采用柔和自然光影与焦点切换转场，保持商品外观连续一致'],
    ],
    steps: [
      ['素材与首帧准备', '添加商品首帧图或参考素材，支持文生视频、图生视频与参考视频多种模式，返回上一步已填内容不丢失。'],
      ['剧情与脚本定调', '通过自然语言填写创作提示词，或使用「智能编导 / 智能快创」生成可逐镜微调的分镜脚本。'],
      ['画幅与时长参数', '配置目标视频模型、画幅比例（9:16 / 1:1 / 16:9）与成片时长，精准把控平台投放规格。'],
      ['生成与成片导出', '核对脚本与积分预估后即可提交渲染，成片支持在线播放预览及带 AI 标识的 MP4 导出。'],
    ],
  },
};

export function dualModePanel(kind) {
  const cfg = dualModeConfigs[kind] ?? dualModeConfigs.image;
  const savedMode = (() => {
    try { return sessionStorage.getItem('fai.studio.dualMode.' + kind) || 'flow'; } catch { return 'flow'; }
  })();
  const isFlow = savedMode !== 'chat';
  return '<section class="card dual-workflow-panel" data-dual-workflow="' + h(kind) + '" aria-label="' + h(cfg.title) + '">' +
    '<div class="dual-panel-head"><div class="dual-panel-title"><h3>' + h(cfg.title) + '</h3>' +
    '<span class="dual-mode-tag">双模式可视化工作流</span></div>' +
    '<div class="dual-mode-seg" role="group" aria-label="交互模式切换">' +
    '<button type="button" class="dual-seg-btn' + (isFlow ? '' : ' active') + '" data-dual-mode="chat" aria-pressed="' + (!isFlow) + '">对话提问交互</button>' +
    '<button type="button" class="dual-seg-btn' + (isFlow ? ' active' : '') + '" data-dual-mode="flow" aria-pressed="' + isFlow + '">分步工作流</button>' +
    '</div></div>' +
    '<div class="dual-chat-box" data-dual-panel="chat"' + (isFlow ? ' hidden' : '') + '>' +
    '<textarea class="dual-chat-textarea" data-dual-prompt rows="2" maxlength="1000" placeholder="' + h(cfg.placeholder) + '"></textarea>' +
    '<div class="dual-chat-foot"><div class="dual-chips">' +
    cfg.chips.map(([label, text]) => '<button type="button" class="dual-chip" data-dual-chip="' + h(text) + '">' + h(label) + '</button>').join('') +
    '</div><div class="dual-chat-actions"><span class="dual-sync-status" data-dual-status role="status"></span>' +
    '<button type="button" class="smallbtn dual-apply-btn" data-dual-apply>同步到下方表单</button></div></div></div>' +
    '<div class="dual-stepper" data-dual-panel="flow"' + (isFlow ? '' : ' hidden') + '>' +
    '<div class="dual-steps-track" role="tablist" aria-label="分步工作流步骤">' +
    cfg.steps.map(([label], i) => '<button type="button" class="dual-step-node' + (i === 0 ? ' active' : '') + '" data-dual-step="' + (i + 1) + '" aria-current="' + (i === 0 ? 'step' : 'false') + '"><span class="dual-step-num">' + (i + 1) + '</span><span>' + h(label) + '</span></button>').join('') +
    '</div><div class="dual-step-body"><div class="dual-step-desc" data-dual-step-desc><strong>步骤 1/4：</strong>' + h(cfg.steps[0][1]) + '</div>' +
    '<div class="dual-step-actions"><button type="button" class="smallbtn" data-dual-prev disabled>上一步</button>' +
    '<button type="button" class="primary" data-dual-next>下一步 →</button></div></div></div></section>';
}

export function bindDualModePanel(scope, kind) {
  const panel = scope?.querySelector('[data-dual-workflow="' + kind + '"]');
  const cfg = dualModeConfigs[kind] ?? dualModeConfigs.image;
  if (!panel || panel.dataset.dualBound) return;
  panel.dataset.dualBound = '1';
  const promptInput = panel.querySelector('[data-dual-prompt]');
  const statusEl = panel.querySelector('[data-dual-status]');
  const stepDesc = panel.querySelector('[data-dual-step-desc]');
  const prevBtn = panel.querySelector('[data-dual-prev]');
  const nextBtn = panel.querySelector('[data-dual-next]');
  const stepBtns = [...panel.querySelectorAll('[data-dual-step]')];
  const modeBtns = [...panel.querySelectorAll('[data-dual-mode]')];
  let currentStep = 1;

  function findTargetField() {
    return scope.querySelector('.quick-image-form textarea[name="prompt"], .quick-image-form textarea[name="notes"], .video-composer textarea[name="prompt"], .video-quick-form textarea[name="notes"]');
  }

  function syncToForm(notify = false) {
    const target = findTargetField();
    const val = promptInput.value.trim();
    if (target && val) {
      target.value = val.slice(0, target.maxLength > 0 ? target.maxLength : 4000);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      if (notify) statusEl.textContent = '已同步至创作表单';
    } else if (notify) {
      statusEl.textContent = val ? '已记录当前要求' : '请先输入创作要求或点击快捷标签';
    }
  }

  const initialField = findTargetField();
  if (initialField?.value?.trim()) promptInput.value = initialField.value.trim();

  function setMode(mode) {
    try { sessionStorage.setItem('fai.studio.dualMode.' + kind, mode); } catch {}
    const isFlow = mode === 'flow';
    for (const btn of modeBtns) {
      const active = btn.dataset.dualMode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    panel.querySelector('[data-dual-panel="chat"]').hidden = isFlow;
    panel.querySelector('[data-dual-panel="flow"]').hidden = !isFlow;
  }

  function setStep(next) {
    currentStep = Math.max(1, Math.min(cfg.steps.length, next));
    stepBtns.forEach((btn, idx) => {
      const num = idx + 1;
      btn.classList.toggle('active', num === currentStep);
      btn.classList.toggle('done', num < currentStep);
      btn.setAttribute('aria-current', num === currentStep ? 'step' : 'false');
    });
    stepDesc.innerHTML = '<strong>步骤 ' + currentStep + '/' + cfg.steps.length + '：</strong>' + h(cfg.steps[currentStep - 1][1]);
    prevBtn.disabled = currentStep === 1;
    nextBtn.textContent = currentStep === cfg.steps.length ? '前往生成 →' : '下一步 →';
  }

  modeBtns.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.dualMode)));
  stepBtns.forEach(btn => btn.addEventListener('click', () => setStep(Number(btn.dataset.dualStep))));
  prevBtn.addEventListener('click', () => setStep(currentStep - 1));
  nextBtn.addEventListener('click', () => {
    if (currentStep < cfg.steps.length) {
      setStep(currentStep + 1);
      return;
    }
    const submitBtn = scope.querySelector('.quick-image-form button[type="submit"], .video-composer button[type="submit"], .video-quick-form button[type="submit"]');
    if (submitBtn) {
      submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!submitBtn.disabled) submitBtn.focus();
    }
  });
  promptInput.addEventListener('input', () => { statusEl.textContent = ''; syncToForm(false); });
  panel.querySelector('[data-dual-apply]').addEventListener('click', () => syncToForm(true));
  for (const chip of panel.querySelectorAll('[data-dual-chip]')) {
    chip.addEventListener('click', () => {
      const snippet = chip.dataset.dualChip;
      if (!promptInput.value.includes(snippet)) {
        promptInput.value = [promptInput.value.trim(), snippet].filter(Boolean).join('；');
      }
      syncToForm(true);
      promptInput.focus();
    });
  }
}
