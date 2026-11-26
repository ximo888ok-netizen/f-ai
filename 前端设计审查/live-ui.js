export function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
export const field = (title, control) => '<label>' + h(title) + control + '</label>';
export const input = (name, attrs = '') => '<input name="' + h(name) + '" ' + attrs + '>';
export const textarea = (name, attrs = '', value = '') => '<textarea name="' + h(name) + '" ' + attrs + '>' + h(value) + '</textarea>';
export const button = (title, attrs = '') => '<button class="primary" ' + attrs + '>' + h(title) + '</button>';
export const action = (title, name, value = '') => '<button class="plain" type="button" data-' + name + '="' + h(value) + '">' + h(title) + '</button>';
export const link = (title, route) => '<a class="smallbtn" href="#' + h(route) + '">' + h(title) + '</a>';
export function generationModeTabs(label, modes, current) {
  return '<nav class="quick-mode-switch" aria-label="' + h(label) + '">' + modes.map(([id, route, title]) =>
    '<a class="smallbtn" href="#' + h(route) + '"' + (id === current ? ' aria-current="page"' : '') + '>' +
    h(title) + '</a>').join('') + '</nav>';
}
export const notice = text => '<p class="live-muted">' + h(text) + '</p>';
export const heading = (title, description = '') => '<div class="live-title"><h1>' + h(title) + '</h1>' + (description ? notice(description) : '') + '</div>';
export const panel = (title, body) => '<section class="card live-panel"><h2>' + h(title) + '</h2>' + body + '</section>';
export const grid = (...sections) => '<div class="live-grid">' + sections.join('') + '</div>';
export const form = (name, fields, title = '保存') => '<form class="live-form" data-form="' + h(name) + '">' + fields + button(title) + '</form>';
export const item = (title, description, controls = '') => '<article class="live-item"><strong>' + h(title) + '</strong>' + (description ? notice(description) : '') + controls + '</article>';
export const list = (items, render, fallback = '暂无记录。') => items.length ? items.map(render).join('') : notice(fallback);
export const result = value => '<pre class="live-result">' + h(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '</pre>';
export const date = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
export const path = value => encodeURIComponent(value);
export const uid = () => crypto.randomUUID();
export function retryKey() {
  let previous;
  let id;
  return value => {
    const next=JSON.stringify(value);
    if (next!==previous) {id=uid();previous=next;}
    return id;
  };
}
export function select(name, options, selected, attrs = '') {
  return '<select name="' + h(name) + '" ' + attrs + '>' + options.map(([key, label]) => '<option value="' + h(key) + '"' +
    ((Array.isArray(selected) ? selected.includes(key) : key === selected) ? ' selected' : '') + '>' + h(label) + '</option>').join('') + '</select>';
}
export function confirmDialog(title, message, confirmLabel = '继续', cancelLabel = '取消') {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ui-dialog';
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<header class="ui-dialog-header"><h2>' + h(title) + '</h2>' +
      '<button class="ui-icon-button" type="button" value="cancel" aria-label="关闭">×</button></header>' +
      '<div class="ui-dialog-body"><p>' + h(message) + '</p></div>' +
      '<footer class="ui-dialog-footer"><button type="button" class="plain" value="cancel">' + h(cancelLabel) + '</button>' +
      '<button type="button" class="primary" value="confirm">' + h(confirmLabel) + '</button></footer>';
    const settle = accepted => {
      dialog.close();
      dialog.remove();
      resolve(accepted);
    };
    dialog.addEventListener('cancel', event => { event.preventDefault(); settle(false); });
    dialog.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => settle(btn.value === 'confirm')));
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.primary')?.focus();
  });
}
