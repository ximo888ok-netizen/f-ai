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
