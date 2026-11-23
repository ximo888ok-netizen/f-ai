export function bindPopover(trigger, panel, { end = false, signal } = {}) {
  function position() {
    if (!panel.matches(':popover-open')) return;
    const anchor = trigger.getBoundingClientRect();
    const edge = 12, gap = 8;
    const above = anchor.top - edge - gap;
    const below = window.innerHeight - anchor.bottom - edge - gap;
    const openAbove = above >= panel.scrollHeight || above > below;
    panel.style.maxHeight = Math.max(0, openAbove ? above : below) + 'px';
    const box = panel.getBoundingClientRect();
    const x = end ? anchor.right - box.width : anchor.left;
    panel.style.left = Math.max(edge, Math.min(x, window.innerWidth - box.width - edge)) + 'px';
    panel.style.top = (openAbove ? anchor.top - gap - box.height : anchor.bottom + gap) + 'px';
    panel.dataset.positioned = '';
  }

  panel.addEventListener('toggle', position, { signal });
  panel.addEventListener('beforetoggle', event => {
    if (event.newState === 'closed') delete panel.dataset.positioned;
    else panel.style.removeProperty('max-height');
  }, { signal });
  window.addEventListener('resize', position, { signal });
  document.addEventListener('scroll', event => {
    if (event.target !== panel) position();
  }, { capture: true, passive: true, signal });
}
