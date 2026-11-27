import { studioIcon } from './studio-icons.js';
import { h } from './live-ui.js';
import { describeError } from './studio-errors.js';
import { bindPopover } from './live-popover.js';
import { sourceChoices } from './live-agent-sources.js';

const categories = [
  ['files','@引用文件','document'], ['experts','专家 / 专家团','members'], ['skills','技能','capabilities'],
  ['connections','连接器','connections'], ['context','上下文','data'],
];
const button = (attr, name, glyph) => '<button type="button" ' + attr + '>' +
  (glyph ? studioIcon(glyph) : '') + '<span>' + h(name) + '</span></button>';
const categoryButtons = () => categories.map(([key,name,glyph]) => button('data-category="' + key + '"',name,glyph)).join('');

export function contextPicker() {
  return '<button type="button" class="smallbtn composer-add" popovertarget="composer-context" aria-label="添加上下文">' + studioIcon('plus') + '</button>' +
    '<section id="composer-context" class="studio-popover composer-popover" popover aria-label="添加上下文">' +
    '<div class="popover-heading"><strong>添加上下文</strong></div><div data-picker-body></div></section>' +
    '<input class="composer-file" type="file" accept="image/png,image/jpeg" hidden>' +
    '<input class="composer-text-file" type="file" accept=".txt,.md,text/plain,text/markdown" hidden>';
}

export function bindContextPicker(view, ctx, {onAdd, onImage, onUpload, onText}) {
  const trigger = view.querySelector('.composer-add'), panel = view.querySelector('#composer-context');
  const position = bindPopover(trigger, panel, {signal:ctx.signal});
  const heading = panel.querySelector('strong'), body = panel.querySelector('[data-picker-body]');
  const file = view.querySelector('.composer-file'), local = view.querySelector('.composer-text-file');
  let entries = [], generation = 0, back;
  function home() {
    generation++;
    heading.textContent = '添加上下文';
    body.innerHTML = categoryButtons();
    back = undefined;
    position();
  }
  async function browse(category, title, parent) {
    const request = ++generation;
    entries = [];
    back = parent ? () => browse('files', '@引用文件') : undefined;
    heading.textContent = title;
    const prefix = button('data-back', '返回') + (category === 'files' ?
      button('data-context-text', '引用本地文本', 'document') + button('data-context-upload','上传本地图片','image') +
      button('data-context-pick','引用素材库图片','image') : '');
    body.innerHTML = prefix + '<p role="status">正在读取…</p>';
    body.querySelector('button').focus();
    position();
    try {
      const rows = category === 'images' ? (await ctx.all('/v1/assets')).filter(a => ['image/png','image/jpeg'].includes(a.mediaType))
        .map(a => ({kind:'image', id:a.id, name:a.name})) : await sourceChoices(ctx, category, parent?.id);
      if (!ctx.active() || request !== generation) return;
      entries = rows;
      const empty = {connections:'暂无已接入的连接器。',files:'暂无已授权的知识库。',context:'暂无可引用的项目或商品。'};
      body.querySelector('p').outerHTML = rows.length ? rows.map((entry,i) =>
        '<button type="button" aria-label="' + h(entry.name) + '" data-entry="' + i + '"><span>' + h(entry.name) +
        '</span>' + (entry.detail ? '<small>' + h(entry.detail) + '</small>' : '') + '</button>').join('') :
        '<p role="status">' + (empty[category] ?? '暂无可用条目。') + '</p>';
    } catch (error) {
      if (ctx.active() && request === generation) body.querySelector('p').textContent = describeError(error);
    }
    position();
  }
  panel.addEventListener('beforetoggle', event => { if (event.newState === 'open') home(); else generation++; });
  panel.addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-back')) { if (back) void back(); else { home(); body.querySelector('button').focus(); } return; }
    if (target.dataset.category) return browse(target.dataset.category, target.textContent);
    if (target.hasAttribute('data-context-pick')) return browse('images','素材库图片',{});
    if (target.hasAttribute('data-context-upload') || target.hasAttribute('data-context-text')) {
      panel.hidePopover();
      (target.hasAttribute('data-context-upload') ? file : local).click();
      return;
    }
    const entry = entries[Number(target.dataset.entry)];
    if (!entry) return;
    if (entry.kind === 'base') return browse('documents',entry.name,entry);
    panel.hidePopover();
    if (entry.kind === 'image') await onImage(entry); else onAdd(entry);
    view.querySelector('textarea').focus();
  });
  for (const [input,callback] of [[file,onUpload],[local,onText]]) input.addEventListener('change', () => {
    const selected = input.files[0];
    input.value = '';
    if (selected) void callback(selected);
  });
}
