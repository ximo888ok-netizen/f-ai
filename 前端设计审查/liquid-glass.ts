// Compile from the repository root with tsc --strict --target ES2022 --module ES2022 前端设计审查/liquid-glass.ts
const surfaceSelector = '.topline, .app-shell .rail, .card, .live-panel, dialog, .ui-dialog, .composerShell';
const glassSelector = surfaceSelector + ', button, a:is(.smallbtn, .primary, .plain, .start), .uploadButton, .navitem, #queueLink';
const filterId = 'fai-liquid-refraction';
const root = document.documentElement;
let initialized = false;

function injectRefraction(): void {
  if (!CSS.supports('backdrop-filter', 'url(#' + filterId + ')')) return;
  const definitions = document.querySelector('#glassFilters');
  if (!definitions) return;
  if (!document.getElementById(filterId)) {
    definitions.insertAdjacentHTML('beforeend', `
      <filter id="${filterId}" x="-4%" y="-4%" width="108%" height="108%"
              filterUnits="objectBoundingBox" primitiveUnits="objectBoundingBox"
              color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="6 4" numOctaves="1" seed="8" result="ripples"/>
        <feFlood x="4%" y="12%" width="92%" height="76%" flood-color="#808080" result="neutralCenter"/>
        <feComposite in="neutralCenter" in2="ripples" operator="over" result="rimMap"/>
        <feDisplacementMap in="SourceGraphic" in2="rimMap" scale=".022" xChannelSelector="R" yChannelSelector="G"/>
      </filter>`);
  }
  root.classList.add('liquid-refraction-ready');
}

function markSurfaces(container: HTMLElement): void {
  if (container.matches(glassSelector)) container.classList.add('liquid-glass');
  for (const element of container.querySelectorAll(glassSelector)) {
    element.classList.add('liquid-glass');
  }
}

function bindMouseHighlight(): void {
  const motion = matchMedia('(any-hover: hover) and (any-pointer: fine) and (prefers-reduced-motion: no-preference) and (forced-colors: none)');
  let target: HTMLElement | null = null;
  let active: HTMLElement | null = null;
  let clientX = 0;
  let clientY = 0;
  let frame: number | null = null;

  function clear(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    target = null;
    active?.classList.remove('liquid-highlight');
    active = null;
  }

  function paint(): void {
    frame = null;
    if (target !== active) active?.classList.remove('liquid-highlight');
    active = target?.isConnected ? target : null;
    if (!active) return;

    const bounds = active.getBoundingClientRect();
    active.style.setProperty('--mouse-x', (clientX - bounds.left) + 'px');
    active.style.setProperty('--mouse-y', (clientY - bounds.top) + 'px');
    active.classList.add('liquid-highlight');
  }

  document.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !motion.matches || root.dataset.motion === 'off') {
      clear();
      return;
    }
    const surface = event.target instanceof Element ? event.target.closest('.liquid-glass') : null;
    target = surface instanceof HTMLElement && !surface.matches(':disabled, [aria-disabled="true"]') ? surface : null;
    clientX = event.clientX;
    clientY = event.clientY;
    frame ??= requestAnimationFrame(paint);
  }, { passive: true });

  root.addEventListener('pointerleave', clear);
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', clear);
  motion.addEventListener('change', clear);
  new MutationObserver(clear).observe(root, { attributeFilter: ['data-motion'] });
}

export function initLiquidGlass(): void {
  if (initialized) return;
  initialized = true;
  injectRefraction();
  markSurfaces(document.body);
  bindMouseHighlight();
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) markSurfaces(node);
      }
    }
  }).observe(document.body, { subtree: true, childList: true });
}

initLiquidGlass();
