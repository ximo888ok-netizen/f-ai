import { date, h, notice } from './live-ui.js';
import { describeError } from './studio-errors.js';

const events = {
  queued: ['已排队', 'neutral'], running: ['开始执行', 'progress'],
  provider_pending: ['等待服务返回', 'progress'], retrying: ['等待重试', 'warning'],
  succeeded: ['已完成', 'success'], failed: ['执行失败', 'error'], cancelled: ['已取消', 'neutral'],
};

function traceNode(entry) {
  const [label, tone] = events[entry.event] ?? [entry.event, 'neutral'];
  return '<li data-tone="' + tone + '"><strong>' + h(label) + '</strong>' +
    '<time datetime="' + h(entry.createdAt) + '">' + h(date(entry.createdAt)) + '</time>' +
    (entry.attempt > 1 ? '<small>第 ' + h(entry.attempt) + ' 次尝试</small>' : '') + '</li>';
}

export function mountTaskTrace(ctx, element, endpoint) {
  let revision = 0;
  async function refresh() {
    const current = ++revision;
    try {
      const { items } = await ctx.api(endpoint + '/events?limit=4');
      if (!ctx.active() || current !== revision) return;
      element.innerHTML = items.length
        ? '<ol class="task-trace-nodes" aria-label="最近执行轨迹，按时间先后排列">' + items.reverse().map(traceNode).join('') + '</ol>'
        : notice('暂无执行记录。');
    } catch (error) {
      if (!ctx.active() || current !== revision) return;
      element.innerHTML = notice('执行轨迹暂时无法读取。' + describeError(error)) +
        '<button type="button" class="smallbtn" data-trace-retry>重试</button>';
    }
  }
  element.addEventListener('click', event => {
    if (event.target.closest('[data-trace-retry]')) void refresh();
  }, { signal: ctx.signal });
  void refresh();
  return refresh;
}
