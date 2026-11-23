/* The viewport and the glass under the pointer share one light source. */
(() => {
  const root = document.documentElement;
  const backdrop = document.querySelector('.aurora-field');
  if (!backdrop) return;

  const finePointer = matchMedia('(any-hover: hover) and (any-pointer: fine)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const highContrast = matchMedia('(forced-colors: active)');
  const surfaces = '.card.live-panel:not(details), .live-desk-stage, .studio-light-surface';
  const field = document.createElement('span');
  field.className = 'studio-pointer-field';
  field.setAttribute('aria-hidden', 'true');
  const reflection = field.cloneNode();
  backdrop.append(field);

  let frame = 0;
  let point = null;
  let host = null;

  function detachReflection() {
    reflection.remove();
    host?.classList.remove('studio-light-host');
    host = null;
  }

  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    point = null;
    field.style.removeProperty('--light-x');
    field.style.removeProperty('--light-y');
    detachReflection();
  }

  function position(element, x, y) {
    element.style.setProperty('--light-x', x + 'px');
    element.style.setProperty('--light-y', y + 'px');
  }

  function paint() {
    frame = 0;
    const { x, y } = point;
    const surface = document.elementFromPoint(x, y)?.closest(surfaces) ?? null;
    if (host !== surface) detachReflection();
    position(field, x, y);
    if (!surface) return;

    const bounds = surface.getBoundingClientRect();
    position(reflection, x - bounds.left - surface.clientLeft, y - bounds.top - surface.clientTop);
    if (!host) {
      host = surface;
      host.classList.add('studio-light-host');
      host.insertBefore(reflection, host.children[1] ?? null);
    }
  }

  function schedule() {
    if (point && !frame) frame = requestAnimationFrame(paint);
  }

  function canFollow() {
    return root.dataset.motion !== 'off' &&
      finePointer.matches && !reduced.matches && !highContrast.matches && !document.hidden;
  }

  function syncPolicy() {
    if (point && !canFollow()) reset();
  }

  document.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !canFollow()) {
      if (point) reset();
      return;
    }
    point = { x: event.clientX, y: event.clientY };
    schedule();
  }, { passive: true });
  document.addEventListener('pointerdown', event => { if (point && event.pointerType !== 'mouse') reset(); });
  document.addEventListener('pointerout', event => { if (!event.relatedTarget) reset(); });
  document.addEventListener('pointercancel', reset);
  document.addEventListener('visibilitychange', reset);
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('blur', reset);
  window.addEventListener('hashchange', reset);
  for (const query of [finePointer, reduced, highContrast]) query.addEventListener('change', syncPolicy);
  new MutationObserver(syncPolicy).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
})();
