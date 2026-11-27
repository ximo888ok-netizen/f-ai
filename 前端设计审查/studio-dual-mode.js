import { h } from './live-ui.js';
import { bindVideoSteps } from './live-video-steps.js';

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
      ['素材与首帧准备', '选择生成方式与素材。'],
      ['剧情与脚本定调', '填写创作要求或编辑脚本。'],
      ['画幅与时长参数', '选择模型和成片参数。'],
      ['生成与成片导出', '核对设置与任务费用。'],
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
  const video = kind === 'video' && bindVideoSteps(scope, panel, nextBtn);
  let currentStep = 1;

  function findTargetField() {
    return scope.querySelector('.quick-image-form textarea[name="prompt"], .quick-image-form textarea[name="notes"], .video-composer textarea[name="prompt"], .video-quick-form textarea[name="notes"], [data-skill-run] textarea[name="prompt"]');
  }

  function syncToForm(notify = false) {
    const target = findTargetField();
    const val = promptInput.value.trim();
    if (target && val) {
      target.value = val.slice(0, target.maxLength > 0 ? target.maxLength : 4000);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      if (notify) statusEl.textContent = '已同步至创作表单';
    } else if (notify) {
      statusEl.textContent = val ? '当前工具无需填写创作要求。' : '请先输入创作要求或点击快捷标签';
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
      btn.classList.toggle('done', !video && num < currentStep);
      btn.setAttribute('aria-current', num === currentStep ? 'step' : 'false');
    });
    stepDesc.innerHTML = '<strong>步骤 ' + currentStep + '/' + cfg.steps.length + '：</strong>' + h(cfg.steps[currentStep - 1][1]);
    prevBtn.disabled = currentStep === 1;
    nextBtn.textContent = currentStep === cfg.steps.length ? '前往生成 →' : '下一步 →';
    video?.render?.(currentStep);
  }

  modeBtns.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.dualMode)));
  stepBtns.forEach(btn => btn.addEventListener('click', () => setStep(Number(btn.dataset.dualStep))));
  prevBtn.addEventListener('click', () => setStep(currentStep - 1));
  nextBtn.addEventListener('click', () => {
    if (currentStep < cfg.steps.length) {
      setStep(currentStep + 1);
      return;
    }
    if (video) { video.submit(); return; }
    const submitBtn = scope.querySelector('.quick-image-form button[type="submit"], .video-composer button[type="submit"], .video-quick-form button[type="submit"], [data-skill-run] button[type="submit"]');
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
