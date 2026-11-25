export function bindPopover(trigger, panel, { end = false, signal } = {}) {
  let frame = 0;

  function position() {
    if (!panel.matches(':popover-open')) return;
    const anchor = trigger.getBoundingClientRect();
    const edge = 12, gap = 8;
    const above = anchor.top - edge - gap;
    const below = window.innerHeight - anchor.bottom - edge - gap;
    const openAbove = above >= panel.scrollHeight || above > below;
    panel.style.maxHeight = Math.max(0, openAbove ? above : below) + 'px';
    const width = panel.offsetWidth;
    const x = end ? anchor.right - width : anchor.left;
    const left = Math.max(edge, Math.min(x, window.innerWidth - width - edge));
    panel.style.left = left + 'px';
    panel.style.top = (openAbove ? anchor.top - gap - panel.offsetHeight : anchor.bottom + gap) + 'px';
    panel.style.transformOrigin = (anchor.left + anchor.width / 2 - left) + 'px ' + (openAbove ? 'bottom' : 'top');
    panel.dataset.positioned = '';
  }

  function queuePosition() {
    if (frame || !panel.matches(':popover-open')) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  }

  trigger.addEventListener('click', event => {
    panel.toggleAttribute('data-pointer-popover', event.detail > 0);
  }, { signal });
  panel.addEventListener('toggle', position, { signal });
  panel.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    delete panel.dataset.positioned;
    panel.style.removeProperty('max-height');
  }, { signal });
  window.addEventListener('resize', queuePosition, { signal });
  document.addEventListener('scroll', event => {
    if (event.target !== panel) queuePosition();
  }, { capture: true, passive: true, signal });
}
