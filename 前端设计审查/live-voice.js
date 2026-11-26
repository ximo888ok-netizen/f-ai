import { action, field, form, input, link, notice, panel, retryKey, select } from './live.js';
import { uploadMedia } from './live-workspace.js';

const recordLimitMs = 60000;
const maxFileBytes = 10 * 1024 * 1024;
const audioExtensions = /\.(mp3|mp4|m4a|webm)$/i;
const stages = [
  ['transcriptionModelId', '转写模型', 'model.transcribe'],
  ['chatModelId', '对话模型', 'model.chat'],
  ['speechModelId', '语音合成模型', 'model.speech'],
];

export async function voiceQuestion(ctx, { title, links, enabled, capability }) {
  if (!enabled || !capability.available) {
    ctx.html(title + links + notice(enabled
      ? '单轮语音在当前工作区不可用。请管理员核对能力权限及转写、对话和语音合成模型配置。' : '当前工作区已停用模型工具。'));
    return;
  }
  const [{ items: models }, wallet] = await Promise.all([ctx.api('/v1/models'), ctx.api('/v1/credits/wallet')]);
  if (!ctx.active()) return;

  const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
    .find(type => window.MediaRecorder?.isTypeSupported(type));
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && mimeType);
  const settings = stages.map(([name, label, id]) => field(label, select(name,
    models.filter(model => model.capabilities.includes(id)).map(model => [model.id, model.id + ' · ' + model.model]),
    undefined, 'required'))).join('');
  ctx.html(title + links + panel('录音与模型',
    form('voice-question',
      (canRecord ? '<div class="live-row">' + action('开始录音', 'start-recording') +
        action('停止录音', 'stop-recording') + '</div>' + notice('单次录音最长 60 秒。') :
        notice('当前浏览器无法录音，可以选择已有音频。')) +
      field('选择已有音频', input('audioFile', 'type="file" accept=".mp3,.mp4,.m4a,.webm"')) +
      '<p id="voice-status" class="live-muted" role="status">MP3、MP4、M4A 或 WebM，最大 10 MiB。</p>' +
      settings + field('合成音色', input('voice', 'required maxlength="100" value="alloy"')) +
      notice('本次任务 ' + capability.cost + ' 积分 · 当前可用 ' + wallet.available + ' 积分。提交后录音将保存到素材库。'),
    '上传并开始问答')) + link('查看任务记录', 'tasks'));

  const voiceForm = document.querySelector('[data-form=voice-question]');
  const fileControl = voiceForm.elements.audioFile;
  const send = voiceForm.querySelector('button.primary');
  const start = voiceForm.querySelector('[data-start-recording]');
  const stop = voiceForm.querySelector('[data-stop-recording]');
  const status = voiceForm.querySelector('#voice-status');
  const submissionKey = retryKey();
  let clip, source, uploaded, stream, recorder, timer;
  let opening = false;
  let submitting = false;

  function controls() {
    const recording = Boolean(recorder);
    if (start) start.disabled = opening || recording || submitting;
    if (stop) stop.disabled = !recording || recorder.state !== 'recording';
    fileControl.disabled = opening || recording || submitting;
    send.disabled = opening || recording || submitting || !clip;
  }

  function releaseMicrophone() {
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = recorder = undefined;
  }
  ctx.signal.addEventListener('abort', releaseMicrophone, { once: true });

  function choose(file, provenance) {
    clip = uploaded = undefined;
    if (!file?.size || file.size > maxFileBytes || !audioExtensions.test(file.name)) {
      status.textContent = '请选择非空的 MP3、MP4、M4A 或 WebM 文件，最大 10 MiB。';
    } else {
      clip = file;
      source = provenance;
      status.textContent = file.name + ' · 待上传';
    }
    controls();
  }

  fileControl.addEventListener('change', () => choose(fileControl.files[0], '本地选择'));
  start?.addEventListener('click', async () => {
    opening = true;
    controls();
    status.textContent = '正在申请麦克风权限…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!ctx.active()) { releaseMicrophone(); return; }
      const chunks = [];
      const activeRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      recorder = activeRecorder;
      activeRecorder.addEventListener('dataavailable', event => {
        if (event.data.size) chunks.push(event.data);
      });
      activeRecorder.addEventListener('error', () => {
        if (recorder !== activeRecorder) return;
        releaseMicrophone();
        if (ctx.active()) { status.textContent = '录音失败，请重试或选择已有音频。'; controls(); }
      });
      activeRecorder.addEventListener('stop', () => {
        if (recorder !== activeRecorder) return;
        releaseMicrophone();
        if (!ctx.active()) return;
        const type = mimeType.split(';')[0];
        const extension = type === 'audio/mp4' ? '.m4a' : '.webm';
        choose(new File(chunks, '麦克风录音' + extension, { type }), '麦克风录音');
      }, { once: true });
      activeRecorder.start();
      clip = uploaded = undefined;
      fileControl.value = '';
      status.textContent = '正在录音…';
      timer = setTimeout(stopRecording, recordLimitMs);
    } catch (error) {
      releaseMicrophone();
      if (ctx.active()) status.textContent = error.name === 'NotAllowedError'
        ? '麦克风权限未获准。可授权后重试，或选择已有音频。' : '无法启动麦克风，请重试或选择已有音频。';
    } finally {
      opening = false;
      if (ctx.active()) controls();
    }
  });
  function stopRecording() {
    if (recorder?.state !== 'recording') return;
    recorder.stop();
    controls();
  }
  stop?.addEventListener('click', stopRecording);
  controls();

  ctx.submit('voice-question', async data => {
    if (!clip || submitting || recorder || opening) return;
    const voice = data.get('voice').trim();
    if (!voice) throw new Error('请填写合成音色。');
    submitting = true;
    controls();
    try {
      if (!uploaded) {
        status.textContent = '正在上传录音…';
        const media = new FormData();
        media.set('file', clip);
        media.set('source', source);
        media.set('purpose', '单轮语音问答');
        uploaded = await uploadMedia(ctx, media);
      }
      if (!ctx.active()) return;
      status.textContent = '正在提交语音问答…';
      const parameters = { assetIds: [uploaded.id], voice };
      for (const [name] of stages) parameters[name] = data.get(name);
      const body = { capabilityId: capability.id, mode: 'chat', parameters };
      const task = await ctx.api('/v1/tasks', { method: 'POST', body: { ...body, idempotencyKey: submissionKey(body) } });
      ctx.go('tasks/' + task.id);
    } catch (error) {
      if (ctx.active()) status.textContent = uploaded ? '录音已上传，可继续提交本次问答。' : '未收到上传结果，可重试。';
      throw error;
    } finally {
      submitting = false;
      if (ctx.active()) controls();
    }
  });
}
