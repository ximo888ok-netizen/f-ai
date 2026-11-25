import { h, link, path } from './live-ui.js';
import { describeError } from './studio-errors.js';

export const frameVideoCapabilityId = 'video.from-image';
export const videoTaskPending = task => ['queued', 'running'].includes(task?.state);
export const videoTaskLink = (task, label) => link(label, 'tasks/' + path(task.id));

export async function loadFrameVideo(ctx, plugin, tasks) {
  const [directory, assets] = await Promise.all([ctx.api('/v1/models?capabilityId=' + frameVideoCapabilityId), ctx.all('/v1/assets')]);
  const capability = plugin?.capabilities.find(entry => entry.id === frameVideoCapabilityId);
  const recentIds = new Set(tasks.filter(task => task.capabilityId.startsWith('image.') && task.state === 'succeeded')
    .map(task => task.result?.assetId).filter(Boolean));
  return { capability, available: plugin?.enabled && capability?.available, assets, models: directory.items, recentIds };
}

export function updateFrameVideoSettings(root, fields, bounds) {
  fields.duration.min = bounds.min;
  fields.duration.max = bounds.max;
  for (const option of fields.ratio) option.disabled = Boolean(option.value && !bounds.ratios.includes(option.value));
  if (!bounds.ratios.includes(fields.ratio.value)) fields.ratio.value = '';
  for (const [key, value] of [['min', bounds.min], ['max', bounds.max], ['seconds', fields.duration.value]]) {
    root.querySelector('[data-video-quick-' + key + ']').textContent = value + ' 秒';
  }
}

export function updateVideoProgress(root, phase) {
  for (const [index, step] of [...root.querySelectorAll('.video-quick-progress li')].entries()) {
    if (index === phase) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
    step.toggleAttribute('data-done', index < phase);
  }
}

function externalVideoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function bindVideoResult(ctx, result) {
  let objectUrl;
  function clear() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
    result.replaceChildren();
    result.hidden = true;
  }
  ctx.signal.addEventListener('abort', clear, { once: true });

  async function show(task) {
    if (!ctx.active()) return;
    clear();
    const label = videoTaskPending(task) ? '正在生成视频' : task.state === 'succeeded' ? '成片' : '视频未完成';
    result.innerHTML = '<h4>' + label + '</h4><p role="status"></p>' + videoTaskLink(task, '查看视频任务与下载');
    result.hidden = false;
    const status = result.querySelector('[role="status"]');
    if (task.state !== 'succeeded') {
      if (task.errorCode) status.textContent = describeError({ code: task.errorCode, message: task.errorCode });
      return;
    }
    let source = externalVideoUrl(task.result?.url);
    if (task.result?.assetId && task.result.mediaType === 'video/mp4') {
      try {
        const response = await ctx.api('/v1/assets/' + path(task.result.assetId) + '/content', { raw: true });
        const blob = await response.blob();
        if (!ctx.active()) return;
        source = objectUrl = URL.createObjectURL(blob);
      } catch { /* The task link stays available if inline preview cannot load. */ }
    }
    if (source) result.insertAdjacentHTML('beforeend', '<video controls preload="metadata" aria-label="视频成片" src="' + h(source) + '"></video>');
    else status.textContent = '暂时无法在此预览，可打开任务查看结果。';
  }
  return { clear, show };
}
