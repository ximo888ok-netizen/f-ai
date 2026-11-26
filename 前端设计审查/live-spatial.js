// All faces share one coordinate system. The photograph stays a single, undistorted texture.
function solid(className, front) {
  const block = document.createElement('div');
  block.className = 'relief-solid ' + className;
  for (const side of ['front', 'back', 'left', 'right', 'top', 'bottom']) {
    const face = document.createElement('div');
    face.className = 'relief-face relief-' + side;
    if (side === 'front' && front) face.append(front);
    else face.setAttribute('aria-hidden', 'true');
    block.append(face);
  }
  return block;
}

export function mountDisplay(container, signal) {
  const photo = container.querySelector('img');
  if (signal.aborted || container.classList.contains('spatial-ready')) return;
  if (!photo && !container.hasAttribute('data-empty-display')) return;
  const world = document.createElement('div');
  world.className = 'relief-world';
  const floor = document.createElement('div');
  floor.className = 'relief-floor';
  floor.setAttribute('aria-hidden', 'true');
  const pedestal = solid('relief-pedestal');
  pedestal.setAttribute('aria-hidden', 'true');
  world.append(floor, pedestal);
  if (photo) world.append(solid('relief-sample', photo));
  container.replaceChildren(world);
  container.classList.add('spatial-ready');

  const target = container.closest('.live-desk-stage') || container;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, clientX = 0, clientY = 0;
  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    container.style.removeProperty('--pointer-turn');
    container.style.removeProperty('--pointer-pitch');
  }
  function move() {
    frame = 0;
    if (reduce.matches || document.hidden || document.documentElement.dataset.motion === 'off') return reset();
    const bounds = target.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const normalize = value => Math.max(-1, Math.min(1, 2 * value - 1));
    const x = normalize((clientX - bounds.left) / bounds.width);
    const y = normalize((clientY - bounds.top) / bounds.height);
    container.style.setProperty('--pointer-turn', (x * 15) + 'deg');
    container.style.setProperty('--pointer-pitch', (-y * 7) + 'deg');
  }
  target.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || reduce.matches || document.documentElement.dataset.motion === 'off') return;
    clientX = event.clientX;
    clientY = event.clientY;
    if (!frame) frame = requestAnimationFrame(move);
  }, { passive: true, signal });
  target.addEventListener('pointerleave', reset, { signal });
  document.addEventListener('studio-motion', reset, { signal });
  document.addEventListener('visibilitychange', reset, { signal });
  reduce.addEventListener('change', reset, { signal });
  signal.addEventListener('abort', reset, { once: true });
}

const glassVertex = `#version 300 es
precision highp float;
const vec2 pos[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = pos[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const glassFragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uMouseAlpha;
uniform vec3 uThemeWeights;
uniform vec3 uBaseDeep;
uniform vec3 uBaseMid;
uniform vec3 uHighlight;
uniform vec3 uCaustic;
uniform float uSpecular;
uniform float uRidgeDark;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.52;
  mat2 rot = mat2(0.82, -0.57, 0.57, 0.82);
  for (int i = 0; i < 4; i++) {
    v += amp * noise(p);
    p = rot * p * 1.88 + vec2(3.1, 1.7);
    amp *= 0.48;
  }
  return v;
}
float glassHeight(vec2 uv, vec2 mouseUv, float t) {
  vec2 p = uv * 1.48;
  vec2 q = vec2(
    fbm(p + vec2(t * 0.24, -t * 0.18)),
    fbm(p + vec2(-t * 0.19 + 4.2, t * 0.22 + 1.8))
  );
  vec2 r = vec2(
    fbm(p + 1.72 * q + vec2(1.7, 9.2) + t * 0.14),
    fbm(p + 1.72 * q + vec2(8.3, 2.8) - t * 0.12)
  );
  float ribbon1 = sin(p.x * 2.15 + p.y * 1.38 + q.x * 3.8 + t * 0.44) * 0.5 + 0.5;
  float ribbon2 = cos(p.x * 1.35 - p.y * 2.28 + r.y * 3.4 - t * 0.36) * 0.5 + 0.5;
  float organic = fbm(p + 1.62 * r);
  return mix(organic, ribbon1 * 0.58 + ribbon2 * 0.42, 0.60);
}
void main() {
  vec2 aspect = vec2(uRes.x / max(1.0, uRes.y), 1.0);
  vec2 uv = (vUv - 0.5) * aspect + 0.5;
  vec2 mouseUv = (uMouse - 0.5) * aspect + 0.5;
  float h  = glassHeight(uv, mouseUv, uTime);
  float eps = 0.0082;
  float hx = glassHeight(uv + vec2(eps, 0.0), mouseUv, uTime);
  float hy = glassHeight(uv + vec2(0.0, eps), mouseUv, uTime);
  vec3 N = normalize(vec3((h - hx) / eps * 0.34, (h - hy) / eps * 0.34, 1.0));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L1 = normalize(vec3(-0.42 + 0.22 * sin(uTime * 0.32), 0.62 + 0.12 * cos(uTime * 0.26), 0.84));
  vec3 L2 = normalize(vec3(0.58 - 0.18 * cos(uTime * 0.24), -0.42 + 0.18 * sin(uTime * 0.28), 0.72));
  float diff1 = max(dot(N, L1), 0.0);
  float diff2 = max(dot(N, L2), 0.0);
  vec3 H1 = normalize(L1 + V);
  vec3 H2 = normalize(L2 + V);
  float specBroad = pow(max(dot(N, H1), 0.0), 12.0);
  float specSharp = pow(max(dot(N, H1), 0.0), 42.0);
  float specRim   = pow(max(dot(N, H2), 0.0), 20.0);
  float slope = length(N.xy);
  float causticBand = smoothstep(0.11, 0.44, slope) * (0.52 + 0.48 * sin(h * 11.5 + uTime * 0.62));
  vec3 col = mix(uBaseDeep, uBaseMid, smoothstep(0.16, 0.86, h * 0.72 + diff1 * 0.34));
  float hiWeight = mix(0.62, 0.38, uThemeWeights.x);
  col = mix(col, uHighlight, smoothstep(0.30, 0.92, diff1 * 0.66 + diff2 * 0.26) * hiWeight);
  col *= (1.0 - uRidgeDark * (1.0 - smoothstep(0.08, 0.58, h)));
  vec3 specAdd = uHighlight * (specBroad * uSpecular * 0.58 + specRim * uSpecular * 0.28)
               + uCaustic * (specSharp * uSpecular * 0.62 + causticBand * uSpecular * 0.28);
  // Soft highlight compression prevents pure-white clipping/overexposure in White glass theme
  col = col + specAdd * mix(vec3(1.0), max(vec3(0.0), vec3(0.92) - col), uThemeWeights.x);

  float vig = (1.0 - smoothstep(0.25, 1.38, length(vUv - 0.5) * 1.45));
  col = mix(uBaseDeep * 0.96, col, 0.86 + 0.14 * vig);
  // Gentle shoulder cap for White theme so luminance stays in serene studio silver range (never clipped pure white)
  vec3 softWhite = min(col, vec3(0.84) + (col - vec3(0.84)) * 0.35);
  col = mix(col, max(col * 0.0, softWhite), uThemeWeights.x * step(vec3(0.84), col));
  float dither = (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  fragColor = vec4(clamp(col + dither, 0.0, 1.0), 1.0);
}`;

/* Paint the optical field smoothly via WebGL2 with an automatic Canvas 2D fluid fallback. */
export function mountGlassField(host) {
  if (!host) return;
  const root = document.documentElement;
  const canvas = host.querySelector('canvas') ?? document.createElement('canvas');
  host.prepend(canvas);
  const colors = {
    white: [[.685,.722,.765],[.758,.790,.826],[.824,.850,.878],[.865,.886,.910],.14,.12],
    gray:  [[.152,.172,.202],[.272,.302,.344],[.555,.600,.660],[.810,.848,.900],.52,.24],
    black: [[.024,.032,.046],[.078,.098,.128],[.255,.300,.365],[.545,.612,.698],.54,.28],
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const forced = matchMedia('(forced-colors: active)');
  const themeKey = () => root.dataset.scheme === 'light' ? 'white' : root.dataset.theme === 'noir' ? 'gray' : 'black';
  const targetPalette = () => colors[themeKey()];
  const targetWeights = () => {
    const k = themeKey();
    return k === 'white' ? [1, 0, 0] : k === 'gray' ? [0, 1, 0] : [0, 0, 1];
  };
  const clonePal = c => [[...c[0]], [...c[1]], [...c[2]], [...c[3]], c[4], c[5]];
  let current = clonePal(targetPalette());
  let weights = targetWeights();
  let frame = 0, previous = 0, time = 18, tx = .5, ty = .5, x = .5, y = .5, tMouseAlpha = 0, mouseAlpha = 0;

  let gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
  let program = null, uniforms = null;
  if (gl) {
    program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, glassVertex], [gl.FRAGMENT_SHADER, glassFragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      program = null;
      gl = null;
    } else {
      gl.useProgram(program);
      uniforms = Object.fromEntries(['uRes','uTime','uMouse','uMouseAlpha','uThemeWeights','uBaseDeep','uBaseMid','uHighlight','uCaustic','uSpecular','uRidgeDark']
        .map(name => [name, gl.getUniformLocation(program, name)]));
    }
  }
  const ctx2d = !gl ? canvas.getContext('2d', { alpha: false }) : null;
  if (!gl && !ctx2d) return;

  const rgbCss = (v, a = 1) => `rgba(${Math.round(v[0] * 255)},${Math.round(v[1] * 255)},${Math.round(v[2] * 255)},${a})`;
  function draw2d(w, h) {
    const base = ctx2d.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, rgbCss(current[0]));
    base.addColorStop(0.52, rgbCss(current[1]));
    base.addColorStop(1, rgbCss(current[0]));
    ctx2d.fillStyle = base;
    ctx2d.fillRect(0, 0, w, h);
    const blobs = [
      [0.30 + 0.20 * Math.sin(time * 0.42), 0.28 + 0.16 * Math.cos(time * 0.34), 0.56, current[2], 0.52],
      [0.72 + 0.18 * Math.cos(time * 0.36), 0.66 + 0.18 * Math.sin(time * 0.40), 0.60, current[3], 0.36],
    ];
    for (const [bx, by, rad, col, alpha] of blobs) {
      const cx = bx * w, cy = by * h, r = Math.max(w, h) * rad;
      const g = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, rgbCss(col, alpha));
      g.addColorStop(0.55, rgbCss(current[1], alpha * 0.35));
      g.addColorStop(1, rgbCss(col, 0));
      ctx2d.fillStyle = g;
      ctx2d.fillRect(0, 0, w, h);
    }
  }

  function readSpeed() {
    const raw = root.style.getPropertyValue('--flow-speed').trim();
    const parsed = raw === '' ? 1 : Number(raw);
    return Number.isFinite(parsed) ? parsed : 1;
  }

  function draw(now) {
    frame = 0;
    const lost = gl ? gl.isContextLost() : false;
    const visible = !document.hidden && !root.hasAttribute('data-custom-wallpaper') && !forced.matches && !lost;
    canvas.hidden = !visible;
    if (!visible) return;
    const speed = readSpeed();
    const moving = root.dataset.motion !== 'off' && speed > 0;
    const motionScale = reduced.matches ? 0.30 : 1.0;
    const target = targetPalette();
    const tw = targetWeights();
    let maxDiff = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) maxDiff = Math.max(maxDiff, Math.abs(target[i][j] - current[i][j]));
    maxDiff = Math.max(maxDiff, Math.abs(target[4] - current[4]), Math.abs(target[5] - current[5]),
      Math.abs(tw[0] - weights[0]), Math.abs(tw[1] - weights[1]), Math.abs(tw[2] - weights[2]),
      Math.abs(tMouseAlpha - mouseAlpha), Math.hypot(tx - x, ty - y));
    const blending = maxDiff > 0.002 && !reduced.matches;
    const dt = previous ? Math.min(.08, Math.max(.004, (now - previous) / 1000)) : 0.016;
    if (moving && previous) time += dt * 0.66 * speed * motionScale;
    previous = now;
    const ease = 1 - Math.exp(-10.5 * dt);
    x += (tx - x) * ease;
    y += (ty - y) * ease;
    mouseAlpha += (tMouseAlpha - mouseAlpha) * (1 - Math.exp(-7.5 * dt));
    const rate = blending ? (1 - Math.exp(-6.2 * dt)) : 1;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) current[i][j] += (target[i][j] - current[i][j]) * rate;
    for (let i = 0; i < 3; i++) weights[i] += (tw[i] - weights[i]) * rate;
    current[4] += (target[4] - current[4]) * rate;
    current[5] += (target[5] - current[5]) * rate;
    const scale = gl ? Math.min(.62, 1024 / Math.max(1, innerWidth)) : Math.min(.38, 640 / Math.max(1, innerWidth));
    const width = Math.max(1, Math.round(innerWidth * scale)), height = Math.max(1, Math.round(innerHeight * scale));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (gl) {
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uniforms.uRes, width, height);
      gl.uniform1f(uniforms.uTime, time);
      gl.uniform2f(uniforms.uMouse, x, y);
      gl.uniform1f(uniforms.uMouseAlpha, mouseAlpha);
      gl.uniform3fv(uniforms.uThemeWeights, weights);
      for (const [i, name] of ['uBaseDeep','uBaseMid','uHighlight','uCaustic'].entries()) gl.uniform3fv(uniforms[name], current[i]);
      gl.uniform1f(uniforms.uSpecular, current[4]);
      gl.uniform1f(uniforms.uRidgeDark, current[5]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (ctx2d) {
      draw2d(width, height);
    }
    if (moving || blending) frame = requestAnimationFrame(draw);
  }
  function refresh() {
    cancelAnimationFrame(frame);
    previous = 0;
    frame = requestAnimationFrame(draw);
  }
  window.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return;
    tx = event.clientX / Math.max(1, innerWidth);
    ty = 1 - event.clientY / Math.max(1, innerHeight);
    tMouseAlpha = 1;
    if (!frame) frame = requestAnimationFrame(draw);
  }, { passive: true });
  root.addEventListener('pointerleave', () => {
    tMouseAlpha = 0;
    if (!frame) frame = requestAnimationFrame(draw);
  });
  window.addEventListener('blur', () => { tMouseAlpha = 0; });
  window.addEventListener('resize', refresh);
  document.addEventListener('visibilitychange', refresh);
  document.addEventListener('studio-material', refresh);
  reduced.addEventListener('change', refresh);
  forced.addEventListener('change', refresh);
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); cancelAnimationFrame(frame); canvas.hidden = true; });
  new MutationObserver(refresh).observe(root, { attributes: true, attributeFilter: ['data-motion','data-scheme','data-theme','data-custom-wallpaper'] });
  refresh();
}
