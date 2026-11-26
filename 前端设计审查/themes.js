/* Apply the saved palette before the first paint. Mode and palette are independent. */
(() => {
  const palettes = {
    glass: ['银白 · 黑曜', '柔光银白 · 深邃黑曜'],
    noir: ['雾灰玻璃', '建筑岩灰 · 冷雾银']
  };
  const modes = { light: '浅色模式', dark: '深色模式', system: '跟随系统' };
  const key = 'fai.studio.appearance.v2';
  const root = document.documentElement;
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const params = new URLSearchParams(location.search);
  let cached = {};
  try {
    cached = JSON.parse(localStorage.getItem(key)) ?? { studioTheme: localStorage.getItem('fai.studio.theme.v1') };
  } catch { /* Storage may be unavailable in an offline preview. */ }
  const defaultMode = id => id === 'glass' ? 'light' : 'dark';
  const presets = { black: ['glass', 'dark', '黑'], gray: ['noir', 'dark', '灰'], white: ['glass', 'light', '白'] };
  const legacyThemes = new Set(['paper', 'jade', 'tide', 'rose', 'amber']);
  const normalizePalette = id => Object.hasOwn(palettes, id) ? id : (legacyThemes.has(id) ? 'glass' : null);
  const linkedPalette = normalizePalette(params.get('theme'));
  let palette = linkedPalette ?? normalizePalette(cached.studioTheme) ?? 'glass';
  let mode = params.get('mode') ?? (linkedPalette ? null : cached.theme);
  if (!Object.hasOwn(modes, mode)) mode = defaultMode(palette);
  let modeMotion;
  const scheme = display => display === 'system' ? (systemDark.matches ? 'dark' : 'light') : display;

  function paint() {
    root.dataset.theme = palette;
    root.dataset.scheme = scheme(mode);
    root.dataset.material = root.dataset.scheme === 'light' ? 'white' : palette === 'noir' ? 'gray' : 'dark';
    const surface = document.querySelector('.business-root');
    if (surface) { surface.dataset.scheme = root.dataset.scheme; surface.dataset.theme = palette; }
    const [name] = palettes[palette];
    document.querySelectorAll('[data-theme-open]').forEach(button => {
      button.title = '切换主题 · ' + name + ' · ' + modes[mode];
      button.setAttribute('aria-label', button.title);
      if (!button.hasAttribute('data-fixed-label')) button.querySelector('span').textContent = '材质';
    });
    for (const button of document.querySelectorAll('[data-glass-preset]')) {
      const [id, display] = presets[button.dataset.glassPreset];
      const selected = id === palette && display === root.dataset.scheme;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('active', selected);
    }
    for (const radio of document.querySelectorAll('#themeDialog input[type=radio]')) {
      radio.checked = radio.value === (radio.name === 'faiAppearance' ? palette : mode);
    }
    if (typeof StudioGlass !== 'undefined') StudioGlass.schedule();
  }

  function setAppearance(id, display = defaultMode(id), remember = false, animate = false) {
    const resolved = normalizePalette(id);
    if (!resolved || !Object.hasOwn(modes, display)) return;
    const previous = mode, previousScheme = root.dataset.scheme;
    palette = resolved;
    mode = display;
    if (remember) {
      try { localStorage.setItem(key, JSON.stringify({ studioTheme: palette, theme: mode, scope: root.dataset.workspaceAppearance })); } catch {}
      if (params.has('theme') || params.has('mode') || location.protocol === 'file:') {
        const url = new URL(location.href);
        url.searchParams.set('theme', palette);
        url.searchParams.set('mode', mode);
        try { history.replaceState(history.state, '', url); } catch {}
      }
    }
    if (animate && modeMotion && previous !== mode) modeMotion.play(previous, mode, previousScheme, scheme(mode), paint);
    else { modeMotion?.finish(); paint(); }
  }
  window.applyStudioTheme = setAppearance;
  paint();
  systemDark.addEventListener('change', () => { if (mode === 'system') { modeMotion?.finish(); paint(); } });

  document.addEventListener('DOMContentLoaded', () => {
    for (const group of document.querySelectorAll('.glass-presets,.head-themes,.mat-theme')) {
      if (!group.querySelector('[data-glass-preset]')) group.innerHTML = Object.entries(presets).map(([id, [, , label]]) =>
        '<button type="button" data-glass-preset="' + id + '" aria-label="' + label + '色玻璃"><i aria-hidden="true"></i>' + label + '</button>').join('');
      group.addEventListener('click', event => {
        const choice = event.target.closest('[data-glass-preset]');
        if (!choice) return;
        const [id, display] = presets[choice.dataset.glassPreset];
        setAppearance(id, display, true);
        document.dispatchEvent(new CustomEvent('studio-theme', { detail: { studioTheme: id, theme: display } }));
      });
    }
    const dialog = document.createElement('dialog');
    dialog.id = 'themeDialog';
    dialog.className = 'ui-dialog';
    dialog.setAttribute('aria-labelledby', 'themeTitle');
    const choices = Object.entries(palettes).map(([id, [name, detail]]) =>
      '<label class="themeChoice"><input type="radio" name="faiAppearance" value="' + id +
      '"><span class="themeDemo" data-chip="' + id + '" aria-hidden="true"><i></i><b></b><em></em></span><span class="themeMeta"><strong>' +
      name + '</strong><small>' + detail + '</small></span><span class="themeCheck" aria-hidden="true">✓</span></label>').join('');
    const brightness = Object.entries(modes).map(([id, name]) =>
      '<label><input type="radio" name="faiColorMode" value="' + id + '"><span>' + name + '</span></label>').join('');
    dialog.innerHTML = '<header class="ui-dialog-header"><h2 id="themeTitle">外观主题</h2><button class="ui-icon-button themeClose" type="button" aria-label="关闭主题选择">×</button></header>' +
      '<div class="ui-dialog-body"><fieldset class="appearanceModes"><legend>显示模式</legend><div>' + brightness +
      '</div></fieldset><fieldset class="themeGrid"><legend>主题配色</legend>' + choices + '</fieldset></div>' +
      '<form class="ui-dialog-footer" method="dialog"><button class="primary">完成</button></form>';
    dialog.querySelector('#themeTitle').textContent = '玻璃材质与外观';
    const options = [
      ['flow-speed', '流动速度', 0, 2.5, .1, 1, '×'],
      ['frost-radius', '模糊半径', 0, 40, 1, 24, 'px'],
      ['frost-opacity', '玻璃浓度', .15, .88, .01, .5, ''],
      ['frost-saturation', '背景饱和度', 100, 220, 1, 165, '%'],
    ];
    const material = document.createElement('fieldset');
    material.className = 'material-tuning';
    material.innerHTML = '<legend>玻璃材质</legend>' + options.map(([id, label, min, max, step, initial]) =>
      '<label>' + label + '<output for="' + id + '"></output><input id="' + id + '" type="range" min="' + min +
      '" max="' + max + '" step="' + step + '" value="' + initial + '"></label>').join('') +
      '<label class="material-shadow"><input type="checkbox" checked>标题微阴影</label>' +
      '<div><button type="button" class="smallbtn" data-reset-material>重置材质</button> <button type="button" class="smallbtn" data-motion-toggle><span>暂停动效</span></button></div>';
    dialog.querySelector('.appearanceModes').after(material);
    let settings = {};
    try { settings = JSON.parse(localStorage.getItem('fai.glass.material.v1')) || {}; } catch {}
    const shadow = material.querySelector('[type=checkbox]');
    const inspector = document.getElementById('material-overlay');
    const nativeIds = { 'flow-speed': 'mat-speed','frost-radius':'mat-blur','frost-opacity':'mat-alpha','frost-saturation':'mat-sat' };
    const nativeVars = { 'frost-radius':'--blur','frost-opacity':'--alpha','frost-saturation':'--sat' };
    function applyMaterial() {
      for (const [id, , min, max, , initial, unit] of options) {
        const input = material.querySelector('#' + id);
        const value = settings[id];
        input.value = Number.isFinite(value) && value >= min && value <= max ? value : initial;
        material.querySelector('output[for="' + id + '"]').value = input.value + unit;
        const cssValue = input.value + (unit === '×' ? '' : unit);
        root.style.setProperty('--' + id, cssValue);
        if (nativeVars[id]) root.style.setProperty(nativeVars[id],cssValue);
        if (inspector) {
          const native = inspector.querySelector('#' + nativeIds[id]);
          native.value = input.value;
          inspector.querySelector('output[for="' + native.id + '"]').value = input.value + unit;
        }
      }
      shadow.checked = settings.shadow !== false;
      root.toggleAttribute('data-type-shadow', shadow.checked);
      root.dataset.shadow = shadow.checked ? 'on' : 'off';
      if (inspector) inspector.querySelector('#mat-shadow').checked = shadow.checked;
      document.dispatchEvent(new Event('studio-material'));
    }
    function saveMaterial() {
      applyMaterial();
      try { localStorage.setItem('fai.glass.material.v1', JSON.stringify(settings)); } catch {}
    }
    material.addEventListener('input', event => {
      if (event.target === shadow) settings.shadow = shadow.checked;
      else settings[event.target.id] = event.target.valueAsNumber;
      saveMaterial();
    });
    material.querySelector('[data-reset-material]').onclick = () => { settings = {}; saveMaterial(); };
    applyMaterial();
    document.body.append(dialog);
    modeMotion = window.bindStudioModeMotion?.(dialog);
    dialog.querySelector('.themeClose').onclick = () => dialog.close();
    dialog.addEventListener('change', event => {
      const { name, value } = event.target;
      if (name !== 'faiAppearance' && name !== 'faiColorMode') return;
      const animate = name === 'faiColorMode' && !event.target.matches(':focus-visible');
      setAppearance(name === 'faiAppearance' ? value : palette, name === 'faiColorMode' ? value : mode, true, animate);
      document.dispatchEvent(new CustomEvent('studio-theme', { detail: { studioTheme: palette, theme: mode } }));
    });
    if (inspector) {
      inspector.addEventListener('toggle', () => inspector.classList.toggle('open', inspector.matches(':popover-open')));
      inspector.addEventListener('input', event => {
        const key = Object.keys(nativeIds).find(id => nativeIds[id] === event.target.id);
        if (key) settings[key] = event.target.valueAsNumber;
        else if (event.target.id === 'mat-shadow') settings.shadow = event.target.checked;
        saveMaterial();
      });
      inspector.querySelector('[data-native-reset]').onclick = () => { settings = {}; saveMaterial(); };
      inspector.querySelector('[data-more-appearance]').onclick = () => { inspector.hidePopover(); dialog.showModal(); };
    }
    for (const button of document.querySelectorAll('[data-theme-open]')) button.onclick = () => {
      if (inspector) { inspector.togglePopover(); return; }
      dialog.showModal();
      dialog.querySelector('input:checked')?.focus({ preventScroll: true });
    };
    window.addEventListener('storage', event => {
      if (event.key !== key || !event.newValue) return;
      try {
        const saved = JSON.parse(event.newValue);
        if (root.dataset.workspaceAppearance && root.dataset.workspaceAppearance !== saved.scope) return;
        setAppearance(saved.studioTheme, saved.theme);
      } catch {}
    });
    paint();
  });
})();
