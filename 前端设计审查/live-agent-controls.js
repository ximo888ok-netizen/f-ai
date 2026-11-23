import { h } from './live-ui.js';
import { modelCapability } from './live-agent-model.js';
import { bindPopover } from './live-popover.js';
import { describeError } from './studio-errors.js';

export function agentControls(ctx) {
  const role = { owner: '所有者', admin: '管理员', member: '成员' }[ctx.workspace.role] ?? ctx.workspace.role;
  return '<div class="agent-bar"><button type="button" class="smallbtn composer-add" popovertarget="composer-context" aria-label="添加上下文">＋</button>' +
    '<button type="button" class="smallbtn agent-attach" hidden></button>' +
    '<section id="composer-context" class="studio-popover composer-popover" popover aria-label="添加上下文">' +
    '<div class="popover-heading"><strong>添加上下文</strong></div>' +
    '<button type="button" data-context-upload>上传本地图片</button><button type="button" data-context-pick>引用素材库图片</button>' +
    '<a href="#data/knowledge">浏览知识库</a><a href="#capabilities/experts">查找专家与技能</a></section>' +
    '<input class="composer-file" type="file" accept="image/png,image/jpeg" hidden>' +
    '<div class="agent-bar-end"><button type="button" class="smallbtn composer-model" popovertarget="composer-models">内置操作</button>' +
    '<section id="composer-models" class="studio-popover composer-popover composer-models" popover aria-label="选择对话模型">' +
    '<div class="popover-heading"><strong>对话方式</strong><span data-model-note role="status">正在读取模型…</span></div>' +
    '<div data-model-options><button type="button" data-model-choice="local" aria-pressed="true">内置操作</button></div>' +
    '<a href="#models">打开模型对话</a>' +
    (ctx.enterprise && ctx.manager ? '<a href="/merchant#connections">管理模型接入</a>' : '') + '</section>' +
    '<button class="primary agent-send" type="submit" aria-label="发送消息" disabled>' +
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-5 5 5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button></div></div>' +
    '<div class="composer-scope"><span title="' + h(ctx.workspace.name) + '">工作区 · ' + h(ctx.workspace.name) + '</span>' +
    '<button type="button" class="smallbtn" popovertarget="composer-access">访问范围</button>' +
    '<section id="composer-access" class="studio-popover composer-popover" popover aria-label="当前访问范围">' +
    '<div class="popover-heading"><strong>工作区访问</strong><span>当前角色 · ' + h(role) + '</span></div>' +
    '<p>助手按当前工作区和账号权限访问商品、素材和知识库。写入草稿前会在对话里请你确认。</p>' +
    '<a href="#settings">查看设置与诊断</a></section></div>';
}

export function bindAgentControls(view, ctx, { onUpload, onPick }) {
  const file = view.querySelector('.composer-file');
  const context = view.querySelector('#composer-context');
  const models = view.querySelector('#composer-models');
  const modelTrigger = view.querySelector('.composer-model');
  const access = view.querySelector('#composer-access');
  const optionList = models.querySelector('[data-model-options]');
  const note = models.querySelector('[data-model-note]');
  const local = optionList.querySelector('button');
  let selected = local;

  for (const panel of [context, models, access]) {
    const trigger = view.querySelector('[popovertarget="' + panel.id + '"]');
    bindPopover(trigger, panel, { end: panel !== context, signal: ctx.signal });
    panel.addEventListener('click', event => {
      if (event.target.closest('a')) panel.hidePopover();
    });
  }
  context.querySelector('[data-context-upload]').addEventListener('click', () => {
    context.hidePopover();
    file.click();
  });
  file.addEventListener('change', () => {
    const image = file.files[0];
    file.value = '';
    if (image) void onUpload(image);
  });
  context.querySelector('[data-context-pick]').addEventListener('click', () => {
    context.hidePopover();
    void onPick();
  });

  function choose(button) {
    selected = button;
    for (const option of optionList.querySelectorAll('button')) {
      const current = option === button;
      option.setAttribute('aria-pressed', String(current));
      if (current) modelTrigger.textContent = option.textContent;
    }
  }
  optionList.addEventListener('click', event => {
    const choice = event.target.closest('[data-model-choice]');
    if (!choice) return;
    choose(choice);
    models.hidePopover();
    modelTrigger.focus();
  });

  Promise.all([modelCapability(ctx), ctx.api('/v1/models?capabilityId=model.chat')]).then(([capability, { items }]) => {
    if (!ctx.active()) return;
    if (!capability) {
      note.textContent = '当前工作区没有可用的对话模型。';
      return;
    }
    note.textContent = '未匹配的请求可交给模型理解 · ' + capability.cost + ' 积分/次';
    optionList.insertAdjacentHTML('beforeend', '<button type="button" aria-pressed="false" data-model-choice="auto">默认对话模型</button>' +
      items.map(item => '<button type="button" aria-pressed="false" data-model-choice="named" data-model-id="' +
      h(item.id) + '">' + h(item.id) + '</button>').join(''));
  }).catch(error => {
    if (ctx.active()) note.textContent = '模型列表加载失败。' + describeError(error);
  });

  return {
    selection: () => ({ model: selected !== local, modelId: selected.dataset.modelId }),
    reset: () => choose(local),
    busy: value => {
      modelTrigger.disabled = value;
      view.querySelector('.composer-add').disabled = value;
    },
  };
}
