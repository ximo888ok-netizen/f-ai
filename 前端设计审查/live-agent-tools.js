import { date } from './live-ui.js';
import { cardTitle } from './live-task-fields.js';

const drafts = '/v1/studio/pinduoduo-drafts';
const taskStates = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const contains = (value, search) => String(value ?? '').toLowerCase().includes(search.toLowerCase());

export async function findProducts(ctx, query) {
  const products = await ctx.all('/v1/studio/products');
  const matches = products.filter(p => [p.name, p.sku, p.description].some(field => contains(field, query)));
  const items = matches.slice(0, 5).map(p => ({
    title: p.name, detail: p.sku, route: 'products/edit/' + encodeURIComponent(p.id),
    product: { name: p.name, sku: p.sku, description: p.description ?? '' },
  }));
  const text = query ? '找到 ' + matches.length + ' 个与「' + query + '」相关的商品。' : '当前工作区有 ' + matches.length + ' 个商品。';
  return { text: text + (matches.length > 5 ? '先列出前 5 个。' : ''), items };
}

export async function recentDrafts(ctx) {
  const { items } = await ctx.api(drafts + '?limit=5');
  return { text: items.length ? '最近编辑的商品草稿如下。' : '当前账号还没有商品草稿。可以告诉我想创建哪款商品的草稿。',
    items: items.map(d => ({ title: d.title, detail: date(d.updatedAt), route: 'drafts/' + encodeURIComponent(d.id) })) };
}

export async function recentTasks(ctx, state) {
  const [data, catalog] = await Promise.all([
    ctx.api('/v1/tasks?limit=5' + (Object.hasOwn(taskStates, state) ? '&state=' + state : '')), ctx.api('/v1/plugins'),
  ]);
  const names = new Map([...catalog.items, catalog.models].flatMap(plugin => plugin.capabilities.map(c => [c.id, cardTitle(c)])));
  return { text: data.items.length ? '这是最近' + (taskStates[state] ?? '') + '的 ' + data.items.length + ' 个任务。' : '当前没有符合条件的任务。',
    items: data.items.map(t => ({ title: names.get(t.capabilityId) ?? t.capabilityId,
      detail: (taskStates[t.state] ?? t.state) + ' · ' + date(t.updatedAt), route: 'tasks/' + encodeURIComponent(t.id) })) };
}

export async function findImages(ctx, query = '') {
  const assets = await ctx.all('/v1/assets');
  return assets.filter(a => ['image/jpeg', 'image/png'].includes(a.mediaType) && contains(a.name, query))
    .slice(0, 6).map(a => ({ id: a.id, name: a.name }));
}

export async function saveDraft(ctx, draft) {
  const body = { revision: 0, title: draft.title, images: [{ role: 'main', assetId: draft.image.id }] };
  if (draft.product) Object.assign(body, { sku: draft.product.sku, description: draft.product.description });
  const saved = await ctx.api(drafts + '/' + encodeURIComponent(draft.id), { method: 'PUT', body });
  return { text: '草稿已保存到当前工作区。', items: [{ title: saved.title, detail: '继续编辑商品草稿', route: 'drafts/' + encodeURIComponent(saved.id) }] };
}

export async function renderCover(ctx, job) {
  const batch = await ctx.api('/v1/media/images/batches', { method: 'POST', body: { id: job.id, items: [{
    key: '商品主图', assetIds: [job.image.id], width: job.width, height: job.height, fit: 'cover', format: 'png',
  }] } });
  const output = batch.items[0];
  if (output?.state !== 'succeeded' || !output.assetId) throw new Error('图片处理未成功，请检查素材后重试。');
  return { id: output.assetId, name: job.width + ' × ' + job.height + ' 主图' };
}
