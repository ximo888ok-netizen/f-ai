import { waitForModelTask } from './live-agent-model.js';
import { describeError } from './studio-errors.js';
import { uid } from './live-ui.js';
import { videoLimits, videoTaskInput } from './live-video-prompt-options.js';
import { readVideoSettings, updateVideoSettings } from './live-video-settings.js';
import { bindVideoQuickMedia } from './live-video-quick-media.js';
import { directorDirections, directorFacts, directorPlanInput } from './live-video-director-plan.js';
import { directorStage, directorSteps, videoDirectorView } from './live-video-director-view.js';
import { bindVideoResult, frameVideoCapabilityId, loadFrameVideo, updateVideoProgress,
  videoTaskLink, videoTaskPending } from './live-video-workflow.js';

const requestLabels = { insights: '挖掘商品信息', directions: '生成创作方向', script: '生成脚本', video: '确认脚本并生成' };

function nextRequest(phase, run) {
  if (phase === 'setup' || phase === 'insights') return 'insights';
  if (phase === 'facts' || phase === 'directions') return 'directions';
  if (phase === 'direction' || (phase === 'script' && run.script === undefined)) return 'script';
  return 'video';
}

export async function videoDirectorPage(ctx, plugin, wallet, planner, tasks, storyboardRoute) {
  const { capability, available, assets, models, recentIds } = await loadFrameVideo(ctx, plugin, tasks);
  if (!ctx.active()) return;
  ctx.html(videoDirectorView(models, available, storyboardRoute));
  const root = document.querySelector('[data-video-director]');
  const find = selector => root.querySelector(selector);
  const form = find('form');
  const fields = form.elements;
  const controls = find('.quick-image-config');
  const submit = find('button[type="submit"]');
  const next = find('[data-director-next]');
  const reset = find('[data-director-reset]');
  const stage = find('[data-director-stage]');
  const taskLinks = find('[data-director-tasks]');
  const player = bindVideoResult(ctx, find('[data-director-result]'));
  const bounds = () => videoLimits(models.find(model => model.id === fields.modelId.value), 'frame', capability);
  const planCost = planner?.cost ?? 0;
  const videoCost = capability?.cost ?? 0;
  let phase = 'setup', run, busy = false, issue = '';
  const leftNotice = text => { find('[data-video-quick-status]').textContent = text; };
  const stageNotice = text => { find('[data-director-status]').textContent = text; };
  const report = text => (phase === 'setup' ? leftNotice : stageNotice)(text);

  const media = bindVideoQuickMedia(ctx, root, assets, recentIds, { source: '智能导演', change: sync, report, locked: () => phase !== 'setup' });

  function validation(kind, waiting) {
    if (waiting || run?.completed) return '';
    if (phase === 'setup' && !media.frame()) return '请添加商品图并选定首帧。';
    if (phase === 'setup' && !fields.notes.value.trim()) return '请输入商品名称、卖点或使用场景。';
    if ((phase === 'setup' || kind === 'video') && !available) return '当前工作区未配置图片转视频服务。';
    if (kind !== 'video' && !planner?.available) return '当前工作区未配置可用的文本模型。';
    if (phase === 'facts' && !run.selectedFacts.size) return '请选择至少一项商品信息。';
    if (phase === 'direction' && run.selectedDirection === undefined) return '请选择一个创作方向。';
    if (kind === 'video' && (!run.script.trim() || run.script.trim().length > bounds().promptMax)) {
      return '成片脚本须填写 1–' + bounds().promptMax + ' 字。';
    }
    if (wallet.available < (kind === 'video' ? videoCost : planCost)) return '可用积分不足。';
    return '';
  }

  function sync() {
    if (phase === 'setup') updateVideoSettings(root, fields, bounds());
    const kind = nextRequest(phase, run);
    const waiting = videoTaskPending(run?.attempts[kind]?.task);
    const cost = waiting || run?.completed ? 0 : kind === 'video' ? videoCost : planCost;
    find('[data-video-quick-cost]').textContent = '可用 ' + wallet.available + ' 积分 · 本步 ' + cost +
      ' 积分' + (phase === 'setup' ? ' · 全流程 ' + (3 * planCost + videoCost) + ' 积分' : '');
    issue = validation(kind, waiting);
    submit.disabled = phase !== 'setup' || busy || Boolean(issue);
    submit.hidden = phase !== 'setup';
    next.disabled = busy || Boolean(issue) || Boolean(run?.completed);
    next.textContent = run?.completed ? '视频任务已完成' : waiting ? '查看' + (kind === 'video' ? '视频' : '当前') + '进度' :
      run?.reviseScript ? '重试生成视频' : requestLabels[kind];
    reset.disabled = busy;
    if (!busy) report(issue);
    form.dispatchEvent(new Event('video-settings-change'));
  }

  function render(focus = false) {
    const setup = phase === 'setup';
    controls.inert = fields.modelId.inert = !setup;
    updateVideoProgress(root, directorSteps.findIndex(([id]) => id === phase));
    find('[data-video-quick-preview]').hidden = !setup;
    find('[data-director-actions]').hidden = setup;
    stage.hidden = setup;
    stage.innerHTML = directorStage(phase, run, bounds().promptMax);
    taskLinks.innerHTML = run ? Object.entries(run.taskLinks).map(([kind, task]) => videoTaskLink(task, '查看' + requestLabels[kind].replace('确认脚本并生成', '视频') + '任务')).join('') : '';
    taskLinks.hidden = !taskLinks.children.length;
    sync();
    if (focus) stage.querySelector('[data-director-script], h4')?.focus();
  }

  async function runTask(kind, payload) {
    const attempt = run.attempts[kind] ??= { key: uid(), payload };
    attempt.task ??= await ctx.api('/v1/tasks', { method: 'POST', body: { ...attempt.payload, idempotencyKey: attempt.key } });
    if (!ctx.active()) return;
    run.taskLinks[kind] = attempt.task;
    render();
    if (kind === 'video') await player.show(attempt.task);
    attempt.task = await waitForModelTask(ctx, attempt.task, 45000);
    if (!ctx.active()) return;
    if (kind === 'video') await player.show(attempt.task);
    if (videoTaskPending(attempt.task)) return '任务仍在执行，可继续查看同一任务。';
    if (attempt.task.state !== 'succeeded') {
      delete run.attempts[kind];
      if (kind === 'video') run.reviseScript = true;
      return '任务未完成，可查看任务详情后重试。';
    }
    if (kind === 'video') { run.completed = true; return ''; }
    try {
      const text = attempt.task.result?.text;
      if (kind === 'insights') { run.facts = directorFacts(text); phase = 'facts'; }
      if (kind === 'directions') { run.directions = directorDirections(text); phase = 'direction'; }
      if (kind === 'script') {
        if (typeof text !== 'string' || !text.trim()) throw new Error('模型未返回脚本，可查看任务或重试。');
        run.script = text.trim();
      }
      return '';
    } catch (error) {
      delete run.attempts[kind];
      return describeError(error);
    }
  }

  async function advance() {
    if (busy || issue || run?.completed || !ctx.active()) return;
    if (!run) {
      run = { frame: media.frame(), input: { notes: fields.notes.value.trim(), modelId: fields.modelId.value,
        ...readVideoSettings(fields) }, selectedFacts: new Set(), attempts: {}, taskLinks: {} };
      leftNotice('请在右侧继续确认。');
    }
    const kind = nextRequest(phase, run);
    busy = true;
    phase = kind;
    run.reviseScript = false;
    render(true);
    stageNotice(kind === 'video' ? '正在提交或读取视频任务…' : '正在' + requestLabels[kind] + '…');
    let message;
    try {
      let payload = run.attempts[kind]?.payload;
      if (!payload && kind === 'video') {
        const asset = await media.uploadFrame(run.frame);
        payload = videoTaskInput({ ...run.input, capabilityId: frameVideoCapabilityId, prompt: run.script.trim(), asset });
      }
      message = await runTask(kind, payload ?? directorPlanInput(kind, run, bounds().promptMax));
      if (ctx.active()) wallet.available = (await ctx.api('/v1/credits/wallet')).available;
    } catch (error) { message = describeError(error); }
    finally {
      if (ctx.active()) {
        busy = false;
        render(true);
        if (message) stageNotice(message);
      }
    }
  }

  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.addEventListener('submit', event => { event.preventDefault(); if (!submit.disabled) void advance(); });
  next.addEventListener('click', () => void advance());
  reset.addEventListener('click', () => {
    if (busy) return;
    run = undefined;
    phase = 'setup';
    player.clear();
    render();
    fields.notes.focus();
  });
  stage.addEventListener('input', event => {
    if (!run || busy) return;
    const field = event.target;
    if (field.name === 'director-fact') {
      if (field.checked) run.selectedFacts.add(Number(field.value));
      else run.selectedFacts.delete(Number(field.value));
    } else if (field.name === 'director-direction' && field.checked) run.selectedDirection = Number(field.value);
    else if (field.hasAttribute('data-director-script')) run.script = field.value;
    sync();
  });
  render();
}
