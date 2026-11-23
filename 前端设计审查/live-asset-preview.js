import { path } from './live-ui.js';

// Each preview belongs to one mounted view. A late download cannot replace a newer selection.
export function assetPreview(ctx, container) {
  let pending;
  return async (id, label) => {
    pending?.abort();
    container.replaceChildren();
    if (!id || !ctx.active()) return;
    const request = new AbortController();
    const cancel = () => request.abort();
    pending = request;
    ctx.signal.addEventListener('abort', cancel, { once: true });
    container.textContent = '正在读取图片…';
    let url;
    try {
      const response = await ctx.api('/v1/assets/' + path(id) + '/content', { raw: true, signal: request.signal });
      const blob = await response.blob();
      if (request.signal.aborted || !container.isConnected) return;
      const img = new Image();
      img.alt = label;
      img.className = 'live-source-photo';
      url = URL.createObjectURL(blob);
      img.src = url;
      await img.decode();
      if (!request.signal.aborted && container.isConnected) container.replaceChildren(img);
    } catch {
      if (!request.signal.aborted) container.textContent = '图片预览不可用';
    } finally {
      if (url) URL.revokeObjectURL(url);
      ctx.signal.removeEventListener('abort', cancel);
      if (pending === request) pending = null;
    }
  };
}
