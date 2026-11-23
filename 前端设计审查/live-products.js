import { downloadContent } from './live-text-delivery.js';
import { searchable } from './live-record-tools.js';

import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, select, textarea, toast, uid } from './live.js';

const root = '/v1/studio';
const productPath = root + '/products';
const categoryPath = root + '/categories';
const nameField = (name, value, limit) => field(name, input('name', 'required maxlength="' + limit + '" value="' + h(value) + '"'));

function productFields(product, categories) {
  return field('SKU', input('sku', 'required maxlength="100" value="' + h(product.sku) + '"')) +
    nameField('商品名称', product.name, 200) + field('描述', textarea('description', 'maxlength="8000"', product.description)) +
    field('分类', select('categoryId', [['','未分类'], ...categories.map(entry => [entry.id, entry.name])], product.categoryId ?? ''));
}

function productBody(fields) {
  const product = Object.fromEntries(fields);
  product.categoryId ||= null;
  return product;
}

function saveCatalog(data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'fai-products.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function products(ctx) {
  const [tab, id] = ctx.args;
  const tabs = '<div class="live-row">' + link('商品清单', 'products') + link('分类管理', 'products/categories') + link('拼多多草稿', 'drafts') + link('导入与导出', 'products/transfers') + '</div>';
  const categories = await ctx.all(categoryPath);
  if (tab === 'categories') { drawCategories(ctx, categories, tabs); return; }
  const entries = await ctx.all(productPath);
  if (tab === 'transfers') { await drawTransfers(ctx, entries, tabs); return; }
  if (tab === 'edit') {
    const product = entries.find(item => item.id === id);
    if (!product) { ctx.html(heading('商品档案') + tabs + notice('当前工作区没有这个商品。')); return; }
    ctx.html(heading(product.name, 'SKU · ' + product.sku) + tabs +
      (ctx.manager ? grid(panel('更新资料', form('edit-product', productFields(product, categories))) +
        panel('复用商品档案', form('duplicate-product', field('副本 SKU', input('sku', 'required maxlength="100"')), '保存为新商品')) +
        panel('删除商品', action('删除商品档案', 'delete-product', product.id))) : panel('商品描述', notice(product.description))));
    ctx.submit('edit-product', async fields => { await ctx.api(productPath + '/' + path(id), { method: 'PUT', body: productBody(fields) }); ctx.reload(); });
    ctx.submit('duplicate-product', async fields => {
      const { name, description, categoryId } = product;
      const entry = await ctx.api(productPath, { method:'POST', body:{ sku:fields.get('sku'), name, description, categoryId } });
      ctx.go('products/edit/' + entry.id);
    });
    ctx.click('delete-product', async item => {
      if (!confirm('删除这条商品档案？')) return;
      await ctx.api(productPath + '/' + path(item), { method:'DELETE' });
      ctx.go('products');
    });
    return;
  }
  ctx.html(heading('商品档案') + tabs + grid(panel('商品清单', searchable('搜索商品名称、SKU 或分类',list(entries, product => item(product.name,
    product.sku + ' · ' + (categories.find(v => v.id === product.categoryId)?.name ?? '未分类'),
    link('详情', 'products/edit/' + product.id))))),
  ...(ctx.manager ? [panel('创建商品档案', form('new-product', productFields({}, categories), '创建商品'))] : [])));
  ctx.submit('new-product', async fields => {
    const entry = await ctx.api(productPath, { method:'POST', body:productBody(fields) });
    ctx.go('products/edit/' + entry.id);
  });
}

function drawCategories(ctx, categories, tabs) {
  ctx.html(heading('分类管理') + tabs +
    (ctx.manager ? panel('创建分类', form('new-category', nameField('分类名称', '', 100), '创建')) : '') +
    panel('已有分类', list(categories, entry => item(entry.name, '', ctx.manager ?
      '<details><summary>编辑分类</summary>' + form('rename-' + entry.id, nameField('分类名称', entry.name, 100)) +
      action('删除分类', 'delete-category', entry.id) + '</details>' : ''))));
  ctx.submit('new-category', async fields => {
    await ctx.api(categoryPath, { method:'POST', body:Object.fromEntries(fields) });
    ctx.reload();
  });
  for (const entry of categories) ctx.submit('rename-' + entry.id, async fields => {
    await ctx.api(categoryPath + '/' + path(entry.id), { method:'PATCH', body:Object.fromEntries(fields) });
    ctx.reload();
  });
  ctx.click('delete-category', async id => {
    if (!confirm('删除没有分配商品的分类？')) return;
    await ctx.api(categoryPath + '/' + path(id), { method:'DELETE' });
    ctx.reload();
  });
}

async function drawTransfers(ctx, entries, tabs) {
  const transfers = await ctx.all(root + '/transfers');
  ctx.html(heading('导入与导出记录') + tabs + grid(
    ...(ctx.manager ? [panel('导入商品包', notice('选择导出的 JSON 文件。单次最多 100 项，任一 SKU 重复时整批退回。') +
      form('import', field('商品包', input('file', 'type="file" accept=".json,application/json" required')), '导入到工作区'))] : []),
    panel('导出商品包', entries.length ? form('export', field('选择商品（可多选）',
      select('ids', entries.map(entry => [entry.id, entry.sku + ' · ' + entry.name]), undefined, 'multiple required')), '生成并下载') : notice('没有可导出的商品。'))) +
    panel('历史记录', list(transfers, record => item((record.direction === 'import' ? '导入 ' : '导出 ') + record.count + ' 项', date(record.createdAt)))));
  ctx.submit('import', async fields => {
    const file = fields.get('file');
    if (file.size > 4 * 1024 * 1024) throw new Error('商品包不得超过 4 MiB。');
    let payload;
    try { payload = JSON.parse(await file.text()); }
    catch { throw new Error('无法解析商品包，请检查 JSON 文件。'); }
    const items = Array.isArray(payload) ? payload : payload?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new Error('商品包应包含 1–100 项商品。');
    const response = await ctx.api(productPath + '/import', { method:'POST', body:{ items, reference:uid() } });
    toast('已导入 ' + response.count + ' 项');
    ctx.reload();
  });
  ctx.submit('export', async fields => {
    const ids = fields.getAll('ids');
    const payload = await ctx.api(productPath + '/export', { method:'POST', body:{ ids, reference:uid() } });
    if (ctx.active()) saveCatalog(payload);
    ctx.reload();
  });
}

function roi(ctx) {
  const fields = [['priceMinor','单件售价（分）',0],['unitCostMinor','单件成本（分）',0],['units','预计销量',1],
    ['feesMinor','其他费用合计（分）',0],['adSpendMinor','广告费（分）',1]];
  ctx.html(heading('投放收益测算', '使用你填写的成本和预计销量，由服务端计算。') +
    panel('测算参数', form('roi', fields.map(([key, label, min]) => field(label, input(key, 'required type="number" step="1" min="' + min + '"'))).join(''), '计算')) +
    '<div id="roi-result"></div>');
  let report;
  ctx.submit('roi', async data => {
    const body = Object.fromEntries(fields.map(([key]) => [key, Number(data.get(key))]));
    const computed = await ctx.api(root + '/roi', { method:'POST', body });
    if (!ctx.active()) return;
    report={parameters:body,result:computed};
    const money = value => new Intl.NumberFormat('zh-CN', { style:'currency', currency:'CNY' }).format(value / 100);
    document.querySelector('#roi-result').innerHTML = panel('测算结果',
      item('预计销售额', money(computed.revenueMinor)) + item('商品成本', money(computed.productCostMinor)) +
      item('扣除成本与广告后的贡献额', money(computed.contributionMinor)) + item('销售额 / 广告费', computed.roas.toFixed(2) + ' 倍')+action('导出本次测算','roi-export'));
    document.querySelector('[data-roi-export]').onclick=()=>downloadContent('投放收益测算.json',JSON.stringify(report,null,2),'application/json');
  });
}

export const productPages = { products, roi };
