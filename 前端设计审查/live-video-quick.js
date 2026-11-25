import { waitForModelTask } from './live-agent-model.js';
import { describeError } from './studio-errors.js';
import { uid } from './live-ui.js';
import { videoLimits, videoTaskInput } from './live-video-prompt-options.js';
import { bindVideoQuickMedia } from './live-video-quick-media.js';
import { videoQuickView } from './live-video-quick-view.js';
import { bindVideoResult, frameVideoCapabilityId, loadFrameVideo, updateFrameVideoSettings, updateVideoProgress,
  videoTaskLink as taskLink, videoTaskPending as pending } from './live-video-workflow.js';

function scriptInput(input, maxLength) {
  return { capabilityId: 'model.chat', mode: 'workflow', parameters: { messages: [
    { role: 'system', content: '你是商品短视频编导。按镜头分行写可直接用于图生视频的成片脚本，描述镜头、主体动作、运镜、节奏与衔接。' +
      '脚本总长不超过 ' + maxLength + ' 字。你只收到文字，不能声称识别过图片。保留画面主体和商标，避免添加未提供的商品属性。' +
      '只输出脚本文字。' },
    { role: 'user', content: ['视频时长 ' + input.duration + ' 秒。', input.ratio && '画幅 ' + input.ratio + '。',
      '生成时将提供用户指定的商品首帧。', input.notes ? '用户描述：' + input.notes : '编排一段适用于首帧商品的镜头，优先使用平稳运镜。'].filter(Boolean).join('\n') },
  ] } };
}

export async function videoQuickPage(ctx, plugin, wallet, planner, tasks) {
  const { capability, available, assets, models, recentIds } = await loadFrameVideo(ctx, plugin, tasks);
  if (!ctx.active()) return;
  ctx.html(videoQuickView(models, available));

  const root = document.querySelector('[data-video-quick]');
  const find = selector => root.querySelector(selector);
  const form = find('form');
  const controls = find('.quick-image-config');
  const fields = form.elements;
  const editor = find('[data-video-quick-script-text]');
  const submit = find('button[type="submit"]');
  const result = find('[data-video-quick-result]');
  const player = bindVideoResult(ctx, result);
  const planTask = find('[data-video-quick-plan-task]');
  const report = message => { find('[data-video-quick-status]').textContent = message; };
  const model = () => models.find(entry => entry.id === fields.modelId.value);
  const limits = () => videoLimits(model(), 'frame', capability);
  let workflow, busy = false;

  const media = bindVideoQuickMedia(ctx, root, assets, recentIds, { change: refresh, report, locked: () => busy });
  const draft = () => ({ frameKey: media.frame()?.key, modelId: fields.modelId.value, notes: fields.notes.value.trim(),
    ratio: fields.ratio.value, duration: Number(fields.duration.value) });
  const current = input => workflow?.signature === JSON.stringify(input) ? workflow : undefined;
  const videoCost = capability?.cost ?? 0;
  const planCost = planner?.cost ?? 0;

  function refresh() {
    const bounds = limits();
    updateFrameVideoSettings(root, fields, bounds);
    editor.maxLength = bounds.promptMax;

    const input = draft();
    const run = current(input);
    const hasScript = Boolean(run?.script);
    const planPending = pending(run?.plan);
    const videoPending = pending(run?.video?.task);
    const completed = run?.video?.task?.state === 'succeeded';
    const phase = run?.video ? 3 : hasScript ? 2 : run?.plan || (busy && run) ? 1 : 0;
    updateVideoProgress(root, phase);
    find('[data-video-quick-preview]').hidden = hasScript;
    find('[data-video-quick-script]').hidden = !hasScript || videoPending || completed;
    planTask.hidden = !run?.plan;
    result.hidden = !run?.video?.task;
    editor.readOnly = busy || videoPending;
    submit.textContent = completed ? '视频任务已完成' : videoPending ? '查看生成进度' : hasScript ?
      (run.video?.task?.state === 'failed' ? '重试生成视频' : '确认脚本并生成') : planPending ? '查看脚本进度' : '生成脚本';
    const balance = wallet.available;
    find('[data-video-quick-cost]').textContent = '可用 ' + balance + ' 积分 · ' +
      (hasScript || planPending ? '视频 ' + videoCost : '脚本 ' + planCost + ' + 视频 ' + videoCost) + ' 积分';
    const waiting = planPending || videoPending;
    let issue = '';
    if (!waiting && !completed) {
      if (!input.frameKey) issue = '请添加商品图并确认首帧。';
      else if (!available) issue = '当前工作区未配置图片转视频服务。';
      else if (!hasScript && !planner?.available) issue = '生成脚本需要工作区启用文本模型。';
      else if (hasScript && (!editor.value.trim() || editor.value.trim().length > bounds.promptMax)) issue = '成片脚本须填写 1–' + bounds.promptMax + ' 字。';
      else if (balance < videoCost + (hasScript ? 0 : planCost)) issue = '可用积分不足。';
    }
    submit.disabled = busy || completed || Boolean(issue);
    if (!busy) report(issue);
  }

  function start(payload, idempotencyKey) {
    return ctx.api('/v1/tasks', { method: 'POST', body: { ...payload, idempotencyKey } });
  }

  async function prepare(run, input) {
    report('正在根据文字说明编排脚本…');
    run.plan ??= await start(scriptInput(input, limits().promptMax), run.planKey);
    planTask.innerHTML = taskLink(run.plan, '查看脚本任务');
    planTask.hidden = false;
    run.plan = await waitForModelTask(ctx, run.plan, 45000);
    if (pending(run.plan)) return '脚本仍在生成，可继续查看同一任务。';
    const text = run.plan.state === 'succeeded' && run.plan.result?.text?.trim();
    if (!text) {
      run.plan = undefined;
      run.planKey = uid();
      return '脚本未返回可用内容，请查看任务记录。';
    }
    run.script = editor.value = text;
    return '脚本已生成，可以编辑后确认。';
  }

  async function makeVideo(run, input, frame) {
    report('正在提交或读取视频任务…');
    if (!pending(run.video?.task)) {
      const asset = await media.uploadFrame(frame);
      const payload = videoTaskInput({ ...input, capabilityId: frameVideoCapabilityId, prompt: editor.value.trim(), asset });
      const data = JSON.stringify(payload);
      if (run.video?.data !== data || run.video?.task) run.video = { data, key: uid() };
      run.video.task = await start(payload, run.video.key);
    }
    refresh();
    await player.show(run.video.task);
    run.video.task = await waitForModelTask(ctx, run.video.task, 45000);
    if (!ctx.active()) return '';
    await player.show(run.video.task);
    return pending(run.video.task) ? '视频仍在生成，可继续查看同一任务。' : '';
  }

  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  editor.addEventListener('input', refresh);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ctx.active() || busy || submit.disabled) return;
    const input = draft();
    const frame = media.frame();
    workflow = current(input) ?? { signature: JSON.stringify(input), planKey: uid() };
    const run = workflow;
    const hadScript = Boolean(run.script);
    let message = '';
    busy = true;
    controls.inert = fields.modelId.inert = true;
    form.setAttribute('aria-busy', 'true');
    refresh();
    try {
      message = hadScript ? await makeVideo(run, input, frame) : await prepare(run, input);
      if (ctx.active()) wallet.available = (await ctx.api('/v1/credits/wallet')).available;
    } catch (error) { message = describeError(error); }
    finally {
      if (ctx.active()) {
        busy = false;
        controls.inert = fields.modelId.inert = false;
        form.removeAttribute('aria-busy');
        refresh();
        if (message) report(message);
        if (!hadScript && run.script) editor.focus();
      }
    }
  });
  refresh();
}
