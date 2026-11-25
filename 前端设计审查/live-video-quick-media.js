import { bindPopover } from './live-popover.js';
import { uploadMedia } from './live-workspace.js';
import { h, link, notice, path, uid } from './live-ui.js';
import { quickVideoLimit } from './live-video-quick-view.js';

const mime = new Set(['image/png', 'image/jpeg']);
const maxBytes = 10 * 1024 * 1024;

export function bindVideoQuickMedia(ctx, root, assets, recentIds, { change, report, locked, source = '智能快创' }) {
  const selected = [];
  const list = root.querySelector('[data-video-quick-photos]');
  const drop = root.querySelector('[data-video-quick-drop]');
  const input = root.querySelector('[data-video-quick-file]');
  const preview = root.querySelector('[data-video-quick-frame]');
  const empty = root.querySelector('[data-video-quick-empty]');
  const images = assets.filter(asset => mime.has(asset.mediaType));
  let cover;

  function render() {
    root.querySelector('[data-video-quick-count]').textContent = selected.length + ' / ' + quickVideoLimit;
    list.innerHTML = selected.map(entry => '<li>' +
      '<button type="button" class="video-quick-photo" data-video-quick-cover="' + h(entry.key) + '" aria-pressed="' + (entry === cover) +
      '" aria-label="设为首帧：' + h(entry.name) + '">' + (entry.url ? '<img src="' + h(entry.url) + '" alt="">' : '') +
      '<span title="' + h(entry.name) + '">' + (entry === cover ? '首帧' : h(entry.name)) + '</span></button>' +
      '<button type="button" class="plain video-quick-remove" data-video-quick-remove="' + h(entry.key) +
      '" aria-label="移除 ' + h(entry.name) + '">×</button></li>').join('');
    preview.hidden = !cover;
    empty.hidden = Boolean(cover);
    preview.innerHTML = cover ? (cover.url ? '<img src="' + h(cover.url) + '" alt="首帧：' + h(cover.name) + '">' :
      notice(cover.previewFailed ? '首帧预览不可用，可在素材库检查文件。' : '正在读取首帧…')) : '';
  }

  function choose(entry) {
    if (selected.length >= quickVideoLimit) { report('商品图最多可选 ' + quickVideoLimit + ' 张。'); return false; }
    selected.push(entry);
    cover ??= entry;
    render();
    change();
    return true;
  }

  function addFiles(files) {
    if (locked() || !files.length) return;
    if (selected.length + files.length > quickVideoLimit) { report('商品图最多可选 ' + quickVideoLimit + ' 张。'); return; }
    if (files.some(file => !/\.(png|jpe?g)$/i.test(file.name) || !file.size || file.size > maxBytes)) {
      report('请选择 10 MiB 以内的 PNG 或 JPEG 图片。');
      return;
    }
    for (const file of files) choose({ key: uid(), file, name: file.name, url: URL.createObjectURL(file) });
  }

  async function addAsset(asset) {
    if (locked() || selected.some(entry => entry.id === asset.id)) return;
    const entry = { key: asset.id, id: asset.id, name: asset.name };
    if (!choose(entry)) return;
    try {
      const response = await ctx.api('/v1/assets/' + path(asset.id) + '/content', { raw: true });
      const blob = await response.blob();
      if (ctx.active() && selected.includes(entry)) entry.url = URL.createObjectURL(blob);
    } catch { entry.previewFailed = true; }
    if (ctx.active() && selected.includes(entry)) render();
  }

  for (const [key, entries] of [['library', images], ['recent', images.filter(asset => recentIds.has(asset.id))]]) {
    const panel = root.querySelector('#video-quick-' + key);
    const trigger = root.querySelector('[popovertarget="video-quick-' + key + '"]');
    bindPopover(trigger, panel, { signal: ctx.signal });
    panel.innerHTML = entries.length ? entries.map(asset => '<button type="button" class="smallbtn" data-video-quick-pick="' +
      h(asset.id) + '">' + h(asset.name) + '</button>').join('') :
      notice(key === 'recent' ? '暂无可用的近期生图成品。' : '素材库暂无图片。') + link('打开素材库', 'assets');
    panel.addEventListener('click', event => {
      const pick = event.target.closest('[data-video-quick-pick]');
      if (!pick || locked()) return;
      const asset = entries.find(entry => entry.id === pick.dataset.videoQuickPick);
      panel.hidePopover();
      void addAsset(asset);
    });
  }

  root.querySelector('[data-video-quick-upload]').addEventListener('click', () => { if (!locked()) input.click(); });
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  drop.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  drop.addEventListener('drop', event => { event.preventDefault(); addFiles([...event.dataTransfer.files]); });
  document.addEventListener('paste', event => {
    if (event.target.closest?.('textarea,input,[contenteditable]')) return;
    const files = [...(event.clipboardData?.files ?? [])].filter(file => mime.has(file.type));
    if (files.length) { event.preventDefault(); addFiles(files); }
  }, { signal: ctx.signal });
  list.addEventListener('click', event => {
    if (locked()) return;
    const chooseButton = event.target.closest('[data-video-quick-cover]');
    const removeButton = event.target.closest('[data-video-quick-remove]');
    if (chooseButton) cover = selected.find(entry => entry.key === chooseButton.dataset.videoQuickCover);
    else if (removeButton) {
      const index = selected.findIndex(entry => entry.key === removeButton.dataset.videoQuickRemove);
      if (index < 0) return;
      const [removed] = selected.splice(index, 1);
      if (removed.url) URL.revokeObjectURL(removed.url);
      if (removed === cover) cover = selected[0];
    } else return;
    render();
    change();
    if (chooseButton) list.querySelector('[aria-pressed="true"]')?.focus();
  });
  ctx.signal.addEventListener('abort', () => selected.forEach(entry => { if (entry.url) URL.revokeObjectURL(entry.url); }), { once: true });
  return {
    frame: () => cover,
    async uploadFrame(entry) {
      if (!entry.id) {
        const body = new FormData();
        body.set('file', entry.file);
        body.set('source', source + ' · 本地上传');
        body.set('purpose', '商品视频首帧');
        entry.id = (await uploadMedia(ctx, body)).id;
      }
      return { id: entry.id };
    },
  };
}
