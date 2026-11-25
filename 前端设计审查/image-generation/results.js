import { assetPreview } from '../live-asset-preview.js';
import { mainImageCapabilityId } from './options.js';
import { describeError } from '../studio-errors.js';
import { h, link, path, uid } from '../live-ui.js';

const pending = new Set(['queued', 'running']);
const states = { queued: '排队中', running: '生成中', cancelled: '已取消' };
const taskUrl = id => '/v1/tasks/' + path(id);

export function bindQuickResults(ctx, container, onSettled) {
  let current, timer;
  const clear = () => window.clearTimeout(timer);
  ctx.signal.addEventListener('abort', clear, { once: true });

  function schedule(batch, delay) {
    clear();
    timer = window.setTimeout(() => void refresh(batch), delay);
  }

  function panelFor(job) {
    const panel = document.createElement('article');
    panel.className = 'quick-result';
    panel.innerHTML = '<h3>' + h(job.recipe.label) + '</h3><p role="status">等待提交</p><div class="quick-result-image"></div><div class="live-row"></div>';
    container.append(panel);
    return { status: panel.querySelector('p'), image: panel.querySelector('.quick-result-image'), links: panel.querySelector('.live-row') };
  }

  async function showImage(job, task) {
    const output = task.result;
    if (output?.assetId && /^image\//.test(output.mediaType ?? '')) {
      const { width, height } = job.recipe;
      try {
        const batch = await ctx.api('/v1/media/images/batches', { method: 'POST', body: {
          id: job.resizeId, items: [{ key: '主图', assetIds: [output.assetId], width, height, fit: 'contain', format: 'png' }],
        } });
        const final = batch.items[0];
        if (final?.state !== 'succeeded' || !final.assetId || final.width !== width || final.height !== height) {
          throw new Error('无法校准成品尺寸。');
        }
        job.delivered = true;
        job.view.status.textContent = '已生成 · ' + final.width + ' × ' + final.height;
        job.view.links.insertAdjacentHTML('beforeend', link('查看成品', 'assets/' + path(final.assetId)));
        void assetPreview(ctx, job.view.image)(final.assetId, job.recipe.label);
      } catch (error) {
        if (!ctx.active()) return;
        job.view.status.textContent = '原图已生成，尺寸校准未完成。' + describeError(error);
        void assetPreview(ctx, job.view.image)(output.assetId, job.recipe.label);
      }
    } else if (output?.type === 'image' && typeof output.url === 'string' && output.url.startsWith('https://')) {
      const image = new Image();
      image.alt = job.recipe.label;
      image.src = output.url;
      job.view.image.append(image);
      job.view.status.textContent = '已生成外链图，实际尺寸由模型决定。';
    } else {
      job.view.status.textContent = '任务已结束，服务未返回可预览的图片。';
    }
  }

  async function refresh(batch) {
    for (const job of batch.jobs.filter(entry => entry.task && pending.has(entry.task.state))) {
      if (!ctx.active() || current !== batch || batch.submitting) return;
      try {
        job.task = await ctx.api(taskUrl(job.task.id));
        if (!ctx.active() || current !== batch) return;
        job.view.status.textContent = states[job.task.state] ?? (job.task.state === 'failed'
          ? '生成失败' + (job.task.errorCode ? ' · ' + describeError({ code: job.task.errorCode, message: job.task.errorCode }) : '')
          : '正在准备成品…');
        if (job.task.state === 'succeeded') await showImage(job, job.task);
      } catch (error) {
        if (ctx.active()) job.view.status.textContent = '暂时无法读取进度。' + describeError(error);
      }
    }
    if (!ctx.active() || current !== batch || batch.submitting) return;
    if (batch.jobs.some(entry => entry.task && pending.has(entry.task.state))) {
      schedule(batch, 1800);
    } else onSettled({
      completed: batch.jobs.filter(job => job.delivered).length,
      total: batch.jobs.length,
      unconfirmed: batch.jobs.some(job => !job.task),
    });
  }

  return async (recipes, assetIds) => {
    const signature = JSON.stringify([recipes, assetIds]);
    const retry = current?.signature === signature && current.jobs.some(job => !job.task);
    if (!retry) {
      clear();
      container.replaceChildren();
      current = { signature, jobs: recipes.map(recipe => ({ recipe, requestId: uid(), resizeId: uid() })) };
      current.jobs.forEach(job => { job.view = panelFor(job); });
    }
    const batch = current;
    clear();
    batch.submitting = true;
    for (const job of batch.jobs.filter(entry => !entry.task)) {
      try {
        job.view.status.textContent = '正在提交…';
        job.task = await ctx.api('/v1/tasks', { method: 'POST', body: {
          capabilityId: mainImageCapabilityId, mode: 'workflow', idempotencyKey: job.requestId,
          parameters: { ...job.recipe.parameters, ...(assetIds.length ? { assetIds } : {}) },
          ...(job.recipe.imageQuality ? { imageQuality: job.recipe.imageQuality, modelId: job.recipe.modelId } : {}),
        } });
        if (!ctx.active()) return null;
        job.view.links.innerHTML = link('查看任务', 'tasks/' + path(job.task.id));
        job.view.status.textContent = states[job.task.state] ?? (job.task.state === 'failed' ? '生成失败' : '正在准备成品…');
        if (job.task.state === 'succeeded') await showImage(job, job.task);
      } catch (error) {
        if (!ctx.active()) return null;
        job.view.status.textContent = '提交未确认。' + describeError(error);
      }
    }
    batch.submitting = false;
    schedule(batch, 1000);
    return batch.jobs.filter(entry => entry.task).length;
  };
}
