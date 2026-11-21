import { action, describeError, panel } from './live.js';

export function replyStreamPanel() {
  return panel('实时回复', '<p id="reply-status" class="live-muted" role="status">正在连接…</p>' +
    '<pre id="reply-text" class="live-result" tabindex="0"></pre>' +
    '<div id="reply-resume" hidden>' + action('继续接收回复', 'resume-reply') + '</div>');
}

async function* readEvents(response) {
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    throw new Error('后端尚未返回实时回复。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let name = '';
  let id = '';
  let data = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (!line) {
          if (name && data.length) yield { name, id, data: JSON.parse(data.join('\n')) };
          name = id = '';
          data = [];
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function pause(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function watchReplyStream(ctx, endpoint, onState) {
  const status = document.querySelector('#reply-status');
  const output = document.querySelector('#reply-text');
  const resume = document.querySelector('#reply-resume');
  let cursor = 0;

  async function listen() {
    resume.hidden = true;
    let failures = 0;
    while (ctx.active()) {
      try {
        const response = await ctx.api(endpoint + '/stream?after=' + cursor, {
          raw: true, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(35000)]),
        });
        let reconnect = false;
        for await (const { name, id, data } of readEvents(response)) {
          if (!ctx.active()) return;
          if (name === 'state') {
            onState(data);
            status.textContent = data.state === 'queued' ? '等待模型开始回复…' : '正在接收模型回复…';
          } else if (name === 'delta') {
            const next = Number(id);
            if (next <= cursor) continue;
            if (next !== cursor + 1 || typeof data.text !== 'string') throw new Error('回复序号中断。');
            output.append(data.text);
            cursor = next;
            failures = 0;
          } else if (name === 'done') {
            if (data.state !== 'succeeded') output.textContent = '';
            ctx.reload();
            return;
          } else if (name === 'reconnect') {
            reconnect = true;
          }
        }
        if (reconnect) {
          status.textContent = '正在续接实时回复…';
          await pause(350, ctx.signal);
          continue;
        }
        throw new Error('实时回复连接已断开。');
      } catch (error) {
        if (!ctx.active()) return;
        if (error.status >= 400 && error.status < 500 && error.status !== 429) {
          status.textContent = describeError(error);
          return;
        }
        if (++failures > 5) {
          status.textContent = '实时回复连接暂时不可用。连接恢复后可继续接收。';
          resume.hidden = false;
          return;
        }
        status.textContent = '连接已断开，正在从上次位置续接…';
        await pause(500 * 2 ** (failures - 1), ctx.signal);
      }
    }
  }

  ctx.click('resume-reply', listen);
  void listen();
}
