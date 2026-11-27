import { h } from './live-ui.js';
import { studioIcon } from './studio-icons.js';
import { bindPopover } from './live-popover.js';
import { describeError } from './studio-errors.js';
import { contextPicker, bindContextPicker } from './live-agent-picker.js';

export function agentControls() {
  return '<div class="composer-references" hidden></div><div class="agent-bar">' + contextPicker() +
    '<button type="button" class="smallbtn agent-attach" hidden><span class="agent-attachment-thumb"></span><span class="agent-attachment-name"></span></button>' +
    '<div class="agent-bar-end"><button class="smallbtn composer-enhance" type="button" aria-label="强化提示词" title="强化提示词" disabled>' +
    studioIcon('capabilities') + '<span>强化提示词</span></button>' +
    '<button type="button" class="smallbtn composer-model" popovertarget="composer-models">选择模型</button>' +
    '<section id="composer-models" class="studio-popover composer-popover composer-models" popover aria-label="选择对话模型">' +
    '<div class="popover-heading"><strong>对话模型</strong><span data-model-note role="status">正在读取模型…</span></div>' +
    '<div data-model-options></div></section>' +
    '<button class="primary agent-send" type="submit" aria-label="发送消息" disabled>' +
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-5 5 5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button></div></div>';
}

export function bindAgentControls(view, ctx, callbacks) {
  bindContextPicker(view, ctx, callbacks);
  const panel = view.querySelector('#composer-models'), trigger = view.querySelector('.composer-model');
  const position = bindPopover(trigger, panel, {end:true, signal:ctx.signal});
  const options = panel.querySelector('[data-model-options]'), note = panel.querySelector('[data-model-note]');
  const enhance = view.querySelector('.composer-enhance'), references = view.querySelector('.composer-references');
  let models = [], selected, busy = false;

  function refresh() {
    enhance.disabled = busy || !selected || !view.querySelector('textarea').value.trim();
    enhance.title = selected ? '使用 ' + selected.model + ' 强化提示词' : '需要可用的对话模型';
  }
  function choose(model) {
    selected = model;
    trigger.textContent = model?.model ?? '暂无可用模型';
    trigger.title = model ? [model.model, model.id !== model.model && model.id].filter(Boolean).join(' · ') : '查看对话模型';
    for (const item of options.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item.dataset.modelId === (model?.id ?? '')));
    refresh();
  }
  const ready = Promise.all([ctx.api('/v1/models?capabilityId=model.chat'), ctx.api('/v1/plugins')]).then(([{items}, catalog]) => {
    if (!ctx.active()) return;
    const available = catalog.models.enabled && catalog.models.capabilities.some(c => c.id === 'model.chat' && c.available);
    models = available ? items.filter(m => m.kind === 'text' && m.capabilities.includes('model.chat')) : [];
    if (available && !models.length) {
      models = [{id:null, model:'工作区网关'}];
    }
    options.innerHTML = models.map(m => '<button type="button" data-model-id="' + h(m.id ?? '') + '"><span>' + h(m.model) + '</span>' +
      (m.id && m.id !== m.model ? '<small>' + h(m.id) + '</small>' : '') + '</button>').join('');
    note.textContent = models.length ? '' : '当前工作区尚未启用对话模型。';
    choose(models[0]);
    position();
  }).catch(error => {
    if (!ctx.active()) return;
    choose(undefined);
    trigger.textContent = '模型加载失败';
    note.textContent = describeError(error);
    position();
  });
  options.addEventListener('click', event => {
    const choice = event.target.closest('[data-model-id]');
    if (!choice) return;
    choose(models.find(m => (m.id ?? '') === choice.dataset.modelId));
    panel.hidePopover();
    trigger.focus();
  });
  enhance.addEventListener('click', () => callbacks.onEnhance(selected?.id));
  references.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-ref]');
    if (button && !busy) callbacks.onRemove(Number(button.dataset.removeRef));
  });
  return {
    ready, selection: () => ({model: Boolean(selected), modelId:selected?.id}),
    reset: () => choose(models[0]),
    references(entries) {
      references.hidden = !entries.length;
      references.innerHTML = entries.map((r,i) => '<button class="smallbtn" type="button" aria-label="移除引用 ' + h(r.name) +
        '" data-remove-ref="' + i + '"' + (busy ? ' disabled' : '') + '><span>@' + h(r.name) + '</span><i aria-hidden="true">×</i></button>').join('');
    },
    busy(value) {
      busy = value;
      trigger.disabled = value;
      view.querySelector('.composer-add').disabled = value;
      refresh();
    },
  };
}
