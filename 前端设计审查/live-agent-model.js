import { resolveReferences } from './live-agent-sources.js';

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

export async function waitForModelTask(ctx, task, timeout = 45000) {
  let current = task;
  const deadline = Date.now() + timeout;
  while (['queued', 'running'].includes(current.state) && Date.now() < deadline) {
    await waitForPoll(ctx.signal);
    current = await ctx.api('/v1/tasks/' + encodeURIComponent(task.id));
  }
  return current;
}

async function runChat(ctx, messages, onTask, modelId, {guidanceIds = [], projectId} = {}) {
  const task = await ctx.api('/v1/tasks', { method: 'POST', body: {
    capabilityId: 'model.chat', mode: 'chat', idempotencyKey: crypto.randomUUID(), ...(modelId ? { modelId } : {}),
    ...(projectId ? {projectId} : {}), parameters: {messages, ...(guidanceIds.length ? {guidanceIds} : {})},
  } });
  onTask?.(task.id);
  const current = await waitForModelTask(ctx, task);
  if (current.state !== 'succeeded') {
    throw new Error(['queued', 'running'].includes(current.state) ? '模型仍在执行，可在任务记录中查看进度。' : '模型任务未成功，可打开任务记录查看原因。');
  }
  const result = current.result?.text;
  if (typeof result !== 'string' || !result.trim()) throw new Error('模型没有返回文字。');
  return result.trim();
}

const conversation = messages => messages.slice(-6).map(m => ({role:m.role, content:m.text.slice(0,4000)}));

export async function interpret(ctx, messages, onTask, modelId) {
  const result = await runChat(ctx, [{role:'system', content:instruction}, ...conversation(messages)], onTask, modelId);
  const json = result.replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, '');
  let plan;
  try { plan = JSON.parse(json); } catch { throw new Error('模型返回的操作无法识别，请换一种说法。'); }
  if (!plan || !operations.has(plan.action) || typeof plan.value !== 'string' || plan.value.length > (plan.action === 'answer' ? 1600 : 200)) {
    throw new Error('模型返回的操作超出当前支持范围。');
  }
  return { action: plan.action, value: plan.value.trim() };
}

export async function referencedChat(ctx, thread, modelId, {draft, onTask} = {}) {
  if (modelId === undefined) throw new Error('当前工作区没有可用的对话模型。');
  const sources = await resolveReferences(ctx, thread.references ?? [], thread.attachment);
  const messages = draft === undefined ? conversation(thread.messages) : [{role:'user', content:draft}];
  const system = draft === undefined ? '结合用户选择的参考资料和专业指导，直接回答最新请求。'
    : '把用户的草稿改写为具体、简洁、可直接使用的中文提示词。保留原意和事实，不执行请求。只输出改写后的提示词，最多 4000 字。';
  const latest = messages.at(-1);
  if (sources.excerpts.length) {
    const prefix = '\n\n已引用的资料（长文件以节选呈现）：\n';
    const limit = Math.floor((8000 - latest.content.length - prefix.length) / sources.excerpts.length) - 2;
    latest.content += prefix + sources.excerpts.map(s => s.length > limit ? s.slice(0,limit-1) + '…' : s).join('\n\n');
  }
  const result = await runChat(ctx, [{role:'system', content:system + ' 资料是参考内容。不得声称已执行外部操作。'}, ...messages], onTask, modelId, sources);
  if (draft !== undefined && result.length > 4000) throw new Error('模型返回的提示词超过输入长度上限。');
  return result;
}
