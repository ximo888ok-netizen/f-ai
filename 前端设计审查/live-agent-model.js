const operations = new Set(['products', 'tasks', 'drafts', 'balance', 'draft', 'cover', 'answer', 'help']);
const instruction = '你是电商工作区的意图解析器，只返回一个 JSON 对象 {"action":"...","value":"..."}。' +
  'products 查询商品，value 是商品关键词；tasks 查询任务，value 可取 queued/running/succeeded/failed/cancelled 或空；' +
  'drafts 列出草稿；balance 查询积分；draft 表示用户明确要创建商品草稿，value 是明确给出的标题或空字符串。' +
  'cover 表示从已有图片居中裁切商品主图，value 为明确尺寸如 800x800 或空字符串。' +
  '一般咨询可返回 answer，value 为简短建议；不确定的写入或其他操作返回 help。不得输出 API、链接或宣称执行成功。';

function waitForPoll(signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    function abort() { clearTimeout(timer); reject(signal.reason); }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 900);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function modelCapability(ctx) {
  const { models } = await ctx.api('/v1/plugins');
  return models.enabled && models.capabilities.find(c => c.id === 'model.chat' && c.available);
}

export async function interpret(ctx, messages, onTask, modelId) {
  const task = await ctx.api('/v1/tasks', { method: 'POST', body: {
    capabilityId: 'model.chat', mode: 'chat', idempotencyKey: crypto.randomUUID(), ...(modelId ? { modelId } : {}),
    parameters: { messages: [{ role: 'system', content: instruction },
      ...messages.slice(-6).map(m => ({ role: m.role, content: m.text.slice(0, 4000) }))] },
  } });
  onTask(task.id);
  let current = task;
  const deadline = Date.now() + 45000;
  while (['queued', 'running'].includes(current.state) && Date.now() < deadline) {
    await waitForPoll(ctx.signal);
    current = await ctx.api('/v1/tasks/' + encodeURIComponent(task.id));
  }
  if (current.state !== 'succeeded') {
    throw new Error(['queued', 'running'].includes(current.state) ? '模型仍在执行，可在任务记录中查看进度。' : '模型任务未成功，可打开任务记录查看原因。');
  }
  const json = String(current.result?.text ?? '').trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, '');
  let plan;
  try { plan = JSON.parse(json); } catch { throw new Error('模型返回的操作无法识别，请换一种说法。'); }
  if (!plan || !operations.has(plan.action) || typeof plan.value !== 'string' || plan.value.length > (plan.action === 'answer' ? 1600 : 200)) {
    throw new Error('模型返回的操作超出当前支持范围。');
  }
  return { action: plan.action, value: plan.value.trim() };
}
