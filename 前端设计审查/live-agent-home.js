import { studioIcon } from './studio-icons.js';
import { assetPreview } from './live-asset-preview.js';
import { h } from './live-ui.js';
import { describeError } from './studio-errors.js';
import { attachImage, respond } from './live-agent-dialogue.js';
import { agentControls, bindAgentControls } from './live-agent-controls.js';
import { uploadMedia } from './live-workspace.js';

const starters = [
  ['查商品', '查看我的商品', 'products'], ['建拼多多草稿', '新建商品草稿', 'copywriting'], ['做方形主图', '做方形主图', 'image'], ['看最近任务', '查看最近任务', 'tasks'],
];
function restore(key) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key));
    if (Array.isArray(saved?.messages)) return saved;
  } catch { /* A browser can disable session storage. */ }
  return { messages: [], input: '' };
}
function messageHtml(message) {
  const user = message.role === 'user';
  return '<article class="agent-message ' + (user ? 'from-user' : 'from-agent') + '"><strong class="agent-author">' +
    (user ? '你' : '工作台助手') + '</strong><p>' + h(message.text) + '</p>' +
    (message.items?.length ? '<div class="agent-results">' + message.items.map((item, i) =>
      '<a href="#' + h(item.route) + '"><span><b>' + (item.product ? (i + 1) + '. ' : '') + h(item.title) +
      '</b>' + (item.detail ? '<small>' + h(item.detail) + '</small>' : '') +
      '</span><i aria-hidden="true">↗</i></a>').join('') + '</div>' : '') + '</article>';
}

export async function agentHome(ctx) {
  const {preferences} = await ctx.api('/v1/settings');
  if (!ctx.active()) return;
  const remember = preferences.rememberConversations !== false;
  const key = 'fai.agent.home.v1:' + ctx.account.id + ':' + ctx.workspace.id;
  if(!remember){try {sessionStorage.removeItem(key);sessionStorage.removeItem(key+':history');} catch {}}
  let thread = remember ? restore(key) : {messages:[], input:''}, busy = false;
  let previous = [];
  try {
    const saved = remember && JSON.parse(sessionStorage.getItem(key + ':history'));
    if (Array.isArray(saved)) previous = saved.filter(t => Array.isArray(t?.messages) && t.messages.length).slice(0, 7);
  } catch { /* Conversations remain available in the current view. */ }
  function archive() {
    if (thread.messages.length) previous.unshift(thread);
    previous = previous.slice(0, 7);
    try { if (remember) sessionStorage.setItem(key + ':history', JSON.stringify(previous)); } catch {}
  }
  const persist = () => {
    thread.messages = thread.messages.slice(-40);
    try { if (remember) sessionStorage.setItem(key, JSON.stringify(thread)); } catch { /* The open conversation still works. */ }
  };
  if (thread.inFlight) {
    thread.inFlight = false;
    thread.messages.push({ role:'assistant', text: thread.draft || thread.cover
      ? '上一次操作的结果尚未确认。可重新提交当前操作，我会用同一个请求编号核对结果。'
      : '上一次请求在离开首页时中断。可以继续发送消息，已提交的模型任务可在任务记录里查看。' });
    persist();
  }
  if (ctx.args?.[0] === 'new') {
    let knowledgeBase;
    if (ctx.args[1] === 'knowledge') {
      const bases = await ctx.all('/v1/knowledge/bases');
      if (!ctx.active()) return;
      knowledgeBase = bases.find(base => base.id === ctx.args[2]);
      if (!knowledgeBase) throw new Error('当前工作区无法访问这个知识库。');
    }
    archive();
    thread = knowledgeBase ? { messages: [], input: '查知识库 ', knowledgeBase: { id: knowledgeBase.id, name: knowledgeBase.name } } : { messages: [], input: '' };
    persist();
    window.history.replaceState(window.history.state, '', '#chat');
  }
  const layout = document.querySelector('#chat-template').content.cloneNode(true);
  layout.querySelector('.agent-starters').innerHTML = starters.map(([label, prompt, icon]) =>
    '<button class="skill-pill" type="button" data-prompt="' + h(prompt) + '">' + studioIcon(icon) + label + '</button>').join('');
  (layout.querySelector('form .glow-body') ?? layout.querySelector('form')).insertAdjacentHTML('beforeend', agentControls(ctx));
  ctx.html(layout.firstElementChild.outerHTML);
  const view = document.querySelector('.agent-home');
  const log = view.querySelector('.agent-log'), next = view.querySelector('.agent-next'), form = view.querySelector('form');
  const input = form.querySelector('textarea'), send = form.querySelector('.agent-send');
  const attachment = form.querySelector('.agent-attach');
  const renderThumbnail = assetPreview(ctx, attachment.querySelector('.agent-attachment-thumb'));
  const initialPrompt = input.placeholder;
  const reset = view.querySelector('.agent-new'), status = view.querySelector('.agent-status');
  const history = view.querySelector('.agent-history');
  const controls = bindAgentControls(view, ctx, { onUpload: upload, onPick: () => submit('选择主图') });
  function showHistory() {
    history.replaceChildren(new Option('最近对话', ''), ...previous.map((t,i) =>
      new Option(t.messages.find(m => m.role === 'user')?.text.slice(0, 26) || '对话', String(i))));
    history.hidden = !previous.length;
  }
  function loadThread() {
    input.value = thread.input ?? '';
    log.innerHTML = thread.messages.map(messageHtml).join('');
    controls.reset();
    showHistory(); buttons(); sync(); persist(); log.scrollTop = log.scrollHeight;
  }
  input.value = thread.input ?? '';
  function buttons() {
    const choices = thread.images?.map((image, i) => ['第' + (i + 1) + '张', (i + 1) + ' · ' + image.name]) ?? [];
    if (thread.draft?.title && thread.draft.image && !thread.images) choices.push(['保存草稿', '保存草稿'], ['更换主图', '更换主图']);
    if (thread.cover?.image && !thread.images) choices.push(['开始出图', '开始出图'], ['更换主图', '更换主图']);
    if (thread.draft || thread.cover || thread.images) choices.push(['取消', '取消']);
    const emptyLibrary = thread.images?.length === 0;
    if (emptyLibrary) choices.unshift(['选择主图', '重新选择素材']);
    next.innerHTML = (emptyLibrary ? '<button class="primary" type="button" data-upload-main>上传主图</button>' : '') +
      choices.map(([prompt,label]) => '<button class="smallbtn" type="button" data-prompt="' + h(prompt) + '">' + h(label) + '</button>').join('');
    next.hidden = !choices.length;
  }
  function sync() {
    view.querySelector('[data-chat-scope]').textContent = ctx.workspace.name + ' · ' + (thread.knowledgeBase?.name ?? '电商 AI 助手');
    const started = thread.messages.length > 0;
    input.placeholder = !started ? initialPrompt : thread.draft && !thread.draft.title ? '输入拼多多商品草稿名称' : '继续输入消息…';
    view.classList.toggle('in-chat', started);
    view.querySelector('h1').textContent = started ? '工作台助手' : '寰球 AI，我帮你';
    reset.hidden = !started;
    reset.disabled = busy;
    history.disabled = busy;
    view.querySelector('.agent-starters').hidden = started;
    send.disabled = busy || !input.value.trim();
    controls.busy(busy);
    attachment.disabled = busy;
    attachment.hidden = !thread.attachment;
    const imageId = thread.attachment?.id ?? '';
    if (imageId !== (attachment.dataset.imageId ?? '')) {
      attachment.dataset.imageId = imageId;
      void renderThumbnail(imageId, '');
    }
    attachment.querySelector('.agent-attachment-name').textContent = thread.attachment ? thread.attachment.name + ' ×' : '';
    attachment.setAttribute('aria-label', thread.attachment ? '移除主图 ' + thread.attachment.name : '移除主图');
    attachment.title = '移除引用的主图';
    attachment.setAttribute('data-attached', '');
    for (const button of next.querySelectorAll('button')) button.disabled = busy;
  }
  function append(message) {
    thread.messages.push(message);
    log.insertAdjacentHTML('beforeend', messageHtml(message));
    while (log.children.length > 40) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
    persist();
  }
  async function submit(text) {
    if (busy || !text.trim()) return;
    busy = true;
    thread.inFlight = true;
    input.value = ''; thread.input = '';
    append({ role:'user', text }); sync(); log.scrollTop = log.scrollHeight;
    status.textContent = '正在处理…';
    try {
      const response = await respond(ctx, thread, text, { ...controls.selection(),
        onTask: id => {
          if (ctx.active()) append({ role:'assistant', text:'正在理解你的请求。', items:[{ title:'查看模型任务', route:'tasks/' + encodeURIComponent(id) }] });
        } });
      if (ctx.active()) {
        append({ role:'assistant', ...response });
        if (response.navigateTo) ctx.go(response.navigateTo);
      }
    } catch (error) {
      if (ctx.active()) append({ role:'assistant', text:'操作未完成。' + describeError(error) });
    } finally {
      if (ctx.active()) { busy = false; thread.inFlight = false; status.textContent = ''; buttons(); sync(); persist(); log.scrollTop = log.scrollHeight; }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void submit(input.value.trim()); });
  input.addEventListener('input', () => { thread.input = input.value; sync(); persist(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); if (!send.disabled) form.requestSubmit();
    }
  });
  view.addEventListener('click', event => {
    if (!busy && event.target.closest('[data-upload-main]')) view.querySelector('.composer-file').click();
    const button = event.target.closest('[data-prompt]');
    if (button) void submit(button.dataset.prompt);
  });
  attachment.addEventListener('click', () => {
    thread.attachment = null;
    if (thread.draft) thread.draft.image = null;
    if (thread.cover) thread.cover.image = null;
    buttons(); sync(); persist();
  });
  async function upload(file) {
    if (busy) return;
    if (!/\.(png|jpe?g)$/i.test(file.name)) {
      status.textContent = '请选择 PNG 或 JPEG 图片。';
      return;
    }
    busy = true;
    sync();
    status.textContent = '正在将图片上传到当前工作区…';
    try {
      const data = new FormData();
      data.set('file', file);
      data.set('source', '本地上传');
      data.set('purpose', '对话参考图');
      const { id, name } = await uploadMedia(ctx, data);
      if (!ctx.active()) return;
      const confirmation = await attachImage(ctx, thread, { id, name });
      if (thread.messages.length) append({ role: 'assistant', ...confirmation });
      status.textContent = '已加入当前对话 · ' + name;
      buttons(); persist();
    } catch (error) {
      if (ctx.active()) status.textContent = '上传未完成。' + describeError(error);
    } finally {
      if (ctx.active()) { busy = false; sync(); }
    }
  }
  reset.addEventListener('click', () => {
    archive(); thread = { messages:[], input:'' }; loadThread(); input.focus();
  });
  history.addEventListener('change', () => {
    if (history.value === '' || busy) return;
    const [selected] = previous.splice(Number(history.value), 1);
    if (selected) { archive(); thread = selected; loadThread(); input.focus(); }
  });
  log.innerHTML = thread.messages.map(messageHtml).join('');
  showHistory(); buttons(); sync(); log.scrollTop = log.scrollHeight;
}
