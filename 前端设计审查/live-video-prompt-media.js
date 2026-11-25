import { h, notice } from './live-ui.js';
import { uploadMedia } from './live-workspace.js';
import { describeError } from './studio-errors.js';

const isImage = asset => ['image/png', 'image/jpeg'].includes(asset.mediaType);
const hasConsent = asset => asset.consentReference && Date.parse(asset.consentExpiresAt) > Date.now();

export function bindVideoMedia(ctx, root, assets, { inputType, setInputType, change, report, locked }) {
  const library = root.querySelector('[data-video-library]');
  const card = root.querySelector('[data-video-asset]');
  const picker = root.querySelector('[data-video-file]');
  const upload = root.querySelector('[data-video-upload]');
  const panel = root.querySelector('#video-media');
  let asset, uploading = false;

  function render() {
    const type = inputType();
    const videos = type === 'reference';
    const items = assets.filter(entry => videos ? entry.mediaType === 'video/mp4' && hasConsent(entry) : isImage(entry));
    if (type === 'text' || (asset && !items.includes(asset))) asset = undefined;
    upload.hidden = videos;
    library.innerHTML = items.length ? '<label>从素材库选择<select data-video-asset-picker><option value="">请选择</option>' +
      items.map(entry => '<option value="' + h(entry.id) + '"' + (entry === asset ? ' selected' : '') + '>' + h(entry.name) + '</option>').join('') +
      '</select></label>' : notice(videos ? '请先在素材库上传带有效授权的 MP4。' : '素材库暂无可用图片。');
    card.innerHTML = asset ? '<span class="video-asset-chip">' + h(asset.name) +
      '<button type="button" class="plain" data-video-remove aria-label="移除素材">×</button></span>' :
      notice(videos ? '从素材库选择已授权的参考视频。' : '可拖入或粘贴 PNG、JPEG 作为首帧。');
  }

  function choose(entry) {
    asset = entry;
    if (entry && inputType() === 'text') setInputType('frame');
    change();
  }

  async function add(file) {
    if (!file || uploading || locked()) return;
    if (inputType() === 'reference' || !/\.(png|jpe?g)$/i.test(file.name)) {
      report('首帧支持 PNG 或 JPEG。参考视频请在素材库登记授权后选用。');
      return;
    }
    uploading = true;
    change();
    report('正在将首帧图上传至素材库…');
    try {
      const data = new FormData();
      data.set('file', file);
      data.set('source', '本地上传');
      data.set('purpose', '视频生成首帧');
      const result = await uploadMedia(ctx, data);
      if (ctx.active()) { assets.unshift(result); choose(result); }
    } catch (error) {
      if (ctx.active()) report(describeError(error));
    } finally {
      uploading = false;
      picker.value = '';
      if (ctx.active()) change(true);
    }
  }

  upload.addEventListener('click', () => { if (!uploading && !locked()) picker.click(); });
  picker.addEventListener('change', () => void add(picker.files[0]));
  library.addEventListener('change', event => {
    if (locked()) return;
    choose(assets.find(entry => entry.id === event.target.value));
    panel.hidePopover();
  });
  card.addEventListener('click', event => {
    if (!locked() && event.target.closest('[data-video-remove]')) choose(undefined);
  });
  root.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
  });
  root.addEventListener('drop', event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    void add(event.dataTransfer.files[0]);
  });
  root.querySelector('[name=prompt]').addEventListener('paste', event => {
    const file = event.clipboardData?.files[0];
    if (file) { event.preventDefault(); void add(file); }
  });
  return { render, selected: () => asset, uploading: () => uploading };
}
