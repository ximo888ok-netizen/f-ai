/* The sun and moon share a small grid. Only the travelling glass draws it. */
(() => {
  const duration = 520;
  function dots(scheme) {
    const points = [];
    for (let y = -5; y <= 5; y++) {
      for (let x = -5; x <= 5; x++) {
        const radius = Math.hypot(x, y);
        const sun = radius <= 2.6 || (radius >= 4 && radius <= 5 && (x === 0 || y === 0 || Math.abs(x) === Math.abs(y)));
        const moon = (radius <= 4.6 && Math.hypot(x - 2, y + 2) > 4) || (x === 3 && y === -4);
        if (scheme === 'light' ? sun : moon) points.push([x, y]);
      }
    }
    return points;
  }
  const light = dots('light'), dark = dots('dark');
  function drawGlyph(context, from, to, phase) {
    const start = from === 'light' ? light : dark;
    const end = to === 'light' ? light : dark;
    const count = Math.max(start.length, end.length);
    const t = phase * phase * (3 - 2 * phase);
    const scatter = from === to ? 0 : 2.8 * Math.sin(t * Math.PI);
    const warmth = to === from ? Number(to === 'light') : to === 'light' ? t : 1 - t;
    context.clearRect(0, 0, 40, 40);
    context.fillStyle = 'rgb(' + [225 - 128 * warmth, 231 - 167 * warmth, 255 - 225 * warmth].join(' ') + ')';
    for (let i = 0; i < count; i++) {
      const a = start[Math.floor(i * start.length / count)], b = end[Math.floor(i * end.length / count)];
      const x = a[0] + (b[0] - a[0]) * t + Math.cos(i * 2.4) * scatter;
      const y = a[1] + (b[1] - a[1]) * t + Math.sin(i * 2.4) * scatter;
      context.fillRect(19 + x * 2.65, 19 + y * 2.65, 2.1, 2.1);
    }
  }

  window.bindStudioModeMotion = dialog => {
    const root = document.documentElement;
    const track = dialog.querySelector('.appearanceModes > div');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const contrast = matchMedia('(forced-colors: active)');
    let active;
    const finish = () => active?.finish();
    function play(previous, next, fromScheme, toScheme, paint) {
      const label = value => track.querySelector('input[value="' + value + '"]').parentElement.getBoundingClientRect();
      const origin = active?.thumb.getBoundingClientRect() ?? label(previous);
      finish();
      if (!dialog.open || document.hidden || reduced.matches || contrast.matches || root.dataset.motion === 'off') {
        paint();
        return;
      }
      const destination = label(next), bounds = track.getBoundingClientRect();
      const thumb = document.createElement('i');
      thumb.className = 'mode-traveller';
      thumb.setAttribute('aria-hidden', 'true');
      const dx = origin.left - destination.left;
      Object.assign(thumb.style, { left: destination.left - bounds.left - track.clientLeft + 'px',
        top: destination.top - bounds.top - track.clientTop + 'px', width: destination.width + 'px',
        height: destination.height + 'px', transform: 'translateX(' + dx + 'px)' });
      const glyph = document.createElement('canvas');
      glyph.width = glyph.height = 40;
      thumb.append(glyph);
      track.dataset.modeFlight = 'moving';
      track.append(thumb);
      const fromFace = getComputedStyle(thumb).backgroundColor;
      const context = glyph.getContext('2d');
      const rim = scheme => scheme === 'dark'
        ? 'inset 1px -2px 3px #b8c7ff, -2px 2px 8px #869eff9e'
        : 'inset -1px -2px 3px #ffdd99, 2px 2px 8px #f3b24e99';
      thumb.style.boxShadow = rim(fromScheme);
      if (context) drawGlyph(context, fromScheme, toScheme, 0);
      let frame = 0, animation, transition, painted = false;
      function commit() {
        if (!painted) { painted = true; paint(); }
      }
      function clear() {
        if (active?.thumb !== thumb) return;
        active = null;
        commit();
        transition?.skipTransition();
        cancelAnimationFrame(frame);
        animation?.cancel();
        thumb.remove();
        delete track.dataset.modeFlight;
        root.classList.remove('studio-mode-blend');
      }
      active = { thumb, finish: clear };
      function begin() {
        if (active?.thumb !== thumb) return;
        commit();
        const toFace = getComputedStyle(thumb).backgroundColor;
        animation = thumb.animate([
          { transform: 'translateX(' + dx + 'px)', backgroundColor: fromFace, boxShadow: rim(fromScheme), opacity: 1 },
          { transform: 'translateX(0)', backgroundColor: toFace, boxShadow: rim(toScheme), opacity: 1, offset: .78 },
          { transform: 'translateX(0)', backgroundColor: toFace, boxShadow: rim(toScheme), opacity: 0 }
        ], { duration, easing: 'cubic-bezier(.32,.02,.25,1)', fill: 'both' });
        function tick() {
          const phase = Math.min(1, (animation.currentTime ?? 0) / duration);
          if (phase > .66) track.dataset.modeFlight = 'settling';
          if (context) drawGlyph(context, fromScheme, toScheme, Math.min(1, phase / .8));
          if (phase < 1) frame = requestAnimationFrame(tick);
        }
        frame = requestAnimationFrame(tick);
        animation.onfinish = clear;
      }
      if (document.startViewTransition && fromScheme !== toScheme) {
        root.classList.add('studio-mode-blend');
        transition = document.startViewTransition(commit);
        // Start travelling once the browser can present frames. If it skips the
        // page snapshot, the control can still move on its own.
        transition.ready.then(begin, begin);
      } else begin();
    }
    reduced.addEventListener('change', finish);
    contrast.addEventListener('change', finish);
    window.addEventListener('resize', finish);
    document.addEventListener('visibilitychange', finish);
    dialog.addEventListener('close', finish);
    new MutationObserver(() => { if (root.dataset.motion === 'off') finish(); })
      .observe(root, { attributes: true, attributeFilter: ['data-motion'] });
    return { play, finish };
  };
})();
