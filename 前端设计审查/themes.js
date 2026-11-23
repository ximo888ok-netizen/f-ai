/* Apply the saved palette before the first paint. Mode and palette are independent. */
(() => {
  const palettes = {
    glass: ['冰蓝玻璃', '冰蓝 · 紫光'], paper: ['暖白纸笺', '暖白 · 朱砂'],
    jade: ['雨后青玉', '松绿 · 玉石'], noir: ['曜石鎏金', '炭黑 · 香槟'],
    tide: ['海盐青蓝', '海蓝 · 薄荷'], rose: ['玫瑰石英', '灰粉 · 莓红'],
    amber: ['琥珀晚霞', '蜜橙 · 赤铜']
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
  const legacyMode = id => id === 'paper' ? 'light' : 'dark';
  const linkedPalette = Object.hasOwn(palettes, params.get('theme'));
  let palette = linkedPalette ? params.get('theme') : cached.studioTheme;
  if (!Object.hasOwn(palettes, palette)) palette = 'glass';
  let mode = params.get('mode') ?? (linkedPalette ? null : cached.theme);
  if (!Object.hasOwn(modes, mode)) mode = legacyMode(palette);
  let modeMotion;
  const scheme = display => display === 'system' ? (systemDark.matches ? 'dark' : 'light') : display;

  function paint() {
    root.dataset.theme = palette;
    root.dataset.scheme = scheme(mode);
    const [name] = palettes[palette];
    document.querySelectorAll('[data-theme-open]').forEach(button => {
      button.title = '切换主题 · ' + name + ' · ' + modes[mode];
      button.setAttribute('aria-label', button.title);
      button.querySelector('span').textContent = name;
    });
    for (const radio of document.querySelectorAll('#themeDialog input[type=radio]')) {
      radio.checked = radio.value === (radio.name === 'faiAppearance' ? palette : mode);
    }
    if (typeof StudioGlass !== 'undefined') StudioGlass.schedule();
  }

  function setAppearance(id, display = legacyMode(id), remember = false, animate = false) {
    if (!Object.hasOwn(palettes, id) || !Object.hasOwn(modes, display)) return;
    const previous = mode, previousScheme = root.dataset.scheme;
    palette = id;
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
    document.body.append(dialog);
    modeMotion = window.bindStudioModeMotion?.(dialog);
    dialog.querySelector('.themeClose').onclick = () => dialog.close();
    dialog.addEventListener('change', event => {
      const { name, value } = event.target;
      if (name !== 'faiAppearance' && name !== 'faiColorMode') return;
      setAppearance(name === 'faiAppearance' ? value : palette, name === 'faiColorMode' ? value : mode, true, name === 'faiColorMode');
      document.dispatchEvent(new CustomEvent('studio-theme', { detail: { studioTheme: palette, theme: mode } }));
    });
    for (const button of document.querySelectorAll('[data-theme-open]')) button.onclick = () => {
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
    document.addEventListener('click', event => {
      const anchor = event.target.closest('a[href*=".html"]');
      if (!anchor) return;
      const url = new URL(anchor.href);
      if (!['打开设计稿.html', '前端详细设计.html', '立体工作台交互预览.html'].includes(decodeURIComponent(url.pathname.split('/').pop()))) return;
      url.searchParams.set('theme', palette);
      url.searchParams.set('mode', mode);
      anchor.href = url.href;
    }, true);
    paint();
  });
})();
