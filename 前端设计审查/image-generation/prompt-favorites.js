import { h, uid } from '../live-ui.js';

export function advancedPromptField() {
  return '<fieldset><legend>自定义提示词</legend><div class="live-row quick-prompt-actions">' +
    '<button class="smallbtn" type="button" data-prompt-import>从收藏带入</button>' +
    '<button class="smallbtn" type="button" data-prompt-save>收藏当前提示词</button></div>' +
    '<label>完整提示词（必填）<textarea name="prompt" maxlength="1200" rows="7" required ' +
    'placeholder="描述商品摆放、构图、背景、光线、文案和视觉风格"></textarea></label>' +
    '<p class="live-muted">提示词原样提交。<output data-advanced-length>0</output> / 1200 字</p>' +
    '<p class="live-muted" data-prompt-favorite-status role="status"></p></fieldset>' +
    '<dialog class="ui-dialog" data-prompt-library aria-labelledby="quick-favorite-title">' +
    '<div class="ui-dialog-header"><h2 id="quick-favorite-title">收藏的提示词</h2>' +
    '<button type="button" class="ui-icon-button" data-prompt-close aria-label="关闭">×</button></div>' +
    '<div class="ui-dialog-body" data-prompt-items></div></dialog>';
}

export function bindPromptFavorites(ctx, form) {
  const prefix = 'fai.image.prompts.v1:' + ctx.account.id + ':' + ctx.workspace.id + ':';
  const dialog = form.querySelector('[data-prompt-library]');
  const list = dialog.querySelector('[data-prompt-items]');
  const notice = form.querySelector('[data-prompt-favorite-status]');
  const textarea = form.elements.prompt;
  let prompts = [];

  function read() {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter(key => key?.startsWith(prefix)).sort().reverse()
      .map(key => localStorage.getItem(key)).filter(value => value && value.length <= 1200 && value.trim());
  }

  function save() {
    const value = textarea.value;
    if (!value.trim() || value.length > 1200) {
      notice.textContent = '请输入 1–1200 字的完整提示词。';
      return;
    }
    try {
      if (read().includes(value)) {
        notice.textContent = '这条提示词已在收藏中。';
        return;
      }
      localStorage.setItem(prefix + Date.now() + ':' + uid(), value);
      notice.textContent = '已收藏到本机。';
    } catch {
      notice.textContent = '无法保存本机收藏。';
    }
  }

  form.querySelector('[data-prompt-save]').addEventListener('click', save);
  form.querySelector('[data-prompt-import]').addEventListener('click', () => {
    try {
      prompts = read();
      list.innerHTML = prompts.length
        ? prompts.map((value, index) => '<button type="button" class="smallbtn quick-prompt-item" data-prompt-item="' + index +
          '">' + h(value) + '</button>').join('')
        : '<p class="live-muted">当前工作区在本机还没有收藏的提示词。</p>';
      dialog.showModal();
    } catch {
      notice.textContent = '无法读取本机收藏。';
    }
  });
  dialog.querySelector('[data-prompt-close]').addEventListener('click', () => dialog.close());
  list.addEventListener('click', event => {
    const item = event.target.closest('[data-prompt-item]');
    if (!item) return;
    const prompt = prompts[Number(item.dataset.promptItem)];
    if (!prompt) return;
    textarea.value = prompt;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.close();
    textarea.focus();
    notice.textContent = '已带入收藏提示词。';
  });
}
