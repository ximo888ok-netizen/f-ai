import { waitForModelTask } from './live-agent-model.js';
import { bindPopover } from './live-popover.js';
import { describeError } from './studio-errors.js';
import { link, path, retryKey } from './live-ui.js';
import { bindVideoMedia } from './live-video-prompt-media.js';
import { videoInputs, videoLimits, videoPlanInput, videoSkills, videoTaskInput, videoTemplates } from './live-video-prompt-options.js';
import { videoModelOptions, videoPromptView } from './live-video-prompt-view.js';
import { readVideoSettings, updateVideoSettings } from './live-video-settings.js';

export async function videoPromptPage(ctx, plugin, wallet, planner, tasks, states) {
  const [directory, assets] = await Promise.all([ctx.api('/v1/models'), ctx.all('/v1/assets')]);
  if (!ctx.active()) return;
  ctx.html(videoPromptView(tasks, states));
  const root = document.querySelector('[data-video-prompt]');
  const form = root.querySelector('form');
  const find = selector => root.querySelector(selector);
  const fields = form.elements;
  const prompt = fields.prompt;
  const plan = find('[data-video-plan]');
  const planText = find('[data-video-plan-text]');
  const submit = find('button[type="submit"]');
  const report = value => { find('[data-video-status]').textContent = value; };
  const control = id => find('[popovertarget="video-' + id + '"]');
  const choices = name => [...form.querySelectorAll('[type=radio][name="' + name + '"]')];
  const activeModel = () => directory.items.find(model => model.id === modelId);
  const activeCapability = () => plugin?.capabilities.find(capability => capability.id === videoInputs[type].capabilityId);
  const isAvailable = (key = type) => plugin?.enabled && plugin.capabilities.some(cap => cap.id === videoInputs[key].capabilityId && cap.available);
  let mode = 'direct', type = 'text', modelId, planned, busy = false;
  let planKey = retryKey();
  const submitKey = retryKey();

  function setInputType(next) {
    type = next;
    fields.inputType.value = next;
    const models = directory.items.filter(model => model.capabilities.includes(videoInputs[type].capabilityId));
    modelId = models.find(model => model.id === modelId)?.id ?? models[0]?.id;
    find('[data-video-models]').innerHTML = videoModelOptions(models, isAvailable());
    for (const entry of choices('videoModel')) entry.checked = entry.value === modelId;
    media.render();
    refresh();
  }

  function draft() {
    return { capabilityId: videoInputs[type].capabilityId, modelId, prompt: prompt.value.trim(),
      asset: media.selected(), ...readVideoSettings(fields),
      skill: fields.skill.value };
  }

  function prepared(input) {
    return mode === 'plan' && planned?.signature === JSON.stringify(input) && planned.task?.state === 'succeeded';
  }

  function issue(input, readyPlan, limits) {
    if (!isAvailable()) return '当前工作区未配置可用的' + videoInputs[type].label + '服务。';
    if (mode === 'plan' && !planner?.available) return '智能编导需要工作区启用文本模型。';
    if (media.uploading()) return '正在上传素材…';
    if (type !== 'text' && !input.asset) return type === 'reference' ? '请选择有有效授权的参考视频。' : '请选择一张首帧图片。';
    if (!input.prompt) return '填写提示词，或从模板开始。';
    if (input.prompt.length > limits.promptMax) return '提示词最多 ' + limits.promptMax + ' 字。';
    if (readyPlan && (!planText.value.trim() || planText.value.trim().length > limits.promptMax)) return '成片方案须填写 1–' + limits.promptMax + ' 字。';
    return '';
  }

  function refresh() {
    const limits = videoLimits(activeModel(), type, activeCapability());
    prompt.maxLength = limits.promptMax;
    planText.maxLength = limits.promptMax;
    updateVideoSettings(root, fields, limits);

    const input = draft();
    const readyPlan = prepared(input);
    plan.hidden = !readyPlan;
    find('[data-video-count]').textContent = prompt.value.length + ' / ' + limits.promptMax;
    control('input').textContent = videoInputs[type].label;
    control('model').textContent = modelId ?? (isAvailable() ? '工作区网关' : '视频模型');
    control('ratio').textContent = [input.ratio, input.resolution].filter(Boolean).join(' · ') || '画幅与清晰度';
    control('length').textContent = input.duration ? input.duration + ' 秒' : '视频时长';
    control('audio').textContent = input.audio === undefined ? '声音' : input.audio ? '有声' : '无声';
    control('skill').hidden = mode !== 'plan';
    control('skill').textContent = '编导技能 · ' + (videoSkills.find(([id]) => id === input.skill)?.[1] ?? videoSkills[0][1]);
    const videoCost = activeCapability()?.cost ?? 0;
    const waiting = mode === 'plan' && planned?.signature === JSON.stringify(input) && ['queued', 'running'].includes(planned.task?.state);
    const planningCost = mode === 'plan' && !readyPlan && !waiting ? planner?.cost ?? 0 : 0;
    find('[data-video-cost]').textContent = '可用 ' + wallet.available + ' 积分 · ' +
      (mode === 'plan' && !readyPlan ? '编导 ' + planningCost + ' + 成片 ' + videoCost : '成片 ' + videoCost) + ' 积分';
    const reason = issue(input, readyPlan, limits) || (!waiting && wallet.available < videoCost + planningCost ? '可用积分不足。' : '');
    submit.textContent = mode === 'direct' ? '生成视频' : readyPlan ? '确认并生成' : waiting ? '继续查看编导' : '生成编导方案';
    submit.disabled = busy || Boolean(reason);
    if (!busy) report(reason || (readyPlan ? '可修改成片方案，确认后再提交。' : ''));
    form.dispatchEvent(new Event('video-settings-change'));
  }

  const media = bindVideoMedia(ctx, root, assets, {
    inputType: () => type, setInputType, change: preserveStatus => {
      const previous = find('[data-video-status]').textContent;
      media.render();
      refresh();
      if (preserveStatus && previous && !previous.startsWith('正在')) report(previous);
    }, report, locked: () => busy,
  });

  for (const trigger of root.querySelectorAll('[popovertarget]')) {
    bindPopover(trigger, document.getElementById(trigger.getAttribute('popovertarget')), { signal: ctx.signal });
  }
  for (const button of root.querySelectorAll('[data-video-mode]')) {
    button.addEventListener('click', () => {
      if (busy) return;
      mode = button.dataset.videoMode;
      for (const entry of root.querySelectorAll('[data-video-mode]')) entry.setAttribute('aria-pressed', String(entry === button));
      refresh();
    });
  }
  for (const button of root.querySelectorAll('[data-video-template]')) {
    button.addEventListener('click', () => {
      if (busy) return;
      const template = videoTemplates[Number(button.dataset.videoTemplate)][2];
      const next = [prompt.value.trim(), template].filter(Boolean).join('\n');
      if (next.length > prompt.maxLength) { report('提示词空间不足，请先删减当前内容。'); return; }
      prompt.value = next;
      refresh();
      prompt.focus();
    });
  }
  form.addEventListener('change', event => {
    if (event.target.name === 'inputType') setInputType(event.target.value);
    else if (event.target.name === 'videoModel') { modelId = event.target.value; refresh(); }
    else refresh();
  });
  form.addEventListener('input', event => {
    if ([prompt, planText, fields.duration].includes(event.target)) refresh();
  });

  async function enqueue(payload, keyFor) {
    return ctx.api('/v1/tasks', { method: 'POST', body: { ...payload, idempotencyKey: keyFor(payload) } });
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || submit.disabled || !ctx.active()) return;
    const input = draft();
    const readyPlan = prepared(input);
    const limits = videoLimits(activeModel(), type, activeCapability());
    busy = true;
    form.setAttribute('aria-busy', 'true');
    prompt.readOnly = planText.readOnly = true;
    const toolbar = find('.video-toolbar');
    toolbar.inert = true;
    refresh();
    let message = '';
    try {
      if (mode === 'direct' || readyPlan) {
        report('正在提交视频任务…');
        const task = await enqueue(videoTaskInput({ ...input, prompt: readyPlan ? planText.value.trim() : input.prompt }), submitKey);
        ctx.go('tasks/' + path(task.id));
        return;
      }
      const signature = JSON.stringify(input);
      if (planned?.signature !== signature) {
        planned = { signature };
        planKey = retryKey();
      }
      report('正在生成编导方案…');
      planned.task ??= await enqueue(videoPlanInput(input, limits.promptMax), planKey);
      const task = await waitForModelTask(ctx, planned.task, 60000);
      if (!ctx.active()) return;
      planned.task = task;
      if (task.state === 'succeeded' && task.result?.text?.trim()) {
        planText.value = task.result.text.trim();
        find('[data-video-plan-task]').innerHTML = link('查看编导任务', 'tasks/' + path(task.id));
      } else if (['queued', 'running'].includes(task.state)) {
        message = '编导仍在执行，可继续查看同一任务。';
      } else {
        planned = undefined;
        planKey = retryKey();
        message = '编导未返回可用方案，可在任务记录查看原因。';
      }
      wallet.available = (await ctx.api('/v1/credits/wallet')).available;
    } catch (error) {
      message = describeError(error);
    } finally {
      if (ctx.active()) {
        busy = false;
        form.removeAttribute('aria-busy');
        prompt.readOnly = planText.readOnly = false;
        toolbar.inert = false;
        refresh();
        if (message) report(message);
      }
    }
  });

  fields.skill.value = videoSkills[0][0];
  for (const radio of choices('inputType')) {
    radio.disabled = !isAvailable(radio.value);
    if (radio.disabled) radio.nextElementSibling.querySelector('strong').append(' · 未配置');
  }
  setInputType(Object.keys(videoInputs).find(isAvailable) ?? 'text');
}
