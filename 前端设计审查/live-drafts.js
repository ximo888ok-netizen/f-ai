import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, select, textarea, toast, uid } from './live.js';
import { uploadMedia } from './live-workspace.js';

const endpoint = '/v1/studio/pinduoduo-drafts';
const roles = [['main','主图'], ['sku','规格图'], ['detail','详情图']];
const textField = (label, name, value, attrs = '') => field(label, input(name, attrs + ' value="' + h(value) + '"'));

const priceField = (value, name = 'price') => textField('售价（元）', name, value == null ? '' : (value / 100).toFixed(2),
  'type="number" min="0" max="10000000" step="0.01"');
const stockField = (value, name = 'stock') => textField('库存（件）', name, value, 'type="number" min="0" max="1000000000" step="1"');
const stockValue = value => value === '' ? null : Number(value);
const priceValue = value => value === '' ? null : Math.round(Number(value) * 100);

function variantFields(v, imageOptions) {
  return '<fieldset class="live-item" data-variant><legend>附加规格</legend>' +
    textField('规格名称', 'variant-specification', v.specification, 'required maxlength="200"') +
    textField('商家 SKU 编码', 'variant-sku', v.sku, 'maxlength="100"') +
    priceField(v.priceMinor, 'variant-price') + stockField(v.stock, 'variant-stock') +
    field('规格图', select('variant-image', [['','未选择'], ...imageOptions], v.assetId ?? '')) +
    action('移除此规格', 'remove-variant') + '</fieldset>';
}

function readVariants(container) {
  return [...container.querySelectorAll('[data-variant]')].map(row => {
    const value = name => row.querySelector('[name="' + name + '"]').value;
    return { specification: value('variant-specification'), sku: value('variant-sku'),
      priceMinor: priceValue(value('variant-price')), stock: stockValue(value('variant-stock')), assetId: value('variant-image') || null };
  });
}

async function inventoryImport(ctx, id) {
  const [draft, books] = await Promise.all([
    ctx.api(endpoint + '/' + path(id)), ctx.all('/v1/studio/pinduoduo/books'),
  ]);
  const back = link('返回草稿编辑', 'drafts/' + draft.id);
  const title = heading('草稿入账', draft.title + ' · 使用最近一次保存的规格');
  if (!books.length) {
    ctx.html(title + back + panel('选择运营台账', notice('请先创建一个台账。') + link('打开运营台账', 'commerce')));
    return;
  }
  const local = new Date();
  const today = [local.getFullYear(), local.getMonth() + 1, local.getDate()].map(num => String(num).padStart(2,'0')).join('-');
  ctx.html(title + back + panel('预览设置', form('inventory-preview',
    field('目标台账', select('book', [['','请选择'], ...books.map(b => [b.id,b.name])], books.length === 1 ? books[0].id : '', 'required')) +
    textField('盘点日期','day',today,'type="date" required') +
    textField('库存预警线','threshold',0,'type="number" required min="0" max="1000000000" step="1"'), '预览入账')) +
    '<section class="card live-panel" data-import-review hidden><h2>入账预览</h2><div data-import-rows aria-live="polite"></div>' +
    action('确认写入台账','confirm-import') + '</section>');

  const review = document.querySelector('[data-import-review]');
  const output = review.querySelector('[data-import-rows]');
  const confirmButton = review.querySelector('[data-confirm-import]');
  let pending;
  let settingsVersion = 0;
  function reset() {
    settingsVersion++;
    pending = null;
    review.hidden = true;
  }
  document.querySelector('[data-form="inventory-preview"]').addEventListener('input', reset);
  document.querySelector('[data-form="inventory-preview"]').addEventListener('change', reset);
  ctx.submit('inventory-preview', async data => {
    reset();
    const version = settingsVersion;
    const book = data.get('book');
    const url = '/v1/studio/pinduoduo/books/' + path(book) + '/records/inventory/draft-import';
    const body = { draftId: draft.id, day: data.get('day'), threshold: Number(data.get('threshold')) };
    const preview = await ctx.api(url + '/preview', { method: 'POST', body });
    if (!ctx.active() || version !== settingsVersion) return;
    const target = books.find(b => b.id === book);
    output.innerHTML = notice('目标台账 ' + target.name + ' · 盘点日期 ' + preview.day + ' · 库存预警线 ' + preview.threshold) +
      notice(preview.ready ? '确认后将新增 ' + preview.items.length + ' 条库存记录。' : '请处理下方缺项和重复 SKU，然后重新预览。') +
      list(preview.items, sku => {
        const price = sku.priceMinor === null ? '未填写' : '¥' + (sku.priceMinor / 100).toFixed(2);
        const messages = [
          ...sku.missing.map(label => '缺少' + label),
          ...sku.conflicts.map(conflict => '重复 SKU ' + conflict.sku + '，台账商品「' + conflict.title + '」'),
        ];
        return item((sku.specification || '未填写规格') + ' · ' + (sku.sku || '未填写 SKU'),
          '售价 ' + price + ' · 库存 ' + (sku.stock ?? '未填写'),
          messages.length ? notice(messages.join('；')) : notice('可入账'));
      });
    pending = preview.ready ? { url, book, body: { ...body, previewId: preview.previewId } } : null;
    confirmButton.hidden = !pending;
    review.hidden = false;
    if (pending) confirmButton.focus();
  });
  ctx.click('confirm-import', async () => {
    if (!pending) return;
    const { url, book, body } = pending;
    try {
      const result = await ctx.api(url + '/confirm', { method: 'POST', body });
      if (ctx.active()) {
        toast('已写入 ' + result.inserted + ' 条库存记录');
        ctx.go('commerce/' + book + '/inventory');
      }
    } catch (error) {
      if (ctx.active() && error.code === 'INVENTORY_PREVIEW_CHANGED') reset();
      throw error;
    }
  });
}

function renderCheck(check) {
  const problems = [
    ...check.missing,
    ...check.variantChecks.filter(v => v.missing.length).map(v => '规格「' + v.specification + '」缺少' + v.missing.join('、')),
  ];
  return item(check.title, problems.length ? '待补：' + problems.join('；') : '工作台检查项均已填写',
    link('编辑商品草稿', 'drafts/' + check.id));
}

export async function listingDrafts(ctx) {
  const [id, view, source] = ctx.args;
  if (view === 'inventory' && ctx.manager && id !== 'new') return inventoryImport(ctx, id);
  if (id === 'quality') {
    const checks = await ctx.all(endpoint + '/quality');
    ctx.html(heading('草稿资料检查', '按工作台字段检查完整度。平台资质和审核结果需在店铺核实。') +
      link('返回草稿列表','drafts') + panel('检查结果', list(checks, renderCheck)));
    return;
  }
  if (!id) {
    const records = await ctx.all(endpoint);
    ctx.html(heading('拼多多草稿', '保存在当前工作区，仅自己可见。') + link('新建商品草稿', 'drafts/new') + link('检查草稿资料', 'drafts/quality') +
      panel('我的草稿', list(records, record => item(record.title, '最近保存于 ' + date(record.updatedAt),
        link('继续编辑', 'drafts/' + record.id)), '还没有保存的商品草稿。')));
    return;
  }
  const [draft, assets, task] = await Promise.all([
    id === 'new' ? { id: uid(), revision: 0, images: [], variants: [] } : ctx.api(endpoint + '/' + path(id)),
    ctx.all('/v1/assets'),
    id === 'new' && view === 'text' && source ? ctx.api('/v1/tasks/' + path(source)) : null,
  ]);
  if (!ctx.active()) return;
  const imageOptions = assets.filter(a => ['image/jpeg','image/png'].includes(a.mediaType)).map(a => [a.id, a.name]);
  if (id === 'new' && view === 'image') {
    if (!imageOptions.some(([assetId]) => assetId === source)) throw new Error('当前工作区找不到这张图片');
    draft.images = [{ role: 'main', assetId: source }];
  }
  if (task) {
    const description = task.result?.text;
    if (task.state !== 'succeeded' || typeof description !== 'string' || !description.length || description.length > 8000) {
      throw new Error('该任务没有可用作商品描述的文本');
    }
    draft.description = description;
  }
  const imageFields = roles.map(([role, label]) => {
    const selected = draft.images.filter(img => img.role === role).map(img => img.assetId);
    if (role === 'detail') {
      const options = [...selected.map(id => imageOptions.find(([key]) => key === id)).filter(Boolean),
        ...imageOptions.filter(([key]) => !selected.includes(key))];
      return field(label + '（可多选）', select('image-' + role, options, selected, 'multiple size="4"'));
    }
    return field(label, select('image-' + role, [['','请选择'], ...imageOptions], selected[0] ?? '', role === 'main' ? 'required' : ''));
  }).join('');
  const fields = textField('商品标题', 'title', draft.title, 'required maxlength="200"') +
    textField('商品类目', 'category', draft.category, 'maxlength="200"') +
    field('商品描述', textarea('description', 'maxlength="8000"', draft.description)) + imageFields +
    '<div data-draft-preview aria-live="polite"></div>' +
    '<fieldset class="live-item"><legend>主规格</legend>' +
    textField('规格', 'specification', draft.specification, 'maxlength="200"') +
    textField('商家 SKU 编码', 'sku', draft.sku, 'maxlength="100"') +
    priceField(draft.priceMinor) + stockField(draft.stock) + '</fieldset>' +
    '<div data-variant-list>' + draft.variants.map(v => variantFields(v, imageOptions)).join('') + '</div>' +
    action('添加规格', 'add-variant');
  ctx.html(heading(draft.revision ? draft.title : '新建拼多多商品草稿',
    draft.revision ? '工作台草稿 · 最近保存于 ' + date(draft.updatedAt) : '选好主图并填写标题即可保存，其余信息可稍后补充。') +
    link('返回草稿列表', 'drafts') +
    (draft.revision && ctx.manager ? link('预览入账', 'drafts/' + draft.id + '/inventory') : '') + grid(
      panel('上传商品图片', form('draft-upload', field('用途', select('role', roles, 'main')) +
        field('图片', input('file', 'type="file" required accept=".jpg,.jpeg,.png"')) +
        field('素材来源', input('source', 'required maxlength="200"')), '上传并选用')),
      panel('商品信息与图片', form('save-draft', fields, '保存到工作台草稿'))));

  const editor = document.querySelector('[data-form="save-draft"]');
  const preview = editor.querySelector('[data-draft-preview]');
  const variants = editor.querySelector('[data-variant-list]');
  const addVariant = editor.querySelector('[data-add-variant]');
  function updateAddButton() {
    addVariant.disabled = variants.children.length >= 49;
  }
  updateAddButton();
  addVariant.addEventListener('click', () => {
    if (variants.children.length >= 49) return;
    variants.insertAdjacentHTML('beforeend', variantFields({}, imageOptions));
    updateAddButton();
    variants.lastElementChild.querySelector('input').focus();
  });
  variants.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-variant]');
    if (!remove) return;
    remove.closest('[data-variant]').remove();
    updateAddButton();
    addVariant.focus();
  });
  let previewUrl, pendingUpload = false, sequence = 0;
  function release() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  ctx.signal.addEventListener('abort', release, { once: true });
  async function showMain() {
    const run = ++sequence;
    release();
    preview.replaceChildren();
    const assetId = editor.elements['image-main'].value;
    if (!assetId) return;
    const response = await ctx.api('/v1/assets/' + path(assetId) + '/content', { raw: true });
    const blob = await response.blob();
    if (!ctx.active() || sequence !== run) return;
    previewUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.src = previewUrl;
    img.alt = '所选商品主图';
    img.style.maxWidth = 'min(100%, 240px)';
    preview.replaceChildren(img);
  }
  ctx.on('[data-form="save-draft"] [name="image-main"]', 'change', showMain);
  ctx.submit('draft-upload', async (data, uploader) => {
    const role = data.get('role');
    if (!/\.(jpe?g|png)$/i.test(data.get('file').name)) throw new Error('请选择 JPEG 或 PNG 图片。');
    data.set('purpose', '拼多多商品草稿 · ' + roles.find(([key]) => role === key)[1]);
    pendingUpload = true;
    try {
      const asset = await uploadMedia(ctx, data);
      if (!ctx.active()) return;
      for (const [key] of roles) {
        const option = new Option(asset.name, asset.id);
        editor.elements['image-' + key].add(option);
        if (role === key) option.selected = true;
      }
      imageOptions.push([asset.id, asset.name]);
      for (const control of variants.querySelectorAll('select[name="variant-image"]')) {
        control.add(new Option(asset.name, asset.id));
      }
      uploader.elements.file.value = '';
      toast('图片已存入素材库并选用');
      if (role === 'main') await showMain();
    } finally { pendingUpload = false; }
  });
  ctx.submit('save-draft', async data => {
    if (pendingUpload) throw new Error('请等图片上传完成后再保存。');
    const images = roles.flatMap(([role]) => data.getAll('image-' + role).filter(Boolean).map(assetId => ({ role, assetId })));
    if (images.filter(img => img.role === 'detail').length > 20) throw new Error('最多可选 20 张详情图。');
    const body = { revision: draft.revision, title: data.get('title'), category: data.get('category'),
      specification: data.get('specification'), sku: data.get('sku'), description: data.get('description'),
      priceMinor: priceValue(data.get('price')), stock: stockValue(data.get('stock')),
      images, variants: readVariants(variants) };
    const saved = await ctx.api(endpoint + '/' + path(draft.id), { method: 'PUT', body });
    if (ctx.active()) { toast('已保存到工作台草稿'); ctx.go('drafts/' + saved.id); }
  });
  await showMain();
}
