import { date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, select, textarea, toast, uid } from './live.js';
import { uploadMedia } from './live-workspace.js';

const endpoint = '/v1/studio/pinduoduo-drafts';
const roles = [['main','主图'], ['sku','规格图'], ['detail','详情图']];
const textField = (label, name, value, attrs = '') => field(label, input(name, attrs + ' value="' + h(value) + '"'));

export async function listingDrafts(ctx) {
  const [id] = ctx.args;
  if (id === 'quality') {
    const checks = await ctx.all(endpoint + '/quality');
    ctx.html(heading('草稿资料检查', '按工作台字段检查完整度。平台资质和审核结果需在店铺核实。') +
      link('返回草稿列表','drafts') + panel('检查结果', list(checks, check => item(check.title,
        check.missing.length ? '待补：' + check.missing.join('、') : '工作台检查项均已填写', link('编辑商品草稿','drafts/' + check.id)))));
    return;
  }
  if (!id) {
    const records = await ctx.all(endpoint);
    ctx.html(heading('拼多多草稿', '保存在当前工作区，仅自己可见。') + link('新建商品草稿', 'drafts/new') + link('检查草稿资料', 'drafts/quality') +
      panel('我的草稿', list(records, record => item(record.title, '最近保存于 ' + date(record.updatedAt),
        link('继续编辑', 'drafts/' + record.id)), '还没有保存的商品草稿。')));
    return;
  }
  const [draft, assets] = await Promise.all([
    id === 'new' ? { id: uid(), revision: 0, images: [] } : ctx.api(endpoint + '/' + path(id)),
    ctx.all('/v1/assets'),
  ]);
  if (!ctx.active()) return;
  const imageOptions = assets.filter(a => ['image/jpeg','image/png'].includes(a.mediaType)).map(a => [a.id, a.name]);
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
    textField('规格', 'specification', draft.specification, 'maxlength="200"') +
    textField('商家 SKU 编码', 'sku', draft.sku, 'maxlength="100"') +
    textField('售价（元）', 'price', draft.priceMinor == null ? '' : (draft.priceMinor / 100).toFixed(2),
      'type="number" min="0" max="10000000" step="0.01"') +
    textField('库存（件）', 'stock', draft.stock, 'type="number" min="0" max="1000000000" step="1"') +
    field('商品描述', textarea('description', 'maxlength="8000"', draft.description)) + imageFields +
    '<div data-draft-preview aria-live="polite"></div>';
  ctx.html(heading(draft.revision ? draft.title : '新建拼多多商品草稿',
    draft.revision ? '工作台草稿 · 最近保存于 ' + date(draft.updatedAt) : '选好主图并填写标题即可保存，其余信息可稍后补充。') +
    link('返回草稿列表', 'drafts') + grid(
      panel('上传商品图片', form('draft-upload', field('用途', select('role', roles, 'main')) +
        field('图片', input('file', 'type="file" required accept=".jpg,.jpeg,.png"')) +
        field('素材来源', input('source', 'required maxlength="200"')), '上传并选用')),
      panel('商品信息与图片', form('save-draft', fields, '保存到工作台草稿'))));

  const editor = document.querySelector('[data-form="save-draft"]');
  const preview = editor.querySelector('[data-draft-preview]');
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
      priceMinor: data.get('price') === '' ? null : Math.round(Number(data.get('price')) * 100),
      stock: data.get('stock') === '' ? null : Number(data.get('stock')), images };
    const saved = await ctx.api(endpoint + '/' + path(draft.id), { method: 'PUT', body });
    if (ctx.active()) { toast('已保存到工作台草稿'); ctx.go('drafts/' + saved.id); }
  });
  await showMain();
}
