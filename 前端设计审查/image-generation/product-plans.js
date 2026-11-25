import { assetPreview } from '../live-asset-preview.js';
import { downloadFile } from '../live-files.js';
import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, retryKey, select, textarea } from '../live-ui.js';

const endpoint = '/v1/media/images/product-plans';
const draftsEndpoint = '/v1/studio/pinduoduo-drafts';
const route = 'image-plans';
const planStates = { draft: '草稿', generating: '正在生成', succeeded: '全部完成', partial: '部分完成', failed: '生成未完成' };
const imageStates = { planned: '待确认', queued: '排队中', running: '正在生成', succeeded: '已完成', failed: '失败', cancelled: '已取消', unavailable: '结果不可用' };

async function listPlans(ctx) {
  const [plans, assets] = await Promise.all([ctx.all(endpoint), ctx.all('/v1/assets')]);
  const images = assets.filter(asset => ['image/png', 'image/jpeg'].includes(asset.mediaType));
  const fields = field('商品名称', input('productName', 'required maxlength="200"')) +
    field('商品和画面要求', textarea('requirements', 'required maxlength="1000"')) +
    field('商品原图（最多 6 张）', select('assetId', images.map(asset => [asset.id, asset.name]), '', 'multiple required')) +
    field('详情图张数（另生成一张主图）', input('detailCount', 'type="number" min="0" max="7" value="5" required'));
  ctx.html(heading('商品组图方案', '先编辑逐张方案，确认后才提交生图任务。') +
    '<div class="live-row">' + link('返回图片生成', 'desk/image') + link('上传商品原图', 'assets') + '</div>' +
    grid(panel('新建方案', images.length ? form('image-plan-create', fields, '创建组图方案') : notice('请先上传 PNG 或 JPEG 商品图。')),
      panel('已有方案', list(plans, plan => item(plan.productName, (plan.confirmedAt ? '已确认' : '草稿') + ' · ' + date(plan.updatedAt),
        link('打开方案', route + '/' + path(plan.id)))))));
  const key = retryKey();
  ctx.submit('image-plan-create', async data => {
    const assetIds = data.getAll('assetId');
    if (assetIds.length > 6) throw new Error('最多选择 6 张原图。');
    const brief = { productName: data.get('productName').trim(), requirements: data.get('requirements').trim(),
      assetIds, detailCount: Number(data.get('detailCount')) };
    const plan = await ctx.api(endpoint, { method: 'POST', body: { id: key(brief), ...brief } });
    ctx.go(route + '/' + path(plan.id));
  });
}

function planEditor(ctx, plan, url, models, wallet, available) {
  const fields = field('整组设计要求', textarea('designNotes', 'required maxlength="1300"', plan.designNotes)) +
    plan.images.map((image, index) => '<fieldset><legend>' + (index ? '详情图 ' + index : '主图') + '</legend>' +
      field('标题', input('imageTitle', 'required maxlength="160" value="' + h(image.title) + '"')) +
      field('画面方案', textarea('direction', 'required maxlength="1200"', image.direction)) + '</fieldset>').join('');
  const confirmation = available ? form('image-plan-confirm',
    field('生图模型', select('modelId', [['', '按工作区配置选择'], ...models.map(model => [model.id, model.id + ' · ' + model.model])])),
    '确认并生成 · ' + plan.estimatedCredits + ' 积分') : notice('当前工作区没有可用的主图生成能力。');
  ctx.html(heading(plan.source.productName, plan.source.requirements) + link('返回方案列表', route) +
    grid(panel('逐张设计', form('image-plan-edit', fields, '保存修改')),
      panel('提交生成', notice('当前可用 ' + wallet.available + ' 积分。请先保存对方案的改动。') + confirmation)));
  const editor = document.querySelector('[data-form=image-plan-edit]');
  const confirmButton = document.querySelector('[data-form=image-plan-confirm] button');
  const readLayout = data => ({
    designNotes: data.get('designNotes').trim(),
    images: plan.images.map(({ role }, index) => ({
      role, title: data.getAll('imageTitle')[index].trim(), direction: data.getAll('direction')[index].trim(),
    })),
  });
  const savedLayout = JSON.stringify(readLayout(new FormData(editor)));
  const dirty = () => JSON.stringify(readLayout(new FormData(editor))) !== savedLayout;
  editor.addEventListener('input', () => { if (confirmButton) confirmButton.disabled = dirty(); });
  ctx.submit('image-plan-edit', async data => {
    await ctx.api(url, { method: 'PUT', body: { revision: plan.revision, ...readLayout(data) } });
    ctx.reload();
  });
  ctx.submit('image-plan-confirm', async data => {
    if (dirty()) throw new Error('请先保存方案修改。');
    const modelId = data.get('modelId');
    await ctx.api(url + '/confirm', { method: 'POST', body: { revision: plan.revision, ...(modelId ? { modelId } : {}) } });
    ctx.reload();
  });
}

function planResults(ctx, plan, url, drafts) {
  const available = plan.images.filter(image => image.state === 'succeeded');
  const options = drafts.map(draft => [draft.id, draft.title]);
  const canApply = available.some(image => image.role === 'main');
  const apply = canApply && options.length ? form('image-plan-apply',
    field('商品草稿', select('draftId', options, '', 'required')) +
    (available.some(image => image.position > 0)
      ? field('同时替换所选详情图', select('detailPosition', available.filter(image => image.position > 0).map(image => [String(image.position), image.title]), '', 'multiple'))
      : ''), '应用到草稿') : canApply ? link('创建商品草稿', 'drafts/new/plan/' + path(plan.id)) : '';
  ctx.html(heading(plan.source.productName, planStates[plan.state]) +
    '<div class="live-row">' + link('返回方案列表', route) + action('刷新状态', 'image-plan-refresh') + '</div>' +
    panel('生成结果', list(plan.images, image => item(image.title,
      imageStates[image.state] + (image.errorCode ? ' · ' + image.errorCode : ''),
      '<div class="live-row">' + (image.taskId ? link('查看任务', 'tasks/' + path(image.taskId)) : '') +
      (image.canRetry ? action('重试此图', 'image-plan-retry', image.position) : '') +
      (image.deliveryUrl ? action('预览图片', 'image-plan-preview', image.position) +
        action('下载带标识图片', 'image-plan-download', image.position) : '') + '</div>'))) +
    '<div data-plan-preview></div>' +
    (apply ? panel('写入拼多多商品草稿', apply) : ''));
  const preview = assetPreview(ctx, document.querySelector('[data-plan-preview]'));
  ctx.click('image-plan-refresh', ctx.reload);
  ctx.click('image-plan-preview', index => {
    const image = plan.images[Number(index)];
    return preview(image.assetId, image.title);
  });
  ctx.click('image-plan-download', async index => {
    const image = plan.images[Number(index)];
    const asset = await ctx.api('/v1/assets/' + path(image.assetId));
    await downloadFile(ctx, image.deliveryUrl, '商品图-' + (image.position + 1) + (asset.mediaType === 'image/jpeg' ? '.jpg' : '.png'));
  });
  ctx.click('image-plan-retry', async index => {
    const image = plan.images[Number(index)];
    await ctx.api(image.retryUrl, { method: 'POST', body: { taskId: image.taskId } });
    ctx.reload();
  });
  ctx.submit('image-plan-apply', async data => {
    const draft = drafts.find(item => item.id === data.get('draftId'));
    const detailPositions = data.getAll('detailPosition').map(Number);
    const saved = await ctx.api(url + '/apply-to-draft', { method: 'POST',
      body: { draftId: draft.id, draftRevision: draft.revision, detailPositions } });
    ctx.go('drafts/' + path(saved.id));
  });
  if (plan.state === 'generating') {
    // Refresh only after a real state change. Keep previews and buttons stable while waiting.
    let timer;
    const revision = plan.images.map(image => image.state).join(',');
    const poll = async () => {
      try {
        const current = await ctx.api(url);
        if (current.images.map(image => image.state).join(',') !== revision || current.state !== plan.state) {
          ctx.reload();
          return;
        }
      } catch {
        if (ctx.active()) document.querySelector('[data-image-plan-refresh]').textContent = '刷新状态（连接中断）';
        return;
      }
      if (ctx.active()) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    ctx.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
}

export async function productImagePlans(ctx) {
  const [id] = ctx.args;
  if (!id) return listPlans(ctx);
  const url = endpoint + '/' + path(id);
  const plan = await ctx.api(url);
  if (plan.confirmedAt) {
    const drafts = plan.images.some(image => image.state === 'succeeded') ? await ctx.all(draftsEndpoint) : [];
    if (ctx.active()) planResults(ctx, plan, url, drafts);
    return;
  }
  const [catalog, { items }, wallet] = await Promise.all([
    ctx.api('/v1/plugins'), ctx.api('/v1/models'), ctx.api('/v1/credits/wallet'),
  ]);
  const available = catalog.items.find(plugin => plugin.id === 'image')?.capabilities
    .some(capability => capability.id === 'image.main-image' && capability.available);
  const models = items.filter(model => model.capabilities.includes('image.main-image'));
  if (ctx.active()) planEditor(ctx, plan, url, models, wallet, available);
}
