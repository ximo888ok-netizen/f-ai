import { h } from '../live-ui.js';
import { uploadMedia } from '../live-workspace.js';

const kinds = { products: ['商品图', 5], reference: ['参考图', 1] };

export function quickUploadField(kind) {
  const [label, max] = kinds[kind];
  return '<div class="quick-upload" data-quick-upload="' + kind + '">' +
    '<input type="file" accept=".png,.jpg,.jpeg" hidden' + (max > 1 ? ' multiple' : '') + '>' +
    '<button type="button" class="quick-drop"><strong>选择' + label + '</strong><span>拖放或粘贴 PNG、JPEG · 最多 ' +
    max + ' 张，每张 10 MiB</span></button><ul class="quick-photos" aria-label="已选' + label + '"></ul></div>';
}

export function bindQuickFiles(ctx, form, onChange, onError) {
  const entries = { products: [], reference: [] };
  let current = 'products';
  let locked = false;

  function add(kind, files) {
    if (locked || !files.length) return;
    const [label, max] = kinds[kind];
    if (files.some(file => !/\.(png|jpe?g)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024)) {
      onError('请选择 10 MiB 以内的 PNG 或 JPEG 图片。');
      return;
    }
    if (files.length > max || (max > 1 && entries[kind].length + files.length > max)) {
      onError(label + '最多可选 ' + max + ' 张。');
      return;
    }
    if (max === 1) entries[kind].splice(0).forEach(entry => URL.revokeObjectURL(entry.url));
    entries[kind].push(...files.map(file => ({ file, url: URL.createObjectURL(file) })));
    render(kind);
  }

  function render(kind) {
    const list = form.querySelector('[data-quick-upload="' + kind + '"] ul');
    list.innerHTML = entries[kind].map((entry, index) =>
      '<li><img src="' + h(entry.url) + '" alt=""><span title="' + h(entry.file.name) + '">' + h(entry.file.name) +
      '</span><button type="button" data-remove-quick-file="' + index + '" aria-label="移除 ' + h(entry.file.name) +
      '">×</button></li>').join('');
    onChange();
  }

  for (const kind of Object.keys(kinds)) {
    const area = form.querySelector('[data-quick-upload="' + kind + '"]');
    if (!area) continue;
    const input = area.querySelector('input');
    area.querySelector('.quick-drop').addEventListener('click', () => {
      if (locked) return;
      current = kind;
      input.click();
    });
    area.addEventListener('focusin', () => { current = kind; });
    input.addEventListener('change', () => { add(kind, [...input.files]); input.value = ''; });
    area.addEventListener('dragover', event => {
      event.preventDefault();
      const acceptsDrop = !locked && event.dataTransfer.types.includes('Files');
      event.dataTransfer.dropEffect = acceptsDrop ? 'copy' : 'none';
      area.toggleAttribute('data-drag-over', acceptsDrop);
    });
    area.addEventListener('dragleave', event => {
      if (!area.contains(event.relatedTarget)) area.removeAttribute('data-drag-over');
    });
    area.addEventListener('drop', event => {
      event.preventDefault();
      area.removeAttribute('data-drag-over');
      add(kind, [...event.dataTransfer.files]);
    });
    area.addEventListener('click', event => {
      const button = event.target.closest('[data-remove-quick-file]');
      if (!button || locked) return;
      const [removed] = entries[kind].splice(Number(button.dataset.removeQuickFile), 1);
      URL.revokeObjectURL(removed.url);
      render(kind);
    });
  }

  document.addEventListener('paste', event => {
    if (!ctx.active() || event.target.closest?.('textarea,input:not([type="file"]),[contenteditable]')) return;
    const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    add(form.elements.useReference?.checked ? current : 'products', images);
  }, { signal: ctx.signal });
  ctx.signal.addEventListener('abort', () => {
    for (const entry of [...entries.products, ...entries.reference]) URL.revokeObjectURL(entry.url);
  }, { once: true });

  return {
    count: kind => entries[kind].length,
    firstPreview: () => entries.products[0]?.url,
    setLocked(value) {
      locked = value;
      if (value) for (const area of form.querySelectorAll('[data-drag-over]')) area.removeAttribute('data-drag-over');
    },
    async upload(useReference) {
      const selected = useReference ? [...entries.products, ...entries.reference] : entries.products;
      for (const entry of selected) {
        if (entry.id) continue;
        const body = new FormData();
        body.set('file', entry.file);
        const mode = { advanced: '高级模式', agent: 'Agent 生图', quick: '快速模式' }[form.dataset.imageMode];
        body.set('source', '图片生成 · ' + mode);
        body.set('purpose', entries.reference.includes(entry) ? '风格参考图' : '商品主图输入');
        entry.id = (await uploadMedia(ctx, body)).id;
      }
      return selected.map(entry => entry.id);
    },
  };
}
