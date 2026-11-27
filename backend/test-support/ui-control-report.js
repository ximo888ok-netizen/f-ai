import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Capture trusted browser events. A rendered control, a click, and a verified
// business outcome are deliberately recorded as different pieces of evidence.
export async function watchControls(t, context) {
  const directory = process.env.FAI_UI_REPORT_DIR;
  if (!directory) return;
  const rows = new Map();
  await context.exposeBinding('__faiUiCoverage', (_, events) => {
    for (const [view, action, control, count] of events) {
      const key = JSON.stringify([view, action, control]);
      const row = rows.get(key) ?? { view, action, control, clicks: 0 };
      row.clicks += count;
      rows.set(key, row);
    }
  });
  await context.addInitScript(() => {
    const selector = 'button, input[type=submit], input[type=button], summary, [role=button], [role=tab], [role=menuitem], [data-glass-preset], .dm-track, a[href]';
    const seen = new Set();
    const clean = value => String(value ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')
      .replace(/\s+/g, ' ').trim().slice(0, 150);
    function describe(node) {
      const main = node.closest('#main,#merchantContent,#commerce-directory');
      const view = location.pathname + (main ? '#' + clean(location.hash.slice(1) || 'home') : '#(shell)');
      const form = node.form?.dataset.form;
      const attr = Array.from(node.attributes).filter(a => a.name.startsWith('data-') && a.name !== 'data-pending');
      const href = node.getAttribute('href');
      const name = clean(node.getAttribute('aria-label') || node.title || node.textContent || node.value);
      let action;
      if (href) action = 'link ' + clean(href.split('?')[0]);
      else if (node.type === 'submit' && form) action = 'submit ' + form;
      else if (attr.length) action = attr.map(a => a.name).join(' ') + ' ' + name;
      else action = (node.id || node.getAttribute('role') || node.localName) + ' ' + name;
      const keyAttr = attr.find(a => ['data-select','data-switch-scene','data-plugin-state','data-glass-preset','data-dual-mode','data-dual-step','data-brief-chip','data-model-choice'].includes(a.name));
      let control = action;
      if (!href && !(node.type === 'submit' && form)) {
        if (keyAttr) control = keyAttr.name + '=' + clean(keyAttr.value);
        else if (node.id) control = '#' + node.id;
        else if (attr.length) control = attr[0].name;
        else if (node.matches('.dm-track')) control = '玻璃主题点阵开关';
        else if (node.matches('summary')) control = 'summary ' + clean(name).replace(/\d+/g,'#');
      }
      return [view, action, control];
    }
    let timer;
    function inspect() {
      timer = null;
      const events = [];
      for (const node of document.querySelectorAll(selector)) {
        if (node.matches(':disabled,[aria-disabled=true]') || !node.getClientRects().length ||
            getComputedStyle(node).visibility === 'hidden') continue;
        const tuple = describe(node);
        const key = JSON.stringify(tuple);
        if (!seen.has(key)) { seen.add(key); events.push([...tuple, 0]); }
      }
      if (events.length) void window.__faiUiCoverage(events);
    }
    new MutationObserver(() => { if (!timer) timer = setTimeout(inspect, 60); })
      .observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden','open','disabled'] });
    document.addEventListener('click', event => {
      const node = event.target.closest?.(selector);
      if (event.isTrusted && node) void window.__faiUiCoverage([[...describe(node), 1]]);
    }, true);
  });
  t.after(async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, randomUUID() + '.json'), JSON.stringify({ suite: t.name, controls: [...rows.values()] }));
  });
}
