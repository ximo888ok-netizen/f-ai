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
float glassHeight(vec2 uv, float t) {
  vec2 mDiff = uv - uMouse;
  float mDist = length(mDiff);
  vec2 lensPull = mDiff * exp(-mDist * mDist * 3.8) * 0.11;
  vec2 p = uv * 1.45 - lensPull;
  vec2 q = vec2(
    fbm(p + vec2(t * 0.14, -t * 0.10)),
    fbm(p + vec2(-t * 0.11 + 4.2, t * 0.13 + 1.8))
  );
  vec2 r = vec2(
    fbm(p + 1.65 * q + vec2(1.7, 9.2) + t * 0.07),
    fbm(p + 1.65 * q + vec2(8.3, 2.8) - t * 0.06)
  );
  float ribbon1 = sin(p.x * 2.1 + p.y * 1.35 + q.x * 3.6 + t * 0.22) * 0.5 + 0.5;
  float ribbon2 = cos(p.x * 1.3 - p.y * 2.25 + r.y * 3.2 - t * 0.18) * 0.5 + 0.5;
  float organic = fbm(p + 1.55 * r);
  return mix(organic, ribbon1 * 0.58 + ribbon2 * 0.42, 0.56);
}
void main() {
  vec2 aspect = vec2(uRes.x / max(1.0, uRes.y), 1.0);
  vec2 uv = (vUv - 0.5) * aspect + 0.5;
  float h  = glassHeight(uv, uTime);
  float eps = 0.0085;
  float hx = glassHeight(uv + vec2(eps, 0.0), uTime);
  float hy = glassHeight(uv + vec2(0.0, eps), uTime);
  vec3 N = normalize(vec3((h - hx) / eps * 0.28, (h - hy) / eps * 0.28, 1.0));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L1 = normalize(vec3(-0.45 + 0.12 * sin(uTime * 0.19), 0.65, 0.85));
  vec3 L2 = normalize(vec3(0.60, -0.45 + 0.10 * cos(uTime * 0.15), 0.72));
  float diff1 = max(dot(N, L1), 0.0);
  float diff2 = max(dot(N, L2), 0.0);
  vec3 H1 = normalize(L1 + V);
  vec3 H2 = normalize(L2 + V);
  float specBroad = pow(max(dot(N, H1), 0.0), 14.0);
  float specSharp = pow(max(dot(N, H1), 0.0), 48.0);
  float specRim   = pow(max(dot(N, H2), 0.0), 22.0);
  float slope = length(N.xy);
  float causticBand = smoothstep(0.14, 0.48, slope) * (0.55 + 0.45 * sin(h * 11.0 + uTime * 0.35));
  vec3 col = mix(uBaseDeep, uBaseMid, smoothstep(0.16, 0.84, h * 0.72 + diff1 * 0.35));
  col = mix(col, uHighlight, smoothstep(0.32, 0.92, diff1 * 0.65 + diff2 * 0.28) * 0.58);
  col *= (1.0 - uRidgeDark * (1.0 - smoothstep(0.08, 0.55, h)));
  col += uHighlight * (specBroad * uSpecular * 0.55 + specRim * uSpecular * 0.28);
  col += uCaustic * (specSharp * uSpecular * 0.62 + causticBand * uSpecular * 0.26);
  float vig = (1.0 - smoothstep(0.25, 1.38, length(vUv - 0.5) * 1.45));
  col = mix(uBaseDeep * 0.96, col, 0.84 + 0.16 * vig);
  float dither = (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  fragColor = vec4(clamp(col + dither, 0.0, 1.0), 1.0);
}`;

/* Paint the optical field at low resolution; frosted surfaces diffuse its detail. */
export function mountGlassField(host) {
  const root = document.documentElement;
  const canvas = host.querySelector('canvas') ?? document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
  if (!gl) return;
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, glassVertex], [gl.FRAGMENT_SHADER, glassFragment]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return; }
  gl.useProgram(program);
  host.prepend(canvas);
  const uniforms = Object.fromEntries(['uRes','uTime','uMouse','uBaseDeep','uBaseMid','uHighlight','uCaustic','uSpecular','uRidgeDark']
    .map(name => [name, gl.getUniformLocation(program, name)]));
  const colors = {
    white: [[.745,.788,.842],[.875,.902,.934],[.985,.992,1],[1,1,1],.52,.16],
    gray: [[.165,.184,.212],[.275,.302,.34],[.54,.58,.635],[.78,.82,.875],.46,.22],
    black: [[.028,.036,.048],[.075,.092,.118],[.245,.285,.345],[.52,.58,.66],.48,.26],
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const forced = matchMedia('(forced-colors: active)');
  let frame = 0, previous = 0, time = 18, x = .5, y = .5;
  function draw(now) {
    frame = 0;
    const visible = !document.hidden && !root.hasAttribute('data-custom-wallpaper') && !forced.matches && !gl.isContextLost();
    canvas.hidden = !visible;
    if (!visible) return;
    const speed = Number(root.style.getPropertyValue('--flow-speed') || 1);
    const moving = root.dataset.motion !== 'off' && !reduced.matches && speed > 0;
    if (!previous || now - previous >= 48 || !moving) {
      if (moving && previous) time += Math.min(.12, (now - previous) / 1000) * .22 * speed;
      previous = now;
      const scale = Math.min(.45, 760 / innerWidth);
      const width = Math.max(1, Math.round(innerWidth * scale)), height = Math.max(1, Math.round(innerHeight * scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      const c = root.dataset.scheme === 'light' ? colors.white : root.dataset.theme === 'noir' ? colors.gray : colors.black;
      gl.uniform2f(uniforms.uRes, width, height);
      gl.uniform1f(uniforms.uTime, time);
      gl.uniform2f(uniforms.uMouse, x, y);
      for (const [i, name] of ['uBaseDeep','uBaseMid','uHighlight','uCaustic'].entries()) gl.uniform3fv(uniforms[name], c[i]);
      gl.uniform1f(uniforms.uSpecular, c[4]);
      gl.uniform1f(uniforms.uRidgeDark, c[5]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (moving) frame = requestAnimationFrame(draw);
  }
  function refresh() {
    cancelAnimationFrame(frame);
    previous = 0;
    frame = requestAnimationFrame(draw);
  }
  window.addEventListener('pointermove', event => { x = event.clientX / innerWidth; y = 1 - event.clientY / innerHeight; }, { passive: true });
  window.addEventListener('resize', refresh);
  document.addEventListener('visibilitychange', refresh);
  document.addEventListener('studio-material', refresh);
  reduced.addEventListener('change', refresh);
  forced.addEventListener('change', refresh);
  canvas.addEventListener('webglcontextlost', () => { cancelAnimationFrame(frame); canvas.hidden = true; });
  new MutationObserver(refresh).observe(root, { attributes: true, attributeFilter: ['data-motion','data-scheme','data-theme','data-custom-wallpaper'] });
  refresh();
}
