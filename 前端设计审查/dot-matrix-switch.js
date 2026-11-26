/* =========================================================================
   ULTRA-SILKY 3-STATE MONOCHROME (BLACK / GRAY / WHITE)
   DOT-MATRIX FROSTED-GLASS SWITCH ENGINE
   - Zero threshold pops (continuous lightMix across all 4 canvases)
   - Flush 0px top/bottom alignment inside the track border
   - Continuous canvas-painted track crossfade + quintic dissolve + liquid-light sweep
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
    trackTop:     [10, 14, 21, 0.76],
    trackBot:     [18, 23, 33, 0.80],
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
    rimBaseBot:   0.10,
    dotUnlit:     [255, 255, 255, 0.040]
  };

  const PAL_GRAY = {
    trackTop:     [46, 52, 62, 0.68],
    trackBot:     [64, 72, 84, 0.74],
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
    rimBaseMid:   0.19,
    rimBaseBot:   0.12,
    dotUnlit:     [255, 255, 255, 0.048]
  };

  const PAL_WHITE = {
    trackTop:     [178, 189, 203, 0.60],
    trackBot:     [206, 216, 228, 0.66],
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
    ledCore:      [24, 38, 54],
    ledAlt:       [58, 86, 116],
    rimBaseTop:   0.82,
    rimBaseMid:   0.48,
    rimBaseBot:   0.28,
    dotUnlit:     [15, 23, 34, 0.058]
  };

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // Quintic C2-continuous easing (zero velocity AND zero acceleration jump at both ends)
  const smootherstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
  };

  function lerpPalettes(A, B, t) {
    const mixRGB = k => [
      Math.round(lerp(A[k][0], B[k][0], t)),
      Math.round(lerp(A[k][1], B[k][1], t)),
      Math.round(lerp(A[k][2], B[k][2], t))
    ];
    const mixRGBA = k => [
      Math.round(lerp(A[k][0], B[k][0], t)),
      Math.round(lerp(A[k][1], B[k][1], t)),
      Math.round(lerp(A[k][2], B[k][2], t)),
      lerp(A[k][3], B[k][3], t)
    ];
    return {
      trackTop:     mixRGBA('trackTop'),
      trackBot:     mixRGBA('trackBot'),
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
      dotUnlit:     mixRGBA('dotUnlit')
    };
  }

  function samplePalette(p) {
    const [A, B, t] = p <= 0.5
      ? [PAL_BLACK, PAL_GRAY, clamp(p * 2, 0, 1)]
      : [PAL_GRAY, PAL_WHITE, clamp((p - 0.5) * 2, 0, 1)];
    return lerpPalettes(A, B, t);
  }

  function rgba(rgb, alpha) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp(alpha, 0, 1).toFixed(4)})`;
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
        // 1) Black / Night: Crescent moon + checkerboard shadow + stars
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

        // 2) Gray / Mist: Sculpted half-eclipse ring + drifting mist horizon
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

        // 3) White / Day: Radiant sun + 8 pulsing directional pixel rays
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
          _lum: 0,
          _domP: 0,
          _fromLum: 0,
          _toLum: 0
        });
      }
    }
    return cells;
  }

  const matrix17 = buildDotMatrix(17);
  const matrix9  = buildDotMatrix(9);

  /* -----------------------------------------------------------------------
     3-LAYER WEB AUDIO SYNTHESIZED GLASS-CLICK TACTILE SOUND
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

      const bodyOsc = audioCtx.createOscillator();
      bodyOsc.type = 'triangle';
      bodyOsc.frequency.setValueAtTime([180, 200, 220][idx] || 200, now);
      bodyOsc.frequency.exponentialRampToValueAtTime(68, now + 0.04);
      const bodyGain = audioCtx.createGain();
      bodyGain.gain.setValueAtTime(0.095, now);
      bodyGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.042);
      bodyOsc.connect(bodyGain); bodyGain.connect(audioCtx.destination);
      bodyOsc.start(now); bodyOsc.stop(now + 0.045);

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
    const slotEls = Array.from(slots.querySelectorAll('.dm-slot-btn'));

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
      w: 0, h: 0, boxW: 0, boxH: 0, r: 0, thumb: 0, thumbR: 0, travel: 1,
      auraW: 0, auraH: 0, rimW: 0, rimH: 0, scale: 1
    };

    function measureAndSize() {
      const w = track.clientWidth;
      const h = track.clientHeight;
      if (!w || !h) return;
      const boxW = track.offsetWidth || w;
      const boxH = track.offsetHeight || h;
      const cs = getComputedStyle(stage);
      const r = parseFloat(cs.getPropertyValue('--dm-r')) || (isCompact ? 13 : 30);
      // 100% flush vertical fit inside track's client box (0px top/bottom gap!)
      const thumb = h;
      const thumbR = Math.max(2, r - 1);
      thumbMover.style.width = `${thumb}px`;

      const auraPadX = isCompact ? 0 : 48;
      const auraPadY = isCompact ? 0 : 40;
      const rimPad = isCompact ? 8 : 16;
      const auraW = boxW + auraPadX, auraH = boxH + auraPadY;
      const rimW = boxW + rimPad, rimH = boxH + rimPad;
      const scale = h / 150;
      geom = {
        w, h, boxW, boxH, r, thumb, thumbR,
        travel: Math.max(1, w - thumb),
        auraW, auraH, rimW, rimH, scale
      };

      const dpr = window.devicePixelRatio || 1;
      // Soft blurred layers run at <=1.5x DPR (4x lighter on 3x phones), crisp layers at <=2x DPR
      const softDpr = Math.min(dpr, 1.5);
      const sharpDpr = Math.min(dpr, 2);
      for (const [c, ctx, cw, ch, d] of [
        [auraCanvas, auraCtx, auraW, auraH, softDpr],
        [floorCanvas, floorCtx, w, h, softDpr],
        [thumbCanvas, thumbCtx, thumb, thumb, sharpDpr],
        [rimCanvas, rimCtx, rimW, rimH, sharpDpr]
      ]) {
        c.width = Math.round(cw * d);
        c.height = Math.round(ch * d);
        ctx.setTransform(d, 0, 0, d, 0, 0);
      }
    }

    const ro = new ResizeObserver(measureAndSize);
    ro.observe(stage);
    measureAndSize();

    const initIdx = getActiveIndex();
    const state = {
      p: PRESETS[initIdx].p,
      prevP: PRESETS[initIdx].p,
      trailP: PRESETS[initIdx].p,
      target: PRESETS[initIdx].p,
      vel: 0,
      flowEnergy: 0,
      flowPhase: 0.8,
      flowDir: 1,
      fadeActive: false,
      fadeFromP: PRESETS[initIdx].p,
      fadeToP: PRESETS[initIdx].p,
      fadeProgress: 1,
      fadeDir: 1,
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

    // Pre-allocated fixed pool of micro-pixel meteor stardust sparks (zero GC allocation per frame)
    const emberCount = isCompact ? 14 : 28;
    const embers = Array.from({ length: emberCount }, () => ({
      x: 0, y: 0, vx: 0, vy: 0, size: 1.5, life: 0, maxLife: 0.5, phase: 0, bright: 1
    }));
    let emberCursor = 0;
    let emberAccum = 0;

    function spawnMeteorEmber(x, cy, h, dir, speedScale) {
      const e = embers[emberCursor];
      emberCursor = (emberCursor + 1) % emberCount;
      const spread = (Math.random() - 0.5) * 2; // -1..1
      // Concentrate more sparks near the meteor core, fewer near the outer coma
      const yOffset = Math.sign(spread) * Math.pow(Math.abs(spread), 1.35) * (h * 0.34);
      e.x = x - dir * (Math.random() * (isCompact ? 4 : 10));
      e.y = cy + yOffset;
      e.vx = -dir * (10 + Math.random() * 24) * (isCompact ? 0.5 : 1) * (0.6 + speedScale * 0.6);
      e.vy = yOffset * (0.18 + Math.random() * 0.25);
      e.size = isCompact ? (0.9 + Math.random() * 0.8) : (1.3 + Math.random() * 1.6);
      e.maxLife = 0.36 + Math.random() * 0.34;
      e.life = e.maxLife;
      e.phase = Math.random() * Math.PI * 2;
      e.bright = 0.55 + Math.random() * 0.45;
    }

    function syncTarget(nextP) {
      if (Math.abs(nextP - state.target) > 0.01) {
        state.fadeFromP = clamp(state.p, 0, 1);
        state.fadeToP = nextP;
        state.fadeProgress = 0;
        state.fadeActive = true;
        state.fadeDir = nextP >= state.fadeFromP ? 1 : -1;
      }
      state.target = nextP;
      const idx = nextP < 0.25 ? 0 : nextP < 0.75 ? 1 : 2;
      slotEls.forEach((el, i) => el.setAttribute('aria-pressed', String(i === idx)));
      if (stateLabel) stateLabel.textContent = '当前材质：' + PRESETS[idx].name;
    }

    function updateSoundBtn() {
      if (soundBtn) soundBtn.textContent = soundEnabled ? '触觉音效 开' : '触觉音效 关';
    }

    syncTarget(state.target);

    track.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      ensureAudio();
      state.isDragging = true;
      state.fadeActive = false;
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
          if (rawP < 0) state.p = Math.max(-0.035, rawP * 0.10);
          else if (rawP > 1) state.p = Math.min(1.035, 1 + (rawP - 1) * 0.10);
          else state.p = rawP;

          const now = performance.now();
          const dt = Math.max(now - state.lastTime, 4) / 1000;
          const instVel = ((e.clientX - state.lastX) / geom.travel) / dt;
          state.flickVel = lerp(state.flickVel, instVel, 0.42);
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
          hover.targetRy = (nx - 0.5) * 6.0;
          hover.targetRx = (0.5 - ny) * 6.0;
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
        state.vel = clamp(state.flickVel * 0.32, -5, 5);
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

    // Vertically centered plasma focus so top & bottom edges of the border glow symmetrically!
    function getPlasmaFocus(p) {
      const arcDip = Math.sin(p * Math.PI);
      const { w, h, thumb } = geom;
      return {
        x: lerp(thumb * 0.44, w - thumb * 0.44, p),
        y: h * 0.50,
        arcDip
      };
    }

    /* -------------------------------------------------------------------
       CANVAS 1: RESTRAINED STUDIO ATMOSPHERIC AURA (ZERO BLEED / ZERO EDGE CLIPPING)
       ------------------------------------------------------------------- */
    function renderAura(lightMix, pal, breath, focus) {
      if (isCompact) return;
      const { boxW, boxH, auraW, auraH } = geom;
      const ctx = auraCtx;
      ctx.clearRect(0, 0, auraW, auraH);

      const ox = (auraW - boxW) * 0.5;
      const oy = (auraH - boxH) * 0.5;
      const fx = ox + focus.x + 1;
      const fy = oy + focus.y + 1;
      const lightDamp = lerp(1.0, 0.35, lightMix);
      const maxSafeR = Math.max(16, Math.min(fx, auraW - fx, fy, auraH - fy) - 2);

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      const softGrad = ctx.createRadialGradient(fx, fy, 2, fx, fy, maxSafeR);
      softGrad.addColorStop(0, rgba(pal.auraMid, 0.08 * breath * lightDamp));
      softGrad.addColorStop(0.52, rgba(pal.auraDeep, 0.03 * breath * lightDamp));
      softGrad.addColorStop(1, rgba(pal.auraDeep, 0));
      ctx.fillStyle = softGrad;
      ctx.fillRect(0, 0, auraW, auraH);
      ctx.restore();
    }

    function drawMeteorCone(ctx, xTail, xHead, cy, halfH) {
      const ctrlX = lerp(xTail, xHead, 0.58);
      ctx.beginPath();
      ctx.moveTo(xTail, cy);
      ctx.quadraticCurveTo(ctrlX, cy - halfH * 0.30, xHead, cy - halfH);
      ctx.lineTo(xHead, cy + halfH);
      ctx.quadraticCurveTo(ctrlX, cy + halfH * 0.30, xTail, cy);
      ctx.closePath();
    }

    /* -------------------------------------------------------------------
       CANVAS 2: CONTINUOUS TRACK FLOOR + METEOR COMET TAIL & PIXEL STARDUST
       ------------------------------------------------------------------- */
    function renderTrackFloor(p, trailP, lightMix, pal, breath, focus, timeSec) {
      const { w, h, thumb, travel, scale } = geom;
      const ctx = floorCtx;
      ctx.clearRect(0, 0, w, h);

      // 1. Smoothly crossfaded frosted track background
      const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
      bgGrad.addColorStop(0, rgba(pal.trackTop, pal.trackTop[3]));
      bgGrad.addColorStop(1, rgba(pal.trackBot, pal.trackBot[3]));
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // 2. Symmetrical soft ambient spill around the thumb
      const spillA = lerp(0.18, 0.13, lightMix) * breath;
      const spillGrad = ctx.createRadialGradient(focus.x, focus.y, 2, focus.x, focus.y, Math.max(24, 120 * scale));
      spillGrad.addColorStop(0, rgba(pal.auraMid, spillA));
      spillGrad.addColorStop(0.50, rgba(pal.auraDeep, spillA * 0.28));
      spillGrad.addColorStop(1, rgba(pal.auraDeep, 0));
      ctx.fillStyle = spillGrad;
      ctx.fillRect(0, 0, w, h);

      // 3. Shooting-star / meteor tapered light trail inside the track channel
      const cy = h * 0.5;
      const spanP = Math.abs(p - trailP);
      if (spanP > 0.002) {
        const wakeAlpha = smoothstep(0.002, 0.085, spanP) * lerp(1.0, 0.78, lightMix);
        const headCenter = p * travel + thumb * 0.5;
        const tailCenter = trailP * travel + thumb * 0.5;
        const dir = headCenter >= tailCenter ? 1 : -1;
        // Anchor meteor head just behind the thumb center, tapering to a needle tip at xTail
        const xHead = clamp(headCenter - dir * thumb * 0.10, 0, w);
        const xTail = clamp(tailCenter - dir * thumb * 0.42, 0, w);
        const wakeLen = Math.abs(xHead - xTail);

        if (wakeLen > 2) {
          ctx.save();

          // 3a. Outer meteor coma (wide tapered translucent aura cone)
          drawMeteorCone(ctx, xTail, xHead, cy, h * 0.40);
          const comaGrad = ctx.createLinearGradient(xTail, cy, xHead, cy);
          comaGrad.addColorStop(0, rgba(pal.glassScatter, 0));
          comaGrad.addColorStop(0.35, rgba(pal.glassScatter, 0.14 * wakeAlpha));
          comaGrad.addColorStop(0.75, rgba(pal.rimMid, 0.30 * wakeAlpha));
          comaGrad.addColorStop(1, rgba(pal.rimHot, 0.40 * wakeAlpha));
          ctx.fillStyle = comaGrad;
          ctx.fill();

          // 3b. Mid meteor plasma plume (sleeker, brighter tapered comet body)
          drawMeteorCone(ctx, lerp(xTail, xHead, 0.10), xHead, cy, h * 0.20);
          const plumeGrad = ctx.createLinearGradient(lerp(xTail, xHead, 0.10), cy, xHead, cy);
          plumeGrad.addColorStop(0, rgba(pal.rimMid, 0));
          plumeGrad.addColorStop(0.42, rgba(pal.rimMid, 0.28 * wakeAlpha));
          plumeGrad.addColorStop(0.80, rgba(pal.rimHot, 0.56 * wakeAlpha));
          plumeGrad.addColorStop(1, rgba([255, 255, 255], 0.68 * wakeAlpha));
          ctx.fillStyle = plumeGrad;
          ctx.fill();

          // 3c. Incandescent meteor spine core (razor needle converging to the tail tip)
          drawMeteorCone(ctx, lerp(xTail, xHead, 0.18), xHead, cy, Math.max(1.1, h * 0.055));
          const spineGrad = ctx.createLinearGradient(lerp(xTail, xHead, 0.18), cy, xHead, cy);
          spineGrad.addColorStop(0, rgba(pal.rimHot, 0));
          spineGrad.addColorStop(0.45, rgba(pal.rimHot, 0.48 * wakeAlpha));
          spineGrad.addColorStop(0.85, rgba([255, 255, 255], 0.88 * wakeAlpha));
          spineGrad.addColorStop(1, rgba([255, 255, 255], 0.96 * wakeAlpha));
          ctx.fillStyle = spineGrad;
          ctx.fill();

          // 3d. Twin delicate curved side slipstream filaments converging toward the meteor tip
          const filGrad = ctx.createLinearGradient(xTail, cy, xHead, cy);
          filGrad.addColorStop(0, rgba(pal.rimMid, 0));
          filGrad.addColorStop(0.45, rgba(pal.rimMid, 0.26 * wakeAlpha));
          filGrad.addColorStop(0.88, rgba(pal.rimHot, 0.52 * wakeAlpha));
          filGrad.addColorStop(1, rgba([255, 255, 255], 0.60 * wakeAlpha));
          ctx.strokeStyle = filGrad;
          ctx.lineWidth = isCompact ? 0.8 : 1.15;
          const ctrlX = lerp(xTail, xHead, 0.56);
          const sideY = h * 0.25;
          ctx.beginPath();
          ctx.moveTo(xTail, cy);
          ctx.quadraticCurveTo(ctrlX, cy - sideY * 0.34, xHead, cy - sideY);
          ctx.moveTo(xTail, cy);
          ctx.quadraticCurveTo(ctrlX, cy + sideY * 0.34, xHead, cy + sideY);
          ctx.stroke();

          // 3e. Restrained inner top & bottom channel wall refraction echo
          const wallGrad = ctx.createLinearGradient(xTail, 0, xHead, 0);
          wallGrad.addColorStop(0, rgba(pal.rimMid, 0));
          wallGrad.addColorStop(0.55, rgba(pal.rimMid, 0.20 * wakeAlpha));
          wallGrad.addColorStop(1, rgba(pal.rimHot, 0.48 * wakeAlpha));
          ctx.strokeStyle = wallGrad;
          ctx.lineWidth = isCompact ? 0.9 : 1.25;
          ctx.beginPath();
          ctx.moveTo(xTail, 0.8);
          ctx.lineTo(xHead, 0.8);
          ctx.moveTo(xTail, h - 0.8);
          ctx.lineTo(xHead, h - 0.8);
          ctx.stroke();

          ctx.restore();
        }
      }

      // 4. Micro-pixel stardust embers shed behind the meteor (unified with dot-matrix LED DNA, continuous tint!)
      const emberRgb = [
        Math.round(lerp(pal.rimHot[0], pal.ledAlt[0], lightMix)),
        Math.round(lerp(pal.rimHot[1], pal.ledAlt[1], lightMix)),
        Math.round(lerp(pal.rimHot[2], pal.ledAlt[2], lightMix))
      ];
      const emberCoreRgb = [
        Math.round(lerp(255, pal.ledCore[0], lightMix)),
        Math.round(lerp(255, pal.ledCore[1], lightMix)),
        Math.round(lerp(255, pal.ledCore[2], lightMix))
      ];
      for (let i = 0; i < emberCount; i++) {
        const e = embers[i];
        if (e.life <= 0) continue;
        const norm = e.life / e.maxLife; // 1 -> 0
        const fade = norm * norm; // silky quadratic fade-out
        const twinkle = 0.72 + 0.28 * Math.sin(timeSec * 14 + e.phase);
        const alpha = fade * twinkle * e.bright * lerp(0.92, 0.62, lightMix);
        if (alpha < 0.015) continue;

        // Soft micro-halo on hero mode
        if (!isCompact && e.size > 1.5) {
          const hr = e.size * 2.6;
          const hg = ctx.createRadialGradient(e.x, e.y, 0.2, e.x, e.y, hr);
          hg.addColorStop(0, rgba(emberRgb, alpha * 0.48));
          hg.addColorStop(1, rgba(emberRgb, 0));
          ctx.fillStyle = hg;
          ctx.fillRect(e.x - hr, e.y - hr, hr * 2, hr * 2);
        }

        // Crisp rounded micro-pixel square
        const s = e.size * (0.55 + 0.45 * norm);
        const hs = s * 0.5;
        ctx.fillStyle = rgba(emberCoreRgb, alpha);
        if (s >= 1.4) {
          traceRoundedRect(ctx, e.x - hs, e.y - hs, s, s, s * 0.24);
          ctx.fill();
        } else {
          ctx.fillRect(e.x - hs, e.y - hs, s, s);
        }
      }

      // 5. Subtle symmetrical top & bottom recessed inner channel vignette
      const edgeH = Math.max(2, h * 0.08);
      const shadeA = lerp(0.24, 0.10, lightMix);
      const topShadow = ctx.createLinearGradient(0, 0, 0, edgeH);
      topShadow.addColorStop(0, `rgba(0,0,0,${shadeA.toFixed(4)})`);
      topShadow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = topShadow;
      ctx.fillRect(0, 0, w, edgeH);

      const botShadow = ctx.createLinearGradient(0, h, 0, h - edgeH);
      botShadow.addColorStop(0, `rgba(0,0,0,${shadeA.toFixed(4)})`);
      botShadow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = botShadow;
      ctx.fillRect(0, h - edgeH, w, edgeH);
    }

    /* -------------------------------------------------------------------
       CANVAS 4: CRISP HAIRLINE PERIMETER BEVEL (ZERO OUTER GLOW OVER-RENDERING)
       ------------------------------------------------------------------- */
    function renderRim(lightMix, pal, breath, focus) {
      const { boxW, boxH, r, rimW, rimH, scale } = geom;
      const ctx = rimCtx;
      ctx.clearRect(0, 0, rimW, rimH);

      const ox = (rimW - boxW) * 0.5;
      const oy = (rimH - boxH) * 0.5;
      const fx = ox + focus.x + 1;
      const fy = oy + focus.y + 1;

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      traceRoundedRect(ctx, ox + 0.5, oy + 0.5, boxW - 1, boxH - 1, r);

      // Continuous subtle base hairline border (zero flicker on backdrop-filter)
      ctx.strokeStyle = rgba(pal.rimHot, lerp(0.16, 0.56, lightMix));
      ctx.lineWidth = 1;
      ctx.stroke();

      // Single crisp specular edge glint strictly on the 1px bevel (zero wide halo bleed)
      const glintR = isCompact ? Math.max(16, boxH * 1.15) : Math.max(24, 78 * scale * breath);
      const glint = ctx.createRadialGradient(fx, fy, 1, fx, fy, glintR);
      glint.addColorStop(0, rgba([255, 255, 255], lerp(0.46, 0.58, lightMix) * breath));
      glint.addColorStop(0.55, rgba(pal.rimHot, lerp(0.24, 0.28, lightMix)));
      glint.addColorStop(1, rgba(pal.rimMid, 0));
      ctx.strokeStyle = glint;
      ctx.lineWidth = isCompact ? 1.05 : 1.3;
      ctx.stroke();

      ctx.restore();
    }

    /* -------------------------------------------------------------------
       CANVAS 3: FROSTED GLASS THUMB + LIQUID-LIGHT SHEEN + DOT-MATRIX LEDs
       ------------------------------------------------------------------- */
    function renderThumb(p, lightMix, pal, breath, timeSec, fadeInfo, flow) {
      const { thumb: T, thumbR: R, scale } = geom;
      const ctx = thumbCtx;
      ctx.clearRect(0, 0, T, T);

      const litX = lerp(T * 0.12, T * 0.88, p);
      const litY = T * 0.50;
      const sideX = lerp(0, T, p);
      const sheen = flow ? flow.sheen : 0;
      const flowPh = flow ? flow.phase : timeSec * 0.7;

      const aTop = clamp(cachedGlassAlpha * 0.72 + 0.42, 0.52, 0.94);
      const aMid = clamp(cachedGlassAlpha * 0.72 + 0.46, 0.56, 0.96);
      const aBot = clamp(cachedGlassAlpha * 0.72 + 0.50, 0.60, 0.98);

      ctx.save();
      traceRoundedRect(ctx, 0, 0, T, T, R);
      ctx.clip();

      // Layer 1: Translucent frosted-glass base body
      const baseGrad = ctx.createLinearGradient(lerp(0, T, p), 0, lerp(T, 0, p), T);
      baseGrad.addColorStop(0, rgba(pal.glassTop, aTop));
      baseGrad.addColorStop(0.50, rgba(pal.glassMid, aMid));
      baseGrad.addColorStop(1, rgba(pal.glassBot, aBot));
      ctx.fillStyle = baseGrad;
      ctx.fillRect(0, 0, T, T);

      // Layer 2: Symmetrical deep frosted subsurface scattering
      const deepScatter = ctx.createRadialGradient(litX, litY, 2, litX, litY, T * 0.88);
      deepScatter.addColorStop(0, rgba(pal.glassHot, lerp(0.56, 0.46, lightMix) * breath));
      deepScatter.addColorStop(0.35, rgba(pal.glassScatter, lerp(0.36, 0.26, lightMix) * breath));
      deepScatter.addColorStop(0.70, rgba(pal.glassScatter, 0.11 * breath));
      deepScatter.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.fillStyle = deepScatter;
      ctx.fillRect(0, 0, T, T);

      // Layer 2.5: Internal liquid-light dual fluid pools + dedicated silky diagonal sweep
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      const fluidAmp = lerp(0.30, 0.22, lightMix) + sheen * lerp(0.52, 0.36, lightMix);

      const fx1 = T * (0.50 + 0.30 * Math.cos(flowPh));
      const fy1 = T * (0.50 + 0.26 * Math.sin(flowPh * 1.15));
      const fGrad1 = ctx.createRadialGradient(fx1, fy1, 1, fx1, fy1, T * 0.66);
      fGrad1.addColorStop(0, rgba(pal.rimHot, 0.40 * fluidAmp));
      fGrad1.addColorStop(0.42, rgba(pal.rimMid, 0.18 * fluidAmp));
      fGrad1.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.fillStyle = fGrad1;
      ctx.fillRect(0, 0, T, T);

      const fx2 = T * (0.50 - 0.28 * Math.sin(flowPh * 0.82));
      const fy2 = T * (0.50 + 0.24 * Math.cos(flowPh * 0.90));
      const fGrad2 = ctx.createRadialGradient(fx2, fy2, 1, fx2, fy2, T * 0.56);
      fGrad2.addColorStop(0, rgba(pal.glassHot, 0.32 * fluidAmp));
      fGrad2.addColorStop(0.50, rgba(pal.auraMid, 0.14 * fluidAmp));
      fGrad2.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.fillStyle = fGrad2;
      ctx.fillRect(0, 0, T, T);

      // Single-pass silky diagonal liquid-light refraction wave during transitions / drags
      if (flow && flow.sweep > -1.4 && sheen > 0.008) {
        const sweepCenter = flow.sweep * T;
        const bandHalf = T * 0.52;
        const sx0 = sweepCenter - bandHalf;
        const sy0 = -T * 0.18;
        const sx1 = sweepCenter + bandHalf;
        const sy1 = T * 1.18;
        const sa = sheen * lerp(0.68, 0.52, lightMix);
        const sweepGrad = ctx.createLinearGradient(sx0, sy0, sx1, sy1);
        sweepGrad.addColorStop(0, rgba(pal.glassScatter, 0));
        sweepGrad.addColorStop(0.24, rgba(pal.glassScatter, 0.16 * sa));
        sweepGrad.addColorStop(0.44, rgba(pal.rimMid, 0.38 * sa));
        sweepGrad.addColorStop(0.50, rgba([255, 255, 255], 0.78 * sa));
        sweepGrad.addColorStop(0.56, rgba(pal.rimMid, 0.36 * sa));
        sweepGrad.addColorStop(0.76, rgba(pal.glassScatter, 0.14 * sa));
        sweepGrad.addColorStop(1, rgba(pal.glassScatter, 0));
        ctx.fillStyle = sweepGrad;
        ctx.fillRect(0, 0, T, T);
      }
      ctx.restore();

      // Layer 3: Soft milky caustic edge sheen + balanced subtle top/bottom glass reflection
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const hotCaustic = ctx.createRadialGradient(sideX, T * 0.50, 1, sideX, T * 0.50, T * 0.58);
      hotCaustic.addColorStop(0, rgba(pal.glassHot, lerp(0.48, 0.38, lightMix) * breath));
      hotCaustic.addColorStop(0.45, rgba(pal.glassScatter, 0.18 * breath));
      hotCaustic.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.fillStyle = hotCaustic;
      ctx.fillRect(0, 0, T, T);

      const topSheen = ctx.createLinearGradient(0, 0, 0, T * 0.36);
      topSheen.addColorStop(0, `rgba(255, 255, 255, ${lerp(0.11, 0.24, lightMix).toFixed(4)})`);
      topSheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = topSheen;
      ctx.fillRect(0, 0, T, T * 0.38);
      ctx.restore();

      // Layer 4: Inner glass slab caustic bevel (continuous, zero blend pop)
      ctx.save();
      const inset = Math.max(1.2, 2.2 * scale);
      traceRoundedRect(ctx, inset, inset, T - inset * 2, T - inset * 2, Math.max(2, R - inset));
      const innerBevelGrad = ctx.createRadialGradient(litX, litY, 2, litX, litY, T * 0.78);
      innerBevelGrad.addColorStop(0, rgba(pal.glassHot, lerp(0.50, 0.58, lightMix) * breath));
      innerBevelGrad.addColorStop(0.55, rgba(pal.glassScatter, 0.20 * breath));
      innerBevelGrad.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.strokeStyle = innerBevelGrad;
      ctx.lineWidth = Math.max(1.4, 4.2 * scale);
      ctx.stroke();
      ctx.restore();

      // Layer 5: Static procedural bead-blasted frost grain texture
      ctx.save();
      ctx.globalAlpha = 0.045;
      ctx.globalCompositeOperation = 'overlay';
      ctx.drawImage(frostGrainCanvas, 0, 0, T, T);
      ctx.restore();

      // Layer 6: Pointer-tracking hover specular sheen
      if (hover.alpha > 0.005) {
        const sp = ctx.createRadialGradient(hover.x, hover.y, 1, hover.x, hover.y, T * 0.54);
        sp.addColorStop(0, `rgba(255, 255, 255, ${(0.18 * hover.alpha).toFixed(4)})`);
        sp.addColorStop(0.5, `rgba(255, 255, 255, ${(0.04 * hover.alpha).toFixed(4)})`);
        sp.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = sp;
        ctx.fillRect(0, 0, T, T);
      }

      // Layer 7: HiDPI Dot-Matrix LED Display (crossfade + liquid shimmer coupling)
      renderDotMatrix(ctx, T, p, lightMix, pal, timeSec, fadeInfo, flow);

      // Layer 8: Ultra-fine hairline glass rim bevel + traveling liquid rim flow
      traceRoundedRect(ctx, 0.65, 0.65, T - 1.3, T - 1.3, Math.max(2, R - 0.65));
      const baseRimGrad = ctx.createLinearGradient(0, 0, T, T);
      baseRimGrad.addColorStop(0, `rgba(255, 255, 255, ${pal.rimBaseTop.toFixed(3)})`);
      baseRimGrad.addColorStop(0.5, `rgba(255, 255, 255, ${pal.rimBaseMid.toFixed(3)})`);
      baseRimGrad.addColorStop(1, `rgba(255, 255, 255, ${pal.rimBaseBot.toFixed(3)})`);
      ctx.strokeStyle = baseRimGrad;
      ctx.lineWidth = isCompact ? 1.0 : 1.15;
      ctx.stroke();

      const litRimGrad = ctx.createRadialGradient(litX, litY, 2, litX, litY, T * 0.80);
      litRimGrad.addColorStop(0, rgba([255, 255, 255], 0.92));
      litRimGrad.addColorStop(0.46, rgba(pal.glassRim, 0.66));
      litRimGrad.addColorStop(0.82, rgba(pal.glassScatter, 0.20));
      litRimGrad.addColorStop(1, rgba(pal.glassScatter, 0));
      ctx.strokeStyle = litRimGrad;
      ctx.lineWidth = isCompact ? 1.2 : 1.55;
      ctx.stroke();

      // Traveling liquid-light highlight orbiting smoothly along the inner edge
      const rimOrbX = T * 0.5 + Math.cos(flowPh * 1.4) * (T * 0.48);
      const rimOrbY = T * 0.5 + Math.sin(flowPh * 1.4) * (T * 0.48);
      const rimFlowAlpha = 0.24 + 0.72 * sheen;
      const flowRimGrad = ctx.createRadialGradient(rimOrbX, rimOrbY, 1, rimOrbX, rimOrbY, T * 0.58);
      flowRimGrad.addColorStop(0, rgba([255, 255, 255], rimFlowAlpha));
      flowRimGrad.addColorStop(0.45, rgba(pal.rimMid, rimFlowAlpha * 0.52));
      flowRimGrad.addColorStop(1, rgba(pal.rimOuter, 0));
      ctx.strokeStyle = flowRimGrad;
      ctx.lineWidth = isCompact ? 1.35 : 1.9;
      ctx.stroke();

      ctx.restore();
    }

    function evalStateLum(pv, nLum, gLum, dLum, delay) {
      if (pv <= 0.5) {
        return lerp(nLum, gLum, smoothstep(delay, delay + 0.56, pv * 2));
      }
      return lerp(gLum, dLum, smoothstep(delay, delay + 0.56, (pv - 0.5) * 2));
    }

    function drawBloomForP(ctx, pv, bx, by, bloomSize, alpha) {
      if (alpha <= 0.004) return;
      if (pv <= 0.5) {
        const blend = pv * 2;
        if (blend < 0.98) { ctx.globalAlpha = alpha * (1 - blend); ctx.drawImage(blackLedSprite, bx, by, bloomSize, bloomSize); }
        if (blend > 0.02) { ctx.globalAlpha = alpha * blend; ctx.drawImage(grayLedSprite, bx, by, bloomSize, bloomSize); }
      } else {
        const blend = (pv - 0.5) * 2;
        if (blend < 0.98) { ctx.globalAlpha = alpha * (1 - blend); ctx.drawImage(grayLedSprite, bx, by, bloomSize, bloomSize); }
        if (blend > 0.02) { ctx.globalAlpha = alpha * blend; ctx.drawImage(whiteLedSprite, bx, by, bloomSize, bloomSize); }
      }
    }

    function renderDotMatrix(ctx, T, p, lightMix, pal, timeSec, fadeInfo, flow) {
      const spanRatio = isCompact ? 0.64 : 0.54;
      const span = T * spanRatio;
      const step = span / gridSize;
      const pixelSize = step * 0.73;
      const origin = (T - ((gridSize - 1) * step + pixelSize)) * 0.5;
      const sheen = flow ? flow.sheen : 0;
      const sweepAxis = flow ? flow.sweep : -99;
      const hasSweep = sheen > 0.008 && sweepAxis > -1.4;

      // Pass A: Faint unlit hardware LED matrix dots (with crystal glint when sweep passes)
      const unlitBaseA = pal.dotUnlit[3];
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const x = origin + cell.col * step;
        const y = origin + cell.row * step;
        let a = unlitBaseA * cell.unlitScale;
        if (hasSweep) {
          const diag = (x + y * 0.24) / T;
          const glint = Math.max(0, 1 - Math.abs(diag - sweepAxis) / 0.30);
          a += glint * glint * sheen * 0.11 * cell.unlitScale;
        }
        ctx.fillStyle = rgba(pal.dotUnlit, a);
        ctx.fillRect(x + 0.15, y + 0.15, Math.max(0.7, pixelSize - 0.3), Math.max(0.7, pixelSize - 0.3));
      }

      // Pass B: Pre-baked bloom behind bright LEDs (continuous source-over -> zero pop!)
      const bloomSize = pixelSize * 4.4;
      const bloomOffset = (bloomSize - pixelSize) * 0.5;
      const bloomDamp = lerp(1.0, 0.52, lightMix);

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
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
        let domP = p;
        if (fadeInfo) {
          const fromLum = evalStateLum(fadeInfo.fromP, nLum, gLum, dLum, cell.morphDelay) * fadeInfo.outAlpha;
          const toLum = evalStateLum(fadeInfo.toP, nLum, gLum, dLum, cell.morphDelay) * fadeInfo.inAlpha;
          lum = clamp(fromLum + toLum, 0, 1);
          domP = toLum >= fromLum ? fadeInfo.toP : fadeInfo.fromP;
          cell._fromLum = fromLum;
          cell._toLum = toLum;
        } else {
          lum = evalStateLum(p, nLum, gLum, dLum, cell.morphDelay);
        }

        if (hasSweep && lum > 0.05) {
          const diag = ((origin + cell.col * step) + (origin + cell.row * step) * 0.24) / T;
          const glint = Math.max(0, 1 - Math.abs(diag - sweepAxis) / 0.30);
          lum = clamp(lum + glint * glint * sheen * 0.22, 0, 1);
        }
        cell._lum = lum;
        cell._domP = domP;

        if (!isCompact && lum > 0.48) {
          const bx = origin + cell.col * step - bloomOffset;
          const by = origin + cell.row * step - bloomOffset;
          const glowIntensity = (lum - 0.42) * 0.52 * bloomDamp;
          if (fadeInfo) {
            const total = cell._fromLum + cell._toLum || 1;
            drawBloomForP(ctx, fadeInfo.fromP, bx, by, bloomSize, glowIntensity * (cell._fromLum / total));
            drawBloomForP(ctx, fadeInfo.toP, bx, by, bloomSize, glowIntensity * (cell._toLum / total));
          } else {
            drawBloomForP(ctx, p, bx, by, bloomSize, glowIntensity);
          }
        }
      }
      ctx.restore();

      // Pass C: Crisp individual rounded micro-LED squares
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const lum = cell._lum;
        if (lum < 0.012) continue;
        const x = origin + cell.col * step;
        const y = origin + cell.row * step;
        const altP = cell._domP;
        const isAlt = (altP < 0.35 && cell.nightKind === 2) || (altP >= 0.35 && altP < 0.72 && cell.grayKind === 2) || (altP >= 0.72 && cell.dayKind === 3);
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

    // Velvety critically-damped liquid spring (zero bounce, silky ~380ms glide)
    const SPRING_K = 148;
    const SPRING_C = 2 * Math.sqrt(SPRING_K);

    const inst = {
      state, hover, syncTarget, updateSoundBtn,
      step(dt, timeSec, breath) {
        if (stage.offsetParent === null) return;
        if (!geom.w || !geom.h) measureAndSize();
        if (!geom.w || !geom.h) return;

        // 1. Step critically-damped liquid spring (clamped cleanly to [0, 1] so fast flicks never over-clip border)
        if (!state.isDragging) {
          const disp = state.target - state.p;
          const accel = disp * SPRING_K - state.vel * SPRING_C;
          state.vel += accel * dt;
          state.p += state.vel * dt;
          if (state.p < 0) { state.p = 0; state.vel = 0; }
          else if (state.p > 1) { state.p = 1; state.vel = 0; }
          if (Math.abs(disp) < 0.0002 && Math.abs(state.vel) < 0.0004) {
            state.p = state.target;
            state.vel = 0;
          }
        }

        // Smooth lagging meteor tail inside the track border (~0.6s silky afterglow)
        const trailRate = 1 - Math.exp(-3.6 * dt);
        state.trailP = lerp(state.trailP, clamp(state.p, 0, 1), trailRate);
        if (Math.abs(state.p - state.trailP) < 0.0005) state.trailP = clamp(state.p, 0, 1);

        // 2. Hover specular & 3D micro-tilt
        const hoverRate = 1 - Math.exp(-12 * dt);
        hover.alpha = lerp(hover.alpha, hover.targetAlpha, hoverRate);
        if (state.isDragging) {
          hover.rx = 0; hover.ry = 0;
        } else {
          hover.rx = lerp(hover.rx, hover.targetRx, hoverRate);
          hover.ry = lerp(hover.ry, hover.targetRy, hoverRate);
        }

        // 3. Flush GPU-locked translation (top:0; bottom:0 -> 0px vertical gap!)
        const pClamped = clamp(state.p, 0, 1);
        const thumbX = pClamped * geom.travel;
        thumbMover.style.transform = `translate3d(${thumbX.toFixed(3)}px, 0, 0)`;
        if (Math.abs(hover.rx) > 0.01 || Math.abs(hover.ry) > 0.01) {
          thumbBody.style.transform = `perspective(640px) rotateX(${hover.rx.toFixed(3)}deg) rotateY(${hover.ry.toFixed(3)}deg)`;
        } else {
          thumbBody.style.transform = 'none';
        }

        // 4. Proximity-based continuous slot label fade (silky reveal/hide as thumb glides over)
        const thumbCenterNorm = (thumbX + geom.thumb * 0.5) / geom.w;
        for (let i = 0; i < slotEls.length; i++) {
          const slotCenter = (i + 0.5) / 3;
          const dist = Math.abs(thumbCenterNorm - slotCenter);
          const slotOp = smoothstep(0.11, 0.24, dist);
          slotEls[i].style.opacity = slotOp.toFixed(3);
        }

        // 5. Quintic crossfade dissolve envelope (zero velocity/acceleration jump)
        const useCrossfade = document.documentElement.dataset.dmTransition !== 'morph';
        let fadeInfo = null;
        if (state.fadeActive && useCrossfade) {
          const fadeDuration = parseFloat(document.documentElement.dataset.dmFadeDuration) || 0.52;
          state.fadeProgress = Math.min(1, state.fadeProgress + dt / fadeDuration);
          if (state.fadeProgress >= 1) {
            state.fadeActive = false;
          } else {
            const u = smootherstep(0, 1, state.fadeProgress);
            fadeInfo = {
              fromP: state.fadeFromP,
              toP: state.fadeToP,
              u,
              outAlpha: Math.pow(1 - smoothstep(0.0, 0.62, u), 1.35),
              inAlpha: Math.pow(smoothstep(0.24, 1.0, u), 1.25)
            };
          }
        }

        // 6. Cohesive liquid-light sheen + meteor stardust emission
        const dp = state.p - state.prevP;
        state.prevP = state.p;
        if (Math.abs(dp) > 0.0003) state.flowDir = dp >= 0 ? 1 : -1;

        // Emit micro-pixel meteor sparks behind the moving thumb & step existing sparks
        const absDp = Math.abs(dp);
        if (absDp > 0.0012) {
          const speedScale = Math.min(1.5, (absDp / Math.max(dt, 0.008)) * 0.45);
          emberAccum += absDp * (isCompact ? 18 : 34);
          const emitX = pClamped * geom.travel + geom.thumb * 0.5 - state.flowDir * geom.thumb * 0.34;
          while (emberAccum >= 1) {
            emberAccum -= 1;
            spawnMeteorEmber(emitX, geom.h * 0.5, geom.h, state.flowDir, speedScale);
          }
        }
        const damp = Math.exp(-3.2 * dt);
        for (let i = 0; i < emberCount; i++) {
          const e = embers[i];
          if (e.life <= 0) continue;
          e.life -= dt;
          e.x += e.vx * dt;
          e.y += e.vy * dt;
          e.vx *= damp;
          e.vy *= damp;
        }

        const dragSpeed = state.isDragging ? Math.min(1, (absDp / Math.max(dt, 0.008)) * 0.55) : 0;
        const springSpeed = Math.min(1, Math.abs(state.vel) * 0.34);
        const targetEnergy = Math.max(dragSpeed, springSpeed);
        const envRate = targetEnergy > state.flowEnergy ? 1 - Math.exp(-14 * dt) : 1 - Math.exp(-4.2 * dt);
        state.flowEnergy = lerp(state.flowEnergy, targetEnergy, envRate);
        state.flowPhase += dt * (0.55 + state.flowEnergy * 3.6 + (fadeInfo ? 2.4 * Math.sin(fadeInfo.u * Math.PI) : 0)) * state.flowDir;

        let sweep = -99;
        let sheen = state.flowEnergy;
        if (fadeInfo) {
          // Single-pass directional silk light wave gliding cleanly from -0.45 -> 1.45
          const env = Math.sin(fadeInfo.u * Math.PI);
          sheen = Math.max(sheen, env);
          sweep = state.fadeDir >= 0
            ? lerp(-0.45, 1.45, fadeInfo.u)
            : lerp(1.45, -0.45, fadeInfo.u);
        } else if (state.flowEnergy > 0.015) {
          const raw = state.flowPhase * 0.50 + pClamped * 1.4;
          sweep = ((((raw % 2.2) + 2.2) % 2.2) - 0.6);
        }
        const flow = { energy: state.flowEnergy, sheen, phase: state.flowPhase, dir: state.flowDir, sweep };

        // 7. Continuous unified lighting & 4-canvas lockstep render (ZERO discrete jumps!)
        const pal = fadeInfo
          ? lerpPalettes(samplePalette(fadeInfo.fromP), samplePalette(fadeInfo.toP), fadeInfo.u)
          : samplePalette(pClamped);
        const matP = fadeInfo ? lerp(fadeInfo.fromP, fadeInfo.toP, fadeInfo.u) : pClamped;
        const lightMix = smoothstep(0.42, 0.96, matP);
        const focus = getPlasmaFocus(pClamped);
        const breathFade = fadeInfo ? breath * (1 - 0.10 * Math.sin(fadeInfo.u * Math.PI)) : breath;

        renderAura(lightMix, pal, breathFade, focus);
        renderTrackFloor(pClamped, state.trailP, lightMix, pal, breathFade, focus, timeSec);
        renderThumb(pClamped, lightMix, pal, breathFade, timeSec, fadeInfo, flow);
        renderRim(lightMix, pal, breathFade, focus);
      }
    };
    instances.add(inst);
  }

  let lastFrameTime = performance.now();
  function frame(now) {
    const dt = Math.min((now - lastFrameTime) / 1000, 0.033);
    lastFrameTime = now;
    const timeSec = now * 0.001;
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

    new MutationObserver(() => {
      refreshGlassAlpha();
      const mat = document.documentElement.dataset.material;
      const p = mat === 'gray' ? 0.5 : mat === 'white' ? 1 : 0;
      for (const inst of instances) inst.syncTarget(p);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-material', 'data-scheme', 'data-theme', 'style'] });

    new MutationObserver(scanHosts).observe(document.body, { childList: true });
    document.addEventListener('studio-material', refreshGlassAlpha);

    lastFrameTime = performance.now();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll, { once: true });
  else mountAll();
})();
