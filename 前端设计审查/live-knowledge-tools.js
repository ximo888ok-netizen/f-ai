import { action, field, form, h, heading, input, item, link, list, notice, panel, path, result, select, textarea } from './live-ui.js';

export function customerScopeField(products, scope = null) {
  return field('客服可引用范围', select('customerScope', [
    ['', '仅工作区内部检索'], ['general', '通用客服知识'],
    ...products.map(product => [product.id, product.sku + ' · ' + product.name]),
  ], scope?.general ? 'general' : scope?.productId ?? ''));
}

export function readCustomerScope(value) {
  return value === 'general' ? { general: true } : value ? { productId: value } : null;
}

export async function categoryPage(ctx, id) {
  const endpoint = '/v1/knowledge/bases/' + path(id) + '/categories';
  const categories = await ctx.all(endpoint);
  ctx.html(heading('知识库分类') + link('返回知识库', 'resources/' + id) + panel('已有分类',
    list(categories, c => item(c.name, '', link('查看资料', 'resources/' + id + '/category/' + path(c.id)) +
      (ctx.manager ? action('删除空分类', 'remove-category', c.id) : '')))) +
    (ctx.manager ? panel('新增分类', form('add-category', field('分类名称', input('name','required maxlength="100"')), '新增')) +
      (categories.length ? panel('重命名分类', form('rename-category', field('分类', select('id', categories.map(c=>[c.id,c.name]))) +
        field('新名称', input('name','required maxlength="100"')), '更新分类和文档标签')) : '') : ''));
  if (!ctx.manager) return;
  ctx.submit('add-category', async data => { await ctx.api(endpoint, { method:'POST', body:{ name:data.get('name') } }); ctx.reload(); });
  ctx.submit('rename-category', async data => { await ctx.api(endpoint + '/' + path(data.get('id')), { method:'PATCH', body:{ name:data.get('name') } }); ctx.reload(); });
  ctx.click('remove-category', async value => {
    if (confirm('删除这个空分类？')) { await ctx.api(endpoint + '/' + path(value), { method:'DELETE' }); ctx.reload(); }
  });
}

export async function categoryDocs(ctx, id, categoryId) {
  const base = '/v1/knowledge/bases/' + path(id);
  const category = (await ctx.all(base + '/categories')).find(c => c.id === categoryId);
  if (!category) throw new Error('这个分类已不存在。');
  const docs = await ctx.all(base + '/documents?category=' + path(category.name));
  ctx.html(heading(category.name) + link('返回分类', 'resources/' + id + '/categories') +
    panel('分类资料', list(docs, d => item(d.name, d.category, link('阅读', 'resources/' + id + '/' + d.id)), '此分类暂无文档。')));
}

export async function knowledgeDocument(ctx, id, documentId) {
  const url = '/v1/knowledge/bases/' + path(id) + '/documents/' + path(documentId);
  const [doc, products] = await Promise.all([ctx.api(url), ctx.manager ? ctx.all('/v1/studio/products') : []]);
  ctx.html(heading(doc.name, doc.category) + link('返回知识库', 'resources/' + id) + panel('文档内容', result(doc.content)) +
    (ctx.manager ? '<details class="card live-panel live-fold"><summary>编辑文档</summary>' +
      form('edit-document', field('名称', input('name', 'required maxlength="200" value="' + h(doc.name) + '"')) +
        field('分类', input('category', 'maxlength="100" value="' + h(doc.category) + '"')) +
        customerScopeField(products, doc.customerScope) +
        field('正文', textarea('content','required maxlength="200000"',doc.content)), '保存并更新检索内容') + '</details>' : ''));
  if (ctx.manager) ctx.submit('edit-document', async data => {
    const body = Object.fromEntries(data);
    body.customerScope = readCustomerScope(body.customerScope);
    await ctx.api(url, { method:'PATCH', body }); ctx.reload();
  });
}

export async function webSearch(ctx) {
  const url = '/v1/search/web';
  const { available } = await ctx.api(url);
  ctx.html(heading('联网检索') + link('返回知识库', 'resources') + panel('搜索公开网页', available
    ? form('web-search', field('关键词', input('query', 'required maxlength="400"')), '搜索') + '<div data-web-results aria-live="polite"></div>'
    : notice('当前环境未接入搜索服务。可返回知识库检索工作区文档。')));
  if (!available) return;
  ctx.submit('web-search', async data => {
    const target = document.querySelector('[data-web-results]');
    target.textContent = '正在检索…';
    try {
      const {items} = await ctx.api(url, { method:'POST', body:{ query:data.get('query'), limit:8 } });
      if (ctx.active()) target.innerHTML = list(items, r => item(r.title, r.excerpt,
        '<a class="smallbtn" rel="noopener noreferrer" target="_blank" href="' + h(r.url) + '">打开来源</a>'), '没有找到结果。');
    } catch (error) { if (ctx.active()) target.textContent = '搜索未完成，可以重新搜索。'; throw error; }
  });
}
