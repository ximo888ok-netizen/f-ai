import { h } from './live-ui.js';
import { videoPlanSettings } from './live-video-prompt-options.js';
import { readVideoSettings } from './live-video-settings.js';

export function bindVideoSteps(scope, panel, nextButton) {
  const form = scope.querySelector('[data-form=video-prompt], .video-quick-form');
  if (!form) return;
  const workspace = form.closest('.live-video-workflow');
  const find = selector => workspace.querySelector(selector);
  const fields = form.elements;
  const toolbar = id => find('[popovertarget="video-' + id + '"]');
  const target = (label, node, click = false) => ({ label, node, click });
  const present = node => node && !node.closest('[hidden], [inert]');
  let actions = [], step = 1;

  function submitButton() {
    const next = find('[data-director-next]');
    return present(next) ? next : form.querySelector('[type=submit]');
  }
  function render(current = step) {
    step = current;
    const direct = Boolean(fields.inputType);
    const asset = find('.video-asset-chip')?.firstChild?.textContent?.trim() ||
      find('[data-video-quick-frame]:not([hidden]) img')?.alt;
    const prompt = fields.prompt ?? fields.notes;
    const input = toolbar('input')?.textContent ?? '首帧图生成';
    const model = toolbar('model')?.textContent ?? fields.modelId?.selectedOptions[0]?.textContent;
    const settings = fields.defaultDuration && videoPlanSettings(readVideoSettings(fields));
    const button = submitButton();
    const status = find('[data-director-actions]:not([hidden]) [role=status]')?.textContent ||
      find('[data-video-status], [data-video-quick-status]')?.textContent;
    const cost = find('[data-video-cost], [data-video-quick-cost]')?.textContent;
    const script = find('[data-video-plan]:not([hidden]) textarea, [data-director-script], [data-video-quick-script]:not([hidden]) textarea');
    let description = '';
    if (step === 1) {
      description = [input, asset || (direct && fields.inputType.value === 'text' ? '可直接填写创作要求' : '请选取已授权的素材')].join(' · ');
      actions = [target('选择生成方式', toolbar('input'), true), target('选择素材', direct ? toolbar('media') : find('[popovertarget=video-quick-library]'), true)];
    } else if (step === 2) {
      description = script ? '方案已生成，可以逐镜核对脚本。' : prompt.value.trim() ? '已填写创作要求。' : '填写商品信息、镜头动作或拍摄意图。';
      actions = [target(script ? '编辑成片脚本' : '编辑创作要求', script ?? prompt)];
      if (direct) actions.push(target('智能编导', find('[data-video-mode=plan]'), true));
    } else if (step === 3) {
      description = [model, settings || '使用模型默认设置'].filter(Boolean).join(' · ');
      actions = direct ? [target('选择模型', toolbar('model'), true), target('画幅与清晰度', toolbar('ratio'), true),
        target('视频时长', toolbar('length'), true), target('声音', toolbar('audio'), true)] :
        [target('选择模型', fields.modelId), target('画幅与清晰度', form.querySelector('[name=ratio], [name=resolution]')),
          target('视频时长', fields.defaultDuration), target('声音', form.querySelector('[name=generateAudio]'))];
    } else {
      description = [model, settings, cost, status].filter(Boolean).join(' · ');
      actions = [target('查看成片与下载', find('[data-video-quick-result]:not([hidden]) a, [data-director-result]:not([hidden]) a'), true)];
    }
    actions = actions.filter(action => present(action.node) && !action.node.disabled);
    const desc = panel.querySelector('[data-dual-step-desc]');
    const html = '<strong>步骤 ' + step + '/4</strong> ' + h(description) + (actions.length ? '<div class="live-row">' +
      actions.map((action, i) => '<button type="button" class="smallbtn" data-video-step-action="' + i + '">' + h(action.label) + '</button>').join('') + '</div>' : '');
    if (desc.innerHTML !== html) desc.innerHTML = html;
    nextButton.disabled = step === 4 && (!present(button) || button.disabled);
    if (step === 4) nextButton.textContent = button?.textContent || '提交生成';
  }
  panel.addEventListener('click', event => {
    const trigger = event.target.closest('[data-video-step-action]');
    if (!trigger) return;
    const action = actions[Number(trigger.dataset.videoStepAction)];
    if (!action || !present(action.node) || action.node.disabled) return;
    action.node.focus();
    if (action.click) action.node.click();
  });
  form.addEventListener('video-settings-change', () => render());
  return { render, submit() { const button = submitButton(); if (present(button) && !button.disabled) button.click(); } };
}
