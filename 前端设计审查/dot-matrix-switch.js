/* =========================================================================
   100% FLICKER-FREE 3-STATE MONOCHROME (BLACK / GRAY / WHITE)
   DOT-MATRIX FROSTED-GLASS SWITCH ENGINE
   Faithful full 4-canvas replication unified with the workbench glass tokens
   ========================================================================= */
(() => {
  'use strict';

  const PRESETS = [
    { key: 'black', label: '黑', name: '黑曜玻璃', theme: 'glass', scheme: 'dark', p: 0 },
    { key: 'gray',  label: '灰', name: '雾灰玻璃', theme: 'noir',  scheme: 'dark', p: 0.5 },
    { key: 'white', label: '白', name: '银白玻璃', theme: 'glass', scheme: 'light', p: 1 }
  ];

  // Unified monochrome optical palettes matching workbench 黑曜 / 雾灰 / 柔光银白
  const PAL_BLACK = {
    auraDeep:     [72, 114, 178],
    auraMid:      [148, 192, 246],
    rimOuter:     [110, 158, 224],
    rimMid:       [188, 218, 255],
    rimHot:       [242, 248, 255],
    glassTop:     [52, 60, 74],
    glassMid:     [30, 36, 46],
    glassBot:     [16, 20, 28],
    glassScatter: [132, 174, 232],
    glassHot:     [234, 244, 255],
    glassRim:     [218, 234, 255],
    ledCore:      [255, 255, 255],
    ledAlt:       [216, 228, 248],
    rimBaseTop:   0.32,
    rimBaseMid:   0.15,
    rimBaseBot:   0.09,
    dotUnlit:     [255, 255, 255, 0.038]
  };

  const PAL_GRAY = {
    auraDeep:     [112, 128, 148],
    auraMid:      [190, 202, 218],
    rimOuter:     [156, 170, 188],
    rimMid:       [218, 226, 238],
    rimHot:       [248, 251, 255],
    glassTop:     [114, 123, 136],
    glassMid:     [80, 88, 100],
    glassBot:     [56, 63, 73],
    glassScatter: [186, 198, 214],
    glassHot:     [242, 246, 252],
    glassRim:     [232, 238, 246],
    ledCore:      [252, 254, 255],
    ledAlt:       [214, 222, 234],
    rimBaseTop:   0.38,
    rimBaseMid:   0.18,
    rimBaseBot:   0.11,
    dotUnlit:     [255, 255, 255, 0.045]
  };

  const PAL_WHITE = {
    auraDeep:     [68, 98, 132],
    auraMid:      [172, 194, 218],
    rimOuter:     [96, 126, 160],
    rimMid:       [204, 218, 236],
    rimHot:       [255, 255, 255],
    glassTop:     [242, 246, 251],
    glassMid:     [222, 230, 240],
    glassBot:     [198, 209, 222],
    glassScatter: [152, 174, 200],
    glassHot:     [255, 255, 255],
    glassRim:     [255, 255, 255],
    // Crisp high-contrast steel-ink dot-matrix LEDs on soft silver-white frosted glass
    ledCore:      [24, 38, 54],
    ledAlt:       [58, 86, 116],
    rimBaseTop:   0.82,
    rimBaseMid:   0.48,
    rimBaseBot:   0.26,
    dotUnlit:     [15, 23, 34, 0.058]
  };

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  function samplePalette(p) {
    const [A, B, t] = p <= 0.5
      ? [PAL_BLACK, PAL_GRAY, clamp(p * 2, 0, 1)]
      : [PAL_GRAY, PAL_WHITE, clamp((p - 0.5) * 2, 0, 1)];
    const mixRGB = k => [
      Math.round(lerp(A[k][0], B[k][0], t)),
      Math.round(lerp(A[k][1], B[k][1], t)),
      Math.round(lerp(A[k][2], B[k][2], t))
    ];
    return {
      auraDeep:     mixRGB('auraDeep'),
      auraMid:      mixRGB('auraMid'),
      rimOuter:     mixRGB('rimOuter'),
      rimMid:       mixRGB('rimMid'),
      rimHot:       mixRGB('rimHot'),
      glassTop:     mixRGB('glassTop'),
      glassMid:     mixRGB('glassMid'),
      glassBot:     mixRGB('glassBot'),
      glassScatter: mixRGB('glassScatter'),
      glassHot:     mixRGB('glassHot'),
      glassRim:     mixRGB('glassRim'),
      ledCore:      mixRGB('ledCore'),
      ledAlt:       mixRGB('ledAlt'),
      rimBaseTop:   lerp(A.rimBaseTop, B.rimBaseTop, t),
      rimBaseMid:   lerp(A.rimBaseMid, B.rimBaseMid, t),
      rimBaseBot:   lerp(A.rimBaseBot, B.rimBaseBot, t),
      dotUnlit:     [
        Math.round(lerp(A.dotUnlit[0], B.dotUnlit[0], t)),
        Math.round(lerp(A.dotUnlit[1], B.dotUnlit[1], t)),
        Math.round(lerp(A.dotUnlit[2], B.dotUnlit[2], t)),
        lerp(A.dotUnlit[3], B.dotUnlit[3], t)
      ]
    };
  }

  function rgba(rgb, alpha) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(4)})`;
  }

  function traceRoundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
  }

  /* -----------------------------------------------------------------------
     PRE-BAKED STATIC OFFSCREEN TEXTURES (ZERO PER-FRAME ALLOCATION)
     ----------------------------------------------------------------------- */
  // A. Bead-blasted frosted-glass procedural grain texture
  const frostGrainCanvas = document.createElement('canvas');
  frostGrainCanvas.width = 256;
  frostGrainCanvas.height = 256;
  (() => {
    const gCtx = frostGrainCanvas.getContext('2d');
    const img = gCtx.createImageData(256, 256);
    const data = img.data;
    let seed = 133742;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = (seed >>> 24) & 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    gCtx.putImageData(img, 0, 0);
  })();

  // B. Pre-baked soft micro-LED bloom sprites
  function createLedGlowSprite(rgb, coreRgb = [255, 255, 255], boost = 1) {
    const c = document.createElement('canvas');
    c.width = 24; c.height = 24;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(12, 12, 0.5, 12, 12, 11.5);
    grad.addColorStop(0, rgba(coreRgb, 0.82 * boost));
    grad.addColorStop(0.28, rgba(rgb, 0.45 * boost));
    grad.addColorStop(0.65, rgba(rgb, 0.12 * boost));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 24, 24);
    return c;
  }

  const blackLedSprite = createLedGlowSprite([176, 212, 255], [255, 255, 255], 1.0);
  const grayLedSprite  = createLedGlowSprite([216, 226, 240], [255, 255, 255], 0.88);
  const whiteLedSprite = createLedGlowSprite([47, 79, 111], [30, 50, 74], 0.34);

  /* -----------------------------------------------------------------------
     DOT-MATRIX LED PATTERN PRECOMPUTATION (17x17 HERO & 9x9 COMPACT)
     ----------------------------------------------------------------------- */
  function buildDotMatrix(gridSize) {
    const cells = [];
    const mid = (gridSize - 1) * 0.5;
    const sc = mid / 8.0;
    const moonCx = 6.2 * sc, moonCy = 9.0 * sc, moonR = 5.5 * sc;
    const shadowCx = 9.05 * sc, shadowCy = 6.85 * sc, shadowR = 4.45 * sc;

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        // 1) Black / Night: Exact crescent moon + checkerboard shadow + stars
        let nightVal = 0, nightKind = 0;
        const dm = Math.hypot(col - moonCx, row - moonCy);
        const ds = Math.hypot(col - shadowCx, row - shadowCy);
        if (dm <= moonR) {
          if (ds > shadowR) {
            nightVal = 1.0; nightKind = 1;
          } else {
            nightVal = ((col + row) % 2 === 0) ? 0.22 : 0.04;
            nightKind = 2;
          }
        }
        if (gridSize === 17) {
          if (col === 10 && row === 2) { nightVal = 0.94; nightKind = 3; }
          if (col === 14 && row === 3) { nightVal = 0.92; nightKind = 3; }
          else if ((col === 14 && (row === 2 || row === 4)) || (row === 3 && (col === 13 || col === 15))) {
            nightVal = 0.46; nightKind = 4;
          }
          if (col === 14 && row === 7) { nightVal = 0.88; nightKind = 3; }
        } else {
          if ((col === 6 && row === 1) || (col === 7 && row === 3)) {
            nightVal = 0.94; nightKind = 3;
          }
        }

        // 2) Gray / Mist: Sculpted half-eclipse ring + drifting mist pixel horizon
        let grayVal = 0, grayKind = 0;
        const dRing = Math.hypot(col - mid, row - mid);
        if (dRing >= 3.1 * sc && dRing <= 5.25 * sc) {
          grayVal = col <= mid ? 0.96 : (((col + row) % 2 === 0) ? 0.56 : 0.22);
          grayKind = col <= mid ? 1 : 2;
        } else if (dRing < 3.1 * sc) {
          grayVal = ((col + row) % 2 === 0) ? 0.16 : 0.03;
          grayKind = 2;
        }
        const mistRow = Math.round(13.2 * sc);
        if (row === mistRow && col >= Math.round(4 * sc) && col <= Math.round(12 * sc)) {
          grayVal = Math.max(grayVal, 0.50);
          grayKind = 3;
        }

        // 3) White / Day: Exact radiant sun + 8 pulsing directional pixel rays
        let dayVal = 0, dayKind = 0;
        const dSun = Math.hypot(col - mid, row - mid);
        if (dSun <= 2.35 * sc) {
          dayVal = 1.0; dayKind = 1;
        } else if (dSun <= 3.45 * sc) {
          dayVal = 0.93; dayKind = 2;
        } else {
          const dx = Math.abs(col - mid), dy = Math.abs(row - mid);
          if (gridSize === 17) {
            if ((dx === 0 && dy >= 5 && dy <= 7) || (dy === 0 && dx >= 5 && dx <= 7)) {
              const dist = Math.max(dx, dy);
              dayVal = dist === 5 ? 0.95 : dist === 6 ? 0.78 : 0.56;
              dayKind = 3;
            } else if (dx === dy && dx >= 4 && dx <= 5) {
              dayVal = dx === 4 ? 0.88 : 0.62;
              dayKind = 3;
            }
          } else {
            if ((dx === 0 && dy >= 3 && dy <= 4) || (dy === 0 && dx >= 3 && dx <= 4) || (dx === dy && dx === 3)) {
              dayVal = 0.90; dayKind = 3;
            }
          }
        }

        const distFromCenter = Math.hypot(col - mid, row - mid) / Math.max(1, sc);
        const unlitScale = distFromCenter <= 8.2 ? 1.0 : 0.38;
        const hash = ((col * 29 + row * 19) % 13) / 13;
        const morphDelay = (distFromCenter / 11.4) * 0.26 + hash * 0.08;
        const angle = Math.atan2(row - mid, col - mid);

        cells.push({
          col, row,
          nightVal, nightKind,
          grayVal, grayKind,
          dayVal, dayKind,
          unlitScale,
          morphDelay,
          angle,
          phase: col * 1.65 + row * 2.15,
          _lum: 0
        });
      }
    }
    return cells;
  }

  const matrix17 = buildDotMatrix(17);
  const matrix9  = buildDotMatrix(9);

  /* -----------------------------------------------------------------------
     3-LAYER WEB AUDIO SYNTHESIZED GLASS-CLICK TACTILE SOUND (EXACT ORIGINAL)
     ----------------------------------------------------------------------- */
  let audioCtx = null;
  let soundEnabled = true;

  function ensureAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx && Ctx) audioCtx = new Ctx();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }

  function playGlassClick(idx) {
    if (!soundEnabled) return;
    ensureAudio();
    if (!audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      // 1) Crisp filtered crystal micro-snap
      const len = Math.floor(audioCtx.sampleRate * 0.016);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.17));
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime([2850, 3200, 3550][idx] || 3200, now);
      filter.Q.setValueAtTime(2.8, now);
      const snapGain = audioCtx.createGain();
      snapGain.gain.setValueAtTime(0.14, now);
      snapGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.015);
      src.connect(filter); filter.connect(snapGain); snapGain.connect(audioCtx.destination);
      src.start(now);

      // 2) Soft magnetic detent thud
      const bodyOsc = audioCtx.createOscillator();
      bodyOsc.type = 'triangle';
      bodyOsc.frequency.setValueAtTime([180, 200, 220][idx] || 200, now);
      bodyOsc.frequency.exponentialRampToValueAtTime(68, now + 0.04);
      const bodyGain = audioCtx.createGain();
      bodyGain.gain.setValueAtTime(0.095, now);
      bodyGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.042);
      bodyOsc.connect(bodyGain); bodyGain.connect(audioCtx.destination);
      bodyOsc.start(now); bodyOsc.stop(now + 0.045);

      // 3) Subtle optical glass overtone ping
      const pingOsc = audioCtx.createOscillator();
      pingOsc.type = 'sine';
      pingOsc.frequency.setValueAtTime([1180, 1360, 1560][idx] || 1360, now + 0.003);
      const pingGain = audioCtx.createGain();
      pingGain.gain.setValueAtTime(0.0001, now);
      pingGain.gain.linearRampToValueAtTime(0.018, now + 0.008);
      pingGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.075);
      pingOsc.connect(pingGain); pingGain.connect(audioCtx.destination);
      pingOsc.start(now); pingOsc.stop(now + 0.08);
    } catch {}
  }

  // Live workbench glass opacity sync (cached, never polled with getComputedStyle per frame)
  let cachedGlassAlpha = 0.50;
  function refreshGlassAlpha() {
    const raw = parseFloat(document.documentElement.style.getPropertyValue('--alpha')
      || document.documentElement.style.getPropertyValue('--frost-opacity')
      || getComputedStyle(document.documentElement).getPropertyValue('--alpha')
      || getComputedStyle(document.documentElement).getPropertyValue('--frost-opacity'));
    cachedGlassAlpha = Number.isFinite(raw) ? clamp(raw, 0.15, 0.88) : 0.50;
  }

  const instances = new Set();

  function getActiveIndex() {
    const mat = document.documentElement.dataset.material;
    if (mat === 'gray') return 1;
    if (mat === 'white') return 2;
    return 0;
  }

  function applyPreset(idx, withSound = false) {
    const preset = PRESETS[clamp(idx, 0, 2)];
    if (withSound) playGlassClick(idx);
    // CRITICAL: animate=false prevents ViewTransition's 160ms full-page raster freeze,
    // keeping the 60/120fps critically-damped spring slide & plasma sweep 100% silky!
    if (typeof window.applyStudioTheme === 'function') {
      window.applyStudioTheme(preset.theme, preset.scheme, true, false);
    }
    document.dispatchEvent(new CustomEvent('studio-theme', { detail: { studioTheme: preset.theme, theme: preset.scheme } }));
    for (const inst of instances) inst.syncTarget(preset.p);
  }

  function createSwitchInstance(host) {
    const isCompact = host.classList.contains('head-themes') || host.classList.contains('glass-presets');
    const variantClass = isCompact ? 'dm-compact' : 'dm-hero';
    const gridSize = isCompact ? 9 : 17;
    const cells = isCompact ? matrix9 : matrix17;

    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = `dm-switch-wrap ${variantClass}`;

    const stage = document.createElement('div');
    stage.className = 'dm-switch-stage';

    const auraCanvas = document.createElement('canvas');
    auraCanvas.className = 'dm-aura-canvas';
    auraCanvas.setAttribute('aria-hidden', 'true');

    const track = document.createElement('div');
    track.className = 'dm-track';
    track.setAttribute('role', 'radiogroup');
    track.setAttribute('aria-label', '黑白灰点阵毛玻璃主题开关');
    track.tabIndex = 0;

    const floorCanvas = document.createElement('canvas');
    floorCanvas.className = 'dm-floor-canvas';
    floorCanvas.setAttribute('aria-hidden', 'true');

    const slots = document.createElement('div');
    slots.className = 'dm-slots';
    slots.innerHTML = PRESETS.map((pr, idx) =>
      `<span class="dm-slot-btn" data-glass-preset="${pr.key}" data-idx="${idx}" aria-pressed="false">${isCompact ? pr.label : pr.name.slice(0, 2)}</span>`
    ).join('');

    const thumbMover = document.createElement('div');
    thumbMover.className = 'dm-thumb-mover';
    const thumbBody = document.createElement('div');
    thumbBody.className = 'dm-thumb-body';
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.className = 'dm-thumb-canvas';
    thumbCanvas.setAttribute('aria-hidden', 'true');
    thumbBody.append(thumbCanvas);
    thumbMover.append(thumbBody);

    const rimCanvas = document.createElement('canvas');
    rimCanvas.className = 'dm-rim-canvas';
    rimCanvas.setAttribute('aria-hidden', 'true');

    track.append(floorCanvas, slots, thumbMover);
    stage.append(auraCanvas, track, rimCanvas);
    wrap.append(stage);

    let soundBtn = null;
    let stateLabel = null;
    if (!isCompact) {
      const meta = document.createElement('div');
      meta.className = 'dm-hero-meta';
      stateLabel = document.createElement('span');
      soundBtn = document.createElement('button');
      soundBtn.type = 'button';
      soundBtn.className = 'dm-sound-btn';
      soundBtn.textContent = soundEnabled ? '触觉音效 开' : '触觉音效 关';
      soundBtn.onclick = e => {
        e.stopPropagation();
        soundEnabled = !soundEnabled;
        for (const inst of instances) inst.updateSoundBtn();
        if (soundEnabled) playGlassClick(getActiveIndex());
      };
      meta.append(stateLabel, soundBtn);
      wrap.append(meta);
    }

    host.append(wrap);

    const auraCtx = auraCanvas.getContext('2d', { alpha: true });
    const floorCtx = floorCanvas.getContext('2d', { alpha: true });
    const thumbCtx = thumbCanvas.getContext('2d', { alpha: true });
    const rimCtx = rimCanvas.getContext('2d', { alpha: true });

    let geom = {
      w: 0, h: 0, r: 0, pad: 0, thumb: 0, thumbR: 0, travel: 1,
      auraW: 0, auraH: 0, rimW: 0, rimH: 0, scale: 1
    };

    function measureAndSize() {
      const w = track.clientWidth;
      const h = track.clientHeight;
      if (!w || !h) return;
      const cs = getComputedStyle(stage);
      const pad = parseFloat(cs.getPropertyValue('--dm-pad')) || (isCompact ? 3 : 6);
      const thumb = parseFloat(cs.getPropertyValue('--dm-thumb')) || (h - pad * 2);
      const r = parseFloat(cs.getPropertyValue('--dm-r')) || (isCompact ? 13 : 30);
      const thumbR = parseFloat(cs.getPropertyValue('--dm-thumb-r')) || (isCompact ? 10 : 23);
      const auraPadX = isCompact ? 44 : 120;
      const auraPadY = isCompact ? 34 : 96;
      const rimPad = isCompact ? 24 : 52;
      const auraW = w + auraPadX, auraH = h + auraPadY;
      const rimW = w + rimPad, rimH = h + rimPad;
      const scale = h / 150; // Normalized to original 150px track height
      geom = {
        w, h, r, pad, thumb, thumbR,
        travel: Math.max(1, w - thumb - pad * 2),
        auraW, auraH, rimW, rimH, scale
      };

      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      for (const [c, ctx, cw, ch] of [
        [auraCanvas, auraCtx, auraW, auraH],
        [floorCanvas, floorCtx, w, h],
        [thumbCanvas, thumbCtx, thumb, thumb],
        [rimCanvas, rimCtx, rimW, rimH]
      ]) {
        c.width = Math.round(cw * dpr);
        c.height = Math.round(ch * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    const ro = new ResizeObserver(measureAndSize);
    ro.observe(stage);
    measureAndSize();

    const initIdx = getActiveIndex();
    const state = {
      p: PRESETS[initIdx].p,
      target: PRESETS[initIdx].p,
      vel: 0,
      isDragging: false,
      dragMoved: false,
      pointerId: null,
      startX: 0,
      startP: 0,
      lastX: 0,
      lastTime: 0,
      flickVel: 0
    };

    const hover = { x: 0, y: 0, alpha: 0, targetAlpha: 0, rx: 0, ry: 0, targetRx: 0, targetRy: 0 };

    function syncTarget(nextP) {
      state.target = nextP;
      const idx = nextP < 0.25 ? 0 : nextP < 0.75 ? 1 : 2;
      slots.querySelectorAll('.dm-slot-btn').forEach((el, i) => {
        el.setAttribute('aria-pressed', String(i === idx));
      });
      if (stateLabel) stateLabel.textContent = '当前材质：' + PRESETS[idx].name;
    }

    function updateSoundBtn() {
      if (soundBtn) soundBtn.textContent = soundEnabled ? '触觉音效 开' : '触觉音效 关';
    }

    syncTarget(state.target);

    // Pointer capture & physics controller (exact original mechanics)
    track.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      ensureAudio();
      state.isDragging = true;
      state.dragMoved = false;
      state.pointerId = e.pointerId;
      state.startX = e.clientX;
      state.lastX = e.clientX;
      state.lastTime = performance.now();
      state.startP = clamp(state.p, 0, 1);
      state.vel = 0;
      state.flickVel = 0;
      hover.targetAlpha = hover.targetRx = hover.targetRy = hover.rx = hover.ry = 0;
      try { track.setPointerCapture(e.pointerId); } catch {}
    });

    track.addEventListener('pointermove', e => {
      if (state.isDragging && e.pointerId === state.pointerId) {
        const dx = e.clientX - state.startX;
        if (Math.abs(dx) > 4) state.dragMoved = true;
        if (state.dragMoved) {
          const rawP = state.startP + dx / geom.travel;
          if (rawP < 0) state.p = Math.max(-0.04, rawP * 0.12);
          else if (rawP > 1) state.p = Math.min(1.04, 1 + (rawP - 1) * 0.12);
          else state.p = rawP;

          const now = performance.now();
          const dt = Math.max(now - state.lastTime, 4) / 1000;
          const instVel = ((e.clientX - state.lastX) / geom.travel) / dt;
          state.flickVel = lerp(state.flickVel, instVel, 0.45);
          state.lastX = e.clientX;
          state.lastTime = now;
        }
        return;
      }
      if (e.pointerType === 'mouse' && !state.isDragging) {
        const rect = thumbBody.getBoundingClientRect();
        const over = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (over) {
          const nx = (e.clientX - rect.left) / rect.width;
          const ny = (e.clientY - rect.top) / rect.height;
          hover.x = nx * geom.thumb;
          hover.y = ny * geom.thumb;
          hover.targetAlpha = 1;
          hover.targetRy = (nx - 0.5) * 6.5;
          hover.targetRx = (0.5 - ny) * 6.5;
        } else {
          hover.targetAlpha = hover.targetRx = hover.targetRy = 0;
        }
      }
    });

    function endDrag(e) {
      if (!state.isDragging || e.pointerId !== state.pointerId) return;
      state.isDragging = false;
      try { if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId); } catch {}
      if (!state.dragMoved) {
        const rect = track.getBoundingClientRect();
        const rel = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        const idx = rel < 0.34 ? 0 : rel < 0.67 ? 1 : 2;
        applyPreset(idx, true);
      } else {
        const projected = clamp(state.p + state.flickVel * 0.085, 0, 1);
        const idx = projected < 0.25 ? 0 : projected < 0.75 ? 1 : 2;
        state.vel = clamp(state.flickVel * 0.38, -6, 6);
        const prevIdx = getActiveIndex();
        applyPreset(idx, true);
        if (prevIdx === idx && Math.abs(state.p - PRESETS[idx].p) > 0.16) playGlassClick(idx);
      }
    }

    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('pointerleave', () => {
      if (!state.isDragging) hover.targetAlpha = hover.targetRx = hover.targetRy = 0;
    });

    track.addEventListener('keydown', e => {
      const curr = getActiveIndex();
      if (e.key === 'ArrowRight') { e.preventDefault(); applyPreset(Math.min(2, curr + 1), true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); applyPreset(Math.max(0, curr - 1), true); }
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); applyPreset((curr + 1) % 3, true); }
    });

    function getPlasmaFocus(p) {
      const arcDip = Math.sin(p * Math.PI);
      const { w, h, pad, thumb } = geom;
      return {
        x: lerp(pad + thumb * 0.28, w - pad - thumb * 0.28, p),
        y: h * 0.81 + arcDip * (h * 0.19),
        arcDip
      };
    }

    /* -------------------------------------------------------------------
       CANVAS 1: FAR STUDIO ATMOSPHERIC AURA + 3-PASS OUTER PLASMA STROKES
       ------------------------------------------------------------------- */
    function renderAura(p, pal, breath, focus) {
      const { w, h, r, auraW, auraH, scale } = geom;
      const ctx = auraCtx;
      ctx.clearRect(0, 0, auraW, auraH);

      const ox = (auraW - w) * 0.5;
      const oy = (auraH - h) * 0.5;
      const fx = ox + focus.x;
      const fy = oy + focus.y;
      const isLight = p > 0.72;
      const lightDamp = isLight ? 0.62 : 1.0;

      ctx.save();
      ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';

      // 1. Wide studio atmospheric halo
      const farR = 255 * scale * breath;
      const farGrad = ctx.createRadialGradient(fx, fy - 6 * scale, 2, fx, fy - 6 * scale, farR);
      farGrad.addColorStop(0, rgba(pal.auraMid, 0.25 * breath * lightDamp));
      farGrad.addColorStop(0.28, rgba(pal.auraDeep, 0.14 * breath * lightDamp));
      farGrad.addColorStop(0.62, rgba(pal.auraDeep, 0.04 * breath * lightDamp));
      farGrad.addColorStop(1, rgba(pal.auraDeep, 0));
      ctx.fillStyle = farGrad;
      ctx.fillRect(0, 0, auraW, auraH);

      // 2. Concentrated near-field scatter behind active corner
      const nearR = 132 * scale * breath;
      const nearGrad = ctx.createRadialGradient(fx, fy, 1, fx, fy, nearR);
      nearGrad.addColorStop(0, rgba(pal.auraMid, 0.34 * breath * lightDamp));
      nearGrad.addColorStop(0.45, rgba(pal.auraDeep, 0.13 * breath * lightDamp));
      nearGrad.addColorStop(1, rgba(pal.auraDeep, 0));
      ctx.fillStyle = nearGrad;
      ctx.fillRect(0, 0, auraW, auraH);

      // 3. Multi-pass feathered wide outer plasma strokes along exact track perimeter
      traceRoundedRect(ctx, ox, oy, w, h, r);
      const outerLayers = [
        { width: 42 * scale, r: 120 * scale * breath, a0: 0.14, a1: 0.055 },
        { width: 28 * scale, r: 112 * scale * breath, a0: 0.22, a1: 0.09 },
        { width: 17 * scale, r: 106 * scale * breath, a0: 0.32, a1: 0.12 }
      ];
      for (let i = 0; i < outerLayers.length; i++) {
        const L = outerLayers[i];
        const g = ctx.createRadialGradient(fx, fy, 2, fx, fy, Math.max(12, L.r));
        g.addColorStop(0, rgba(pal.auraMid, L.a0 * breath * lightDamp));
        g.addColorStop(0.55, rgba(pal.rimOuter, L.a1 * breath * lightDamp));
        g.addColorStop(0.86, rgba(pal.auraDeep, L.a1 * 0.28 * breath * lightDamp));
        g.addColorStop(1, rgba(pal.auraDeep, 0));
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(1.5, L.width);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* -------------------------------------------------------------------
       CANVAS 2: SOFT LIGHT REFLECTION ACROSS RECESSED GLASS TRACK FLOOR
       ------------------------------------------------------------------- */
    function renderTrackFloor(p, pal, breath, focus) {
      const { w, h, scale } = geom;
      const ctx = floorCtx;
      ctx.clearRect(0, 0, w, h);

      const grad = ctx.createRadialGradient(focus.x, focus.y, 2, focus.x, focus.y, Math.max(24, 128 * scale));
      grad.addColorStop(0, rgba(pal.auraMid, 0.24 * breath));
      grad.addColorStop(0.45, rgba(pal.auraDeep, 0.08 * breath));
      grad.addColorStop(1, rgba(pal.auraDeep, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    /* -------------------------------------------------------------------
       CANVAS 4: 4-LAYER RAZOR-SHARP INCANDESCENT PLASMA PERIMETER ARC
       ------------------------------------------------------------------- */
    function renderRim(p, pal, breath, focus) {
      const { w, h, r, rimW, rimH, scale } = geom;
      const ctx = rimCtx;
      ctx.clearRect(0, 0, rimW, rimH);

      const ox = (rimW - w) * 0.5;
      const oy = (rimH - h) * 0.5;
      const fx = ox + focus.x;
      const fy = oy + focus.y;
      const isLight = p > 0.72;
      const lwMin = isCompact ? 0.9 : 1.0;

      ctx.save();
      ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
      traceRoundedRect(ctx, ox + 0.5, oy + 0.5, w - 1, h - 1, r);

      // Layer 1: Soft outer plasma sheath
      const g1 = ctx.createRadialGradient(fx, fy, 2, fx, fy, Math.max(20, 108 * scale * breath));
      g1.addColorStop(0, rgba(pal.rimMid, (isLight ? 0.34 : 0.44) * breath));
      g1.addColorStop(0.52, rgba(pal.rimOuter, (isLight ? 0.18 : 0.22) * breath));
      g1.addColorStop(0.84, rgba(pal.rimOuter, 0.05 * breath));
      g1.addColorStop(1, rgba(pal.rimOuter, 0));
      ctx.strokeStyle = g1;
      ctx.lineWidth = Math.max(lwMin * 4, 12.5 * scale);
      ctx.stroke();

      // Layer 2: Focused bright mid-plasma halo
      const g2 = ctx.createRadialGradient(fx, fy, 2, fx, fy, Math.max(18, 103 * scale * breath));
      g2.addColorStop(0, rgba(pal.rimHot, (isLight ? 0.52 : 0.68) * breath));
      g2.addColorStop(0.48, rgba(pal.rimMid, (isLight ? 0.32 : 0.44) * breath));
      g2.addColorStop(0.82, rgba(pal.rimOuter, 0.11 * breath));
      g2.addColorStop(1, rgba(pal.rimOuter, 0));
      ctx.strokeStyle = g2;
      ctx.lineWidth = Math.max(lwMin * 2.5, 6.2 * scale);
      ctx.stroke();

      // Layer 3: Intense inner plasma core
      const g3 = ctx.createRadialGradient(fx, fy, 1, fx, fy, Math.max(16, 98 * scale * breath));
      g3.addColorStop(0, rgba([255, 255, 255], (isLight ? 0.78 : 0.92) * breath));
      g3.addColorStop(0.52, rgba(pal.rimHot, (isLight ? 0.54 : 0.72) * breath));
      g3.addColorStop(0.82, rgba(pal.rimMid, 0.22 * breath));
      g3.addColorStop(1, rgba(pal.rimMid, 0));
      ctx.strokeStyle = g3;
      ctx.lineWidth = Math.max(lwMin * 1.5, 3.2 * scale);
      ctx.stroke();

      // Layer 4: Razor-sharp pure incandescent filament
      const g4 = ctx.createRadialGradient(fx, fy, 1, fx, fy, Math.max(14, 94 * scale * breath));
      g4.addColorStop(0, rgba([255, 255, 255], 1.0));
      g4.addColorStop(0.58, rgba(pal.rimHot, isLight ? 0.78 : 0.92));
      g4.addColorStop(0.84, rgba(pal.rimMid, 0.34));
      g4.addColorStop(1, rgba(pal.rimMid, 0));
      ctx.strokeStyle = g4;
      ctx.lineWidth = Math.max(lwMin, 1.75 * scale);
      ctx.stroke();

      ctx.restore();
    }

    /* -------------------------------------------------------------------
       CANVAS 3: FULL 8-LAYER FROSTED GLASS THUMB + 17x17 / 9x9 LED MATRIX
       ------------------------------------------------------------------- */
    function renderThumb(p, pal, breath, timeSec) {
      const { thumb: T, thumbR: R, scale } = geom;
      const ctx = thumbCtx;
      ctx.clearRect(0, 0, T, T);

      const arcDip = Math.sin(p * Math.PI);
      const litX = lerp(T * 0.045, T * 0.955, p);
      const litY = T * 0.78 + arcDip * (T * 0.16);
      const sideX = lerp(-2, T + 2, p);
      const isLight = p > 0.72;

      // Sync thumb translucency smoothly with the workbench's live --alpha slider
      const aTop = clamp(cachedGlassAlpha * 0.72 + 0.38, 0.48, 0.92);
      const aMid = clamp(cachedGlassAlpha * 0.72 + 0.44, 0.54, 0.95);
      const aBot = clamp(cachedGlassAlpha * 0.72 + 0.48, 0.58, 0.97);

      ctx.save();
      traceRoundedRect(ctx, 0, 0, T, T, R);
      ctx.clip();

      // Layer 1: Translucent frosted-glass base body (matched to workbench 黑曜/雾灰/银白)
      const baseGrad = ctx.createLinearGradient(lerp(0, T, p), 0, lerp(T, 0, p), T);
      baseGrad.addColorStop(0, rgba(pal.glassTop, aTop));
      baseGrad.addColorStop(0.52, rgba(pal.glassMid, aMid));
      baseGrad.addColorStop(1, rgba(pal.glassBot, aBot));
      ctx.fillStyle = baseGrad;
      ctx.fillRect(0, 0, T, T);

      // Layer 2: Deep frosted subsurface light scattering inside the glass
      const deepScatter = ctx.createRadialGradient(litX, litY, 2, litX, litY, T * 0.88);
      deepScatter.addColorStop(0, rgba(pal.glassHot, (isLight ? 0.52 : 0.62) * breath));
      deepScatter.addColorStop(0.32, rgba(pal.glassScatter, (isLight ? 0.32 : 0.42) * breath));
      deepScatter.addColorStop(0.66, rgba(pal.glassScatter, 0.14 * breath));
      deepScatter.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.fillStyle = deepScatter;
      ctx.fillRect(0, 0, T, T);

      // Layer 3: Intense milky frosted sheen hugging active side & lower curve + upper bevel bounce
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const hotCaustic = ctx.createRadialGradient(sideX, T * 0.69 + arcDip * (T * 0.18), 1, sideX, T * 0.69 + arcDip * (T * 0.18), T * 0.54);
      hotCaustic.addColorStop(0, rgba(pal.glassHot, (isLight ? 0.54 : 0.68) * breath));
      hotCaustic.addColorStop(0.42, rgba(pal.glassScatter, 0.24 * breath));
      hotCaustic.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.fillStyle = hotCaustic;
      ctx.fillRect(0, 0, T, T);

      const topSheen = ctx.createLinearGradient(0, 0, 0, T * 0.39);
      topSheen.addColorStop(0, `rgba(255, 255, 255, ${isLight ? 0.30 : 0.10})`);
      topSheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = topSheen;
      ctx.fillRect(0, 0, T, T * 0.40);
      ctx.restore();

      // Layer 4: Inner glass slab caustic bevel (light refracting through thick frosted rim)
      ctx.save();
      ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
      const inset = Math.max(1.2, 2.2 * scale);
      traceRoundedRect(ctx, inset, inset, T - inset * 2, T - inset * 2, Math.max(2, R - inset));
      const innerBevelGrad = ctx.createRadialGradient(litX, litY, 2, litX, litY, T * 0.72);
      innerBevelGrad.addColorStop(0, rgba(pal.glassHot, (isLight ? 0.65 : 0.56) * breath));
      innerBevelGrad.addColorStop(0.55, rgba(pal.glassScatter, 0.22 * breath));
      innerBevelGrad.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.strokeStyle = innerBevelGrad;
      ctx.lineWidth = Math.max(1.5, 4.6 * scale);
      ctx.stroke();
      ctx.restore();

      // Layer 5: Static procedural bead-blasted frost grain texture (zero shimmer)
      ctx.save();
      ctx.globalAlpha = 0.048;
      ctx.globalCompositeOperation = 'overlay';
      ctx.drawImage(frostGrainCanvas, 0, 0, T, T);
      ctx.restore();

      // Layer 6: Pointer-tracking hover specular sheen (immediately 0 on drag)
      if (hover.alpha > 0.005) {
        const sp = ctx.createRadialGradient(hover.x, hover.y, 1, hover.x, hover.y, T * 0.54);
        sp.addColorStop(0, `rgba(255, 255, 255, ${(0.18 * hover.alpha).toFixed(4)})`);
        sp.addColorStop(0.5, `rgba(255, 255, 255, ${(0.04 * hover.alpha).toFixed(4)})`);
        sp.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = sp;
        ctx.fillRect(0, 0, T, T);
      }

      // Layer 7: HiDPI Dot-Matrix LED Display
      renderDotMatrix(ctx, T, p, pal, timeSec);

      // Layer 8: Ultra-fine hairline glass rim bevel + bright lit-edge catchlight
      traceRoundedRect(ctx, 0.75, 0.75, T - 1.5, T - 1.5, Math.max(2, R - 0.6));
      const baseRimGrad = ctx.createLinearGradient(0, 0, T, T);
      baseRimGrad.addColorStop(0, `rgba(255, 255, 255, ${pal.rimBaseTop.toFixed(3)})`);
      baseRimGrad.addColorStop(0.5, `rgba(255, 255, 255, ${pal.rimBaseMid.toFixed(3)})`);
      baseRimGrad.addColorStop(1, `rgba(255, 255, 255, ${pal.rimBaseBot.toFixed(3)})`);
      ctx.strokeStyle = baseRimGrad;
      ctx.lineWidth = isCompact ? 1.0 : 1.15;
      ctx.stroke();

      const litRimGrad = ctx.createRadialGradient(litX, litY, 2, litX, litY, T * 0.78);
      litRimGrad.addColorStop(0, rgba([255, 255, 255], 0.96));
      litRimGrad.addColorStop(0.45, rgba(pal.glassRim, 0.72));
      litRimGrad.addColorStop(0.8, rgba(pal.glassScatter, 0.24));
      litRimGrad.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.strokeStyle = litRimGrad;
      ctx.lineWidth = isCompact ? 1.25 : 1.65;
      ctx.stroke();

      ctx.restore();
    }

    function renderDotMatrix(ctx, T, p, pal, timeSec) {
      const spanRatio = isCompact ? 0.66 : 0.56;
      const span = T * spanRatio;
      const step = span / gridSize;
      const pixelSize = step * 0.73;
      const origin = (T - ((gridSize - 1) * step + pixelSize)) * 0.5;

      // Pass A: Faint unlit hardware LED matrix dots
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const x = origin + cell.col * step;
        const y = origin + cell.row * step;
        ctx.fillStyle = rgba(pal.dotUnlit, pal.dotUnlit[3] * cell.unlitScale);
        ctx.fillRect(x + 0.15, y + 0.15, Math.max(0.7, pixelSize - 0.3), Math.max(0.7, pixelSize - 0.3));
      }

      // Pass B: Soft pre-baked bloom behind bright LEDs
      const isLight = p > 0.72;
      const bloomSize = pixelSize * 4.5;
      const bloomOffset = (bloomSize - pixelSize) * 0.5;

      ctx.save();
      ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];

        let nLum = cell.nightVal;
        if (cell.nightKind === 3) nLum *= 0.80 + 0.20 * Math.sin(timeSec * 2.6 + cell.phase);
        else if (cell.nightKind === 4) nLum *= 0.64 + 0.36 * Math.sin(timeSec * 3.1 + cell.phase + 1.2);

        let gLum = cell.grayVal;
        if (cell.grayKind === 3) gLum *= 0.74 + 0.26 * Math.sin(timeSec * 2.2 - cell.col * 0.55);
        else if (cell.grayKind === 1) gLum *= 0.92 + 0.08 * Math.sin(timeSec * 2.0 + cell.row * 0.3);

        let dLum = cell.dayVal;
        if (cell.dayKind === 3) dLum *= 0.76 + 0.24 * Math.sin(timeSec * 2.8 - cell.angle * 2.0);
        else if (cell.dayKind === 2) dLum *= 0.94 + 0.06 * Math.sin(timeSec * 2.1 + cell.phase);

        let lum;
        if (p <= 0.5) {
          const lt = smoothstep(cell.morphDelay, cell.morphDelay + 0.56, p * 2);
          lum = lerp(nLum, gLum, lt);
        } else {
          const lt = smoothstep(cell.morphDelay, cell.morphDelay + 0.56, (p - 0.5) * 2);
          lum = lerp(gLum, dLum, lt);
        }
        cell._lum = lum;

        if (!isCompact && lum > 0.50) {
          const bx = origin + cell.col * step - bloomOffset;
          const by = origin + cell.row * step - bloomOffset;
          const glowIntensity = (lum - 0.44) * 0.52;
          if (p <= 0.5) {
            const blend = p * 2;
            if (blend < 0.98) { ctx.globalAlpha = glowIntensity * (1 - blend); ctx.drawImage(blackLedSprite, bx, by, bloomSize, bloomSize); }
            if (blend > 0.02) { ctx.globalAlpha = glowIntensity * blend; ctx.drawImage(grayLedSprite, bx, by, bloomSize, bloomSize); }
          } else {
            const blend = (p - 0.5) * 2;
            if (blend < 0.98) { ctx.globalAlpha = glowIntensity * (1 - blend); ctx.drawImage(grayLedSprite, bx, by, bloomSize, bloomSize); }
            if (blend > 0.02) { ctx.globalAlpha = glowIntensity * blend; ctx.drawImage(whiteLedSprite, bx, by, bloomSize, bloomSize); }
          }
        }
      }
      ctx.restore();

      // Pass C: Crisp individual rounded micro-LED squares
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const lum = cell._lum;
        if (lum < 0.015) continue;
        const x = origin + cell.col * step;
        const y = origin + cell.row * step;
        const isAlt = (p < 0.35 && cell.nightKind === 2) || (p >= 0.35 && p < 0.72 && cell.grayKind === 2) || (p >= 0.72 && cell.dayKind === 3);
        const rgb = isAlt ? pal.ledAlt : pal.ledCore;
        ctx.fillStyle = rgba(rgb, clamp(lum, 0, 1));
        if (pixelSize >= 1.5) {
          traceRoundedRect(ctx, x, y, pixelSize, pixelSize, pixelSize * 0.18);
          ctx.fill();
        } else {
          ctx.fillRect(x, y, pixelSize, pixelSize);
        }
      }
    }

    const SPRING_K = 320;
    const SPRING_C = 2 * Math.sqrt(SPRING_K); // ~35.78 critically damped, zero bounce

    const inst = {
      state, hover, syncTarget, updateSoundBtn,
      step(dt, timeSec, breath) {
        // Skip invisible popovers/dialogs to keep frame budget 100% dedicated to visible UI
        if (stage.offsetParent === null) return;
        if (!geom.w || !geom.h) measureAndSize();
        if (!geom.w || !geom.h) return;

        // 1. Step critically-damped spring physics
        if (!state.isDragging) {
          const disp = state.target - state.p;
          const accel = disp * SPRING_K - state.vel * SPRING_C;
          state.vel += accel * dt;
          state.p += state.vel * dt;
          if (Math.abs(disp) < 0.00025 && Math.abs(state.vel) < 0.0005) {
            state.p = state.target;
            state.vel = 0;
          }
        }

        // 2. Smoothly update hover specular & 3D micro-tilt (locked flat while dragging)
        const hoverRate = 1 - Math.exp(-14 * dt);
        hover.alpha = lerp(hover.alpha, hover.targetAlpha, hoverRate);
        if (state.isDragging) {
          hover.rx = 0; hover.ry = 0;
        } else {
          hover.rx = lerp(hover.rx, hover.targetRx, hoverRate);
          hover.ry = lerp(hover.ry, hover.targetRy, hoverRate);
        }

        // 3. Apply GPU-locked translation & hover tilt
        const thumbX = geom.pad + state.p * geom.travel;
        thumbMover.style.transform = `translate3d(${thumbX.toFixed(3)}px, 0, 0)`;
        if (Math.abs(hover.rx) > 0.01 || Math.abs(hover.ry) > 0.01) {
          thumbBody.style.transform = `rotateX(${hover.rx.toFixed(3)}deg) rotateY(${hover.ry.toFixed(3)}deg)`;
        } else {
          thumbBody.style.transform = 'none';
        }

        // 4. Unified lighting & 4-canvas lockstep render
        const pClamped = clamp(state.p, 0, 1);
        const pal = samplePalette(pClamped);
        const focus = getPlasmaFocus(pClamped);

        renderAura(pClamped, pal, breath, focus);
        renderTrackFloor(pClamped, pal, breath, focus);
        renderThumb(pClamped, pal, breath, timeSec);
        renderRim(pClamped, pal, breath, focus);
      }
    };
    instances.add(inst);
  }

  let lastFrameTime = performance.now();
  function frame(now) {
    const dt = Math.min((now - lastFrameTime) / 1000, 0.04);
    lastFrameTime = now;
    const timeSec = now * 0.001;
    // Exact original 3.5-second organic breathing pulse
    const breath = 0.965 + 0.045 * Math.sin((timeSec * Math.PI * 2) / 3.5);
    for (const inst of instances) inst.step(dt, timeSec, breath);
    requestAnimationFrame(frame);
  }

  function scanHosts() {
    document.querySelectorAll('.head-themes, .mat-theme, .glass-presets').forEach(host => {
      if (!host.dataset.dmMounted) {
        host.dataset.dmMounted = '1';
        createSwitchInstance(host);
      }
    });
  }

  function mountAll() {
    refreshGlassAlpha();
    scanHosts();

    // Lightweight attribute-only observer on <html> (ZERO subtree/childList overhead!)
    new MutationObserver(() => {
      refreshGlassAlpha();
      const mat = document.documentElement.dataset.material;
      const p = mat === 'gray' ? 0.5 : mat === 'white' ? 1 : 0;
      for (const inst of instances) inst.syncTarget(p);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-material', 'data-scheme', 'data-theme', 'style'] });

    // Shallow body observer ONLY to catch dynamically appended #themeDialog
    new MutationObserver(scanHosts).observe(document.body, { childList: true });
    document.addEventListener('studio-material', refreshGlassAlpha);

    lastFrameTime = performance.now();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll, { once: true });
  else mountAll();
})();
