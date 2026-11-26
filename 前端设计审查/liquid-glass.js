// Compile from the repository root with tsc --strict --target ES2022 --module ES2022 前端设计审查/liquid-glass.ts
const surfaceSelector = '.topline, .app-shell .rail, .card, .live-panel, dialog, .ui-dialog, .composerShell';
const glassSelector = surfaceSelector + ', button, a:is(.smallbtn, .primary, .plain, .start), .uploadButton, .navitem, #queueLink';
const highlightSelector = '.topline, .primary, .workspace-new, .quick-drop, [data-spotlight], .glass-card';
const filterId = 'fai-liquid-refraction';
const root = document.documentElement;
let initialized = false;
function injectRefraction() {
    if (!CSS.supports('backdrop-filter', 'url(#' + filterId + ')'))
        return;
    const definitions = document.querySelector('#glassFilters');
    if (!definitions)
        return;
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
function markSurfaces(container) {
    if (container.matches(glassSelector))
        container.classList.add('liquid-glass');
    for (const element of container.querySelectorAll(glassSelector)) {
        element.classList.add('liquid-glass');
    }
}
function bindMouseHighlight() {
    const motion = matchMedia('(any-hover: hover) and (any-pointer: fine) and (forced-colors: none)');
    const contrast = matchMedia('(prefers-contrast: more), (prefers-reduced-transparency: reduce)');
    let target = null;
    let active = null;
    let clientX = 0;
    let clientY = 0;
    let frame = null;
    function clearActive() {
        active?.classList.remove('liquid-highlight');
        active?.style.removeProperty('--mouse-x');
        active?.style.removeProperty('--mouse-y');
        active?.style.removeProperty('--mx');
        active?.style.removeProperty('--my');
        active = null;
    }
    function clearGlowItems() {
        for (const el of document.querySelectorAll('.glass-glow-item')) {
            el.style.setProperty('--glow-opacity', '0');
        }
    }
    function clear() {
        if (frame !== null)
            cancelAnimationFrame(frame);
        frame = null;
        target = null;
        clearActive();
        clearGlowItems();
    }
    function paintGlowItems() {
        const proximity = 220;
        for (const el of document.querySelectorAll('.glass-glow-item')) {
            const bounds = el.getBoundingClientRect();
            if (!bounds.width || !bounds.height) continue;
            const dx = Math.max(bounds.left - clientX, 0, clientX - bounds.right);
            const dy = Math.max(bounds.top - clientY, 0, clientY - bounds.bottom);
            const dist = Math.hypot(dx, dy);
            if (dist < proximity) {
                const prox = Math.max(0, 1 - dist / proximity);
                const eased = dist === 0 ? 1 : prox * prox * (3 - 2 * prox);
                el.style.setProperty('--mx', (clientX - bounds.left).toFixed(1) + 'px');
                el.style.setProperty('--my', (clientY - bounds.top).toFixed(1) + 'px');
                el.style.setProperty('--glow-opacity', eased.toFixed(3));
            } else {
                el.style.setProperty('--glow-opacity', '0');
            }
        }
    }
    function paint() {
        frame = null;
        if (target !== active || !target?.isConnected)
            clearActive();
        active = target?.isConnected ? target : null;
        if (active) {
            const bounds = active.getBoundingClientRect();
            const lx = (clientX - bounds.left) + 'px';
            const ly = (clientY - bounds.top) + 'px';
            active.style.setProperty('--mouse-x', lx);
            active.style.setProperty('--mouse-y', ly);
            active.style.setProperty('--mx', lx);
            active.style.setProperty('--my', ly);
            active.classList.add('liquid-highlight');
        }
        paintGlowItems();
    }
    window.addEventListener('pointermove', event => {
        if (event.pointerType === 'touch' || root.dataset.motion === 'off') {
            clear();
            return;
        }
        clientX = event.clientX;
        clientY = event.clientY;
        const surface = motion.matches && !contrast.matches && event.target instanceof Element
            ? event.target.closest(highlightSelector)
            : null;
        if (surface instanceof HTMLElement && !surface.matches(':disabled, [aria-disabled="true"]')) {
            target = surface;
        } else {
            target = null;
        }
        frame ??= requestAnimationFrame(paint);
    }, { passive: true });
    root.addEventListener('pointerleave', clear);
    document.addEventListener('scroll', clear, { capture: true, passive: true });
    window.addEventListener('hashchange', clear);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    motion.addEventListener('change', clear);
    contrast.addEventListener('change', clear);
    new MutationObserver(clear).observe(root, { attributeFilter: ['data-motion'] });
}
export function initLiquidGlass() {
    if (initialized)
        return;
    initialized = true;
    injectRefraction();
    markSurfaces(document.body);
    bindMouseHighlight();
    new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLElement)
                    markSurfaces(node);
            }
        }
    }).observe(document.body, { subtree: true, childList: true });
}
initLiquidGlass();
