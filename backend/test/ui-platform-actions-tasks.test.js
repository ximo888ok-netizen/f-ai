import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { GeneratedFile } from '../src/model-file.js';
import { createStudioFixture } from '../test-support/ui-actions.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const form = (page, name) => page.locator(`[data-form="${name}"]`);
const field = (scope, name) => scope.locator(`[name="${name}"]`);
const submit = scope => scope.locator('button:not([type]), button[type=submit]').last();
const request = (method, path) => ({ method, path });
const textReply = '本机模型已回答验收问题。';

function provider(providers, { id, capability, kind, protocol, run }) {
  providers.set('model:' + id, {
    info: { id, model: id, protocol, kind, capabilities: [capability], streamText: false },
    signature: id + '-test-signature', supports: entry => entry.id === capability, run,
  });
}

test('workspace shell, text and voice tasks, schedules, settings and notifications work in Chrome', options, async t => {
  const audio = process.env.FAI_TEST_FFMPEG_PATH ? execFileSync(process.env.FAI_TEST_FFMPEG_PATH,
    ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.25', '-c:a', 'libmp3lame', '-f', 'mp3', '-'],
    { windowsHide: true, timeout: 10000 }) : Buffer.from('49443304000000000000', 'hex');
  const modelCalls = [];
  const workerOccupied = Promise.withResolvers();
  const releaseWorker = Promise.withResolvers();
  const { page, read, open, act, api } = await createStudioFixture(t, { configureProviders(providers) {
    provider(providers, { id: 'platform-chat', capability: 'model.chat', kind: 'text', protocol: 'chat-completions',
      run: async (_task, payload) => {
        const messages = payload.parameters.messages;
        modelCalls.push(messages);
        if (messages.at(-1).content === '占用本机测试执行器') {
          workerOccupied.resolve();
          await releaseWorker.promise;
        }
        const text = messages[0].content.includes('意图解析器') ? JSON.stringify({ action: 'answer', value: textReply }) : textReply;
        return { type: 'text', text };
      } });
    provider(providers, { id: 'platform-transcription', capability: 'model.transcribe', kind: 'transcription', protocol: 'openai-transcription',
      run: async (_task, payload) => {
        assert.equal(payload.assets[0].mediaType, 'audio/mpeg');
        return { type: 'text', text: '合成录音已转写。' };
      } });
    provider(providers, { id: 'platform-speech', capability: 'model.speech', kind: 'speech', protocol: 'openai-speech',
      run: async (_task, payload) => {
        assert.equal(payload.parameters.input, textReply);
        return new GeneratedFile(audio, 'audio/mpeg', {});
      } });
  } });
  const taskForm = form(page, 'task');
  const status = page.locator('#execution-state');
  const model = field(taskForm, 'modelId');
  const message = field(taskForm, 'conversation.user');
  const submitTask = async label => {
    const response = await act(label, submit(taskForm), request('POST', '/v1/tasks'));
    const task = await response.json();
    await status.getByText('成功', { exact: true }).waitFor({ timeout: 20000 });
    return task;
  };

  const stage = page.getByRole('navigation', { name: '核心工作区切换' });
  await open('home', '#commerce-directory');
  await act('切换到新建任务', stage.getByRole('link', { name: '新建任务', exact: true }), request('GET', '/v1/settings'));
  await act('查看近期任务', page.getByRole('button', { name: '看最近任务', exact: true }), request('GET', '/v1/tasks'));
  await page.locator('.agent-log article.from-agent').waitFor();
  const assistant = page.locator('.agent-home');
  await act('开始新的工作台对话', assistant.locator('.agent-new'));
  await assistant.getByRole('heading', { name: '寰球 AI，我帮你', exact: true }).waitFor();
  await act('打开对话模型列表', assistant.locator('.composer-model'));
  await act('选择本机对话替身', assistant.locator('[data-model-id="platform-chat"]'));
  await assistant.locator('textarea').fill('给我一个简单的验收建议。');
  const assistantTask = await act('发送工作台对话', assistant.getByRole('button', { name: '发送消息' }), request('POST', '/v1/tasks'));
  await assistant.getByText('模型建议：' + textReply, { exact: true }).waitFor({ timeout: 20000 });
  assert.equal((await read('/v1/tasks/' + (await assistantTask.json()).id)).state, 'succeeded');
  await act('为默认模型开始新的对话', assistant.locator('.agent-new'));
  await act('打开默认模型选项', assistant.locator('.composer-model'));
  await act('选择服务端默认对话模型', assistant.locator('[data-model-choice="auto"]'));
  await assistant.locator('textarea').fill('请给出默认模型验收建议。');
  const autoTask = await act('提交由服务端选模的对话', assistant.getByRole('button', { name: '发送消息' }), request('POST', '/v1/tasks'));
  assert.ok(!Object.hasOwn(autoTask.request().postDataJSON(), 'modelId'));
  await assistant.getByText('模型建议：' + textReply, { exact: true }).waitFor({ timeout: 20000 });
  const autoResult = await read('/v1/tasks/' + (await autoTask.json()).id);
  assert.equal(autoResult.state, 'succeeded');
  assert.equal(autoResult.modelId, 'platform-chat');
  await act('打开工作区访问范围', assistant.getByRole('button', { name: '访问范围' }));
  await assistant.getByText('当前角色 · 所有者', { exact: true }).waitFor();
  await assistant.locator('#composer-access a[href="#settings"]').click();

  const settings = form(page, 'settings');
  await field(settings, 'rememberConversations').uncheck();
  const prefsReloaded = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/settings' &&
    response.request().method() === 'GET' && response.ok());
  const prefs = await act('保存个人偏好', submit(settings), request('PATCH', '/v1/settings'));
  assert.equal((await prefs.json()).preferences.rememberConversations, false);
  await prefsReloaded;
  await page.getByText('意见反馈', { exact: true }).click();
  const feedback = form(page, 'feedback');
  await field(feedback, 'category').selectOption('suggestion');
  await field(feedback, 'message').fill('自动验收反馈记录');
  await act('提交设置页反馈', submit(feedback), request('POST', '/v1/feedback'));
  assert.ok((await read('/v1/feedback')).items.some(item => item.message === '自动验收反馈记录'));
  const diagnostics = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/diagnostics' && response.ok());
  await act('检查服务及数据库', page.locator('[data-check]'), request('GET', '/ready'));
  await diagnostics;
  await page.locator('#checks').getByText('工作区数据库', { exact: true }).waitFor();
  await act('从设置打开外观面板', page.locator('#main [data-appearance]'));
  await page.locator('#material-overlay:popover-open').waitFor();
  await page.keyboard.press('Escape');
  await act('从设置打开功能查找', page.locator('#main [data-find-navigation]'));
  const search = page.getByRole('dialog', { name: '查找功能' });
  await search.getByRole('searchbox').fill('模型对话');
  await act('通过搜索进入模型对话', search.locator('a[href="#models"]'), request('GET', '/v1/models'));

  await model.selectOption('platform-chat');
  await field(taskForm, 'mode').selectOption('workflow');
  await message.fill('任务初次问题');
  await act('核对分步工作流参数', taskForm.getByText('核对参数', { exact: true }));
  await taskForm.getByText('任务初次问题', { exact: true }).waitFor();
  const task = await submitTask('提交文字模型分步工作流');
  const taskPath = '/v1/tasks/' + task.id;
  assert.equal((await read(taskPath)).result.text, textReply);
  assert.equal((await read(taskPath + '/inputs')).mode, 'workflow');
  await page.getByText('查询执行日志', { exact: true }).click();
  const journal = form(page, 'journal');
  await field(journal, 'level').selectOption('info');
  await act('查询任务日志', submit(journal), request('GET', taskPath + '/events'));
  await page.locator('[data-journal-results] article').first().waitFor();
  const base = await api('POST', '/v1/knowledge/bases', { name: '任务输出验收库' });
  await page.reload();
  await page.getByText('修订与导出文本', { exact: true }).click();
  const delivery = form(page, 'text-delivery');
  await field(delivery, 'content').fill('修订后的任务答复。');
  const txt = page.waitForEvent('download');
  await act('下载当前修订稿', page.locator('[data-text-download]'));
  assert.equal(await readFile(await (await txt).path(), 'utf8'), '修订后的任务答复。');
  await field(delivery, 'baseId').selectOption(base.id);
  await field(delivery, 'name').fill('任务结果修订');
  await act('将任务修订稿另存到知识库', submit(delivery), request('POST', `/v1/knowledge/bases/${base.id}/documents`));
  await page.getByRole('link', { name: '已保存，打开知识文档' }).waitFor();

  await act('读取原输入并继续这段对话', page.getByRole('link', { name: '继续这段对话' }), request('GET', taskPath + '/inputs'));
  const historyDetails = page.locator('#main details').filter({ has: page.getByText('本次带入的消息', { exact: true }) });
  const historySummary = historyDetails.getByText('本次带入的消息', { exact: true });
  await act('展开本次带入的消息', historySummary);
  await historyDetails.getByText('任务初次问题', { exact: true }).waitFor();
  const priorReply = historyDetails.getByText(textReply, { exact: true });
  await priorReply.waitFor();
  await act('收起本次带入的消息', historySummary);
  await priorReply.waitFor({ state: 'hidden' });
  await message.fill('追问内容');
  const follow = await submitTask('提交续聊任务');
  assert.equal((await read('/v1/tasks/' + follow.id)).parentId, task.id);
  assert.ok(modelCalls.at(-1).some(entry => entry.role === 'assistant' && entry.content === textReply));
  const followPath = '/v1/tasks/' + follow.id;
  await act('重新打开任务参数并验证回填', page.getByRole('link', { name: '修改参数再提交' }), request('GET', followPath + '/inputs'));
  assert.equal(await message.inputValue(), '追问内容');
  await act('查看原对话任务', page.getByRole('link', { name: '查看原任务' }), request('GET', followPath));
  const regenerated = await act('重新生成已经完成的对话', page.locator('[data-regenerate-task]'), request('POST', followPath + '/regenerate'));
  const regeneratedTask = await regenerated.json();
  await page.waitForURL('**/#tasks/' + regeneratedTask.id);
  await status.getByText('成功', { exact: true }).waitFor({ timeout: 20000 });

  await open('models', taskForm);
  await model.selectOption('platform-chat');
  await message.fill('未来计划任务');
  const runAt = await page.evaluate(() => {
    const future = new Date(Date.now() + 3600000);
    return new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  await field(taskForm, 'runAt').fill(runAt);
  const scheduleResponse = await act('创建定时任务', submit(taskForm), request('POST', '/v1/schedules'));
  const schedule = await scheduleResponse.json();
  await act('取消定时任务', page.locator(`[data-cancel-schedule="${schedule.id}"]`), request('POST', '/v1/schedules/' + schedule.id + '/cancel'));
  assert.equal((await read('/v1/schedules')).items.find(item => item.id === schedule.id).state, 'cancelled');

  const voice = form(page, 'voice-question');
  await open('models/voice', voice);
  await act('使用浏览器虚拟麦克风开始录音', voice.locator('[data-start-recording]'));
  await page.getByText('正在录音…', { exact: true }).waitFor();
  await act('停止录音', voice.locator('[data-stop-recording]'));
  await page.locator('#voice-status').filter({ hasText: /麦克风录音.*待上传/ }).waitFor();
  await field(voice, 'audioFile').setInputFiles({ name: 'synthetic.mp3', mimeType: 'audio/mpeg', buffer: audio });
  await field(voice, 'transcriptionModelId').selectOption('platform-transcription');
  await field(voice, 'chatModelId').selectOption('platform-chat');
  await field(voice, 'speechModelId').selectOption('platform-speech');
  const audioUploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/assets' &&
    response.request().method() === 'POST' && response.ok());
  const voiceResponse = await act('上传音频并提交语音问答', submit(voice), request('POST', '/v1/tasks'));
  const inputAudio = await (await audioUploaded).json();
  assert.equal(inputAudio.mediaType, 'audio/mpeg');
  const voiceTask = await voiceResponse.json();
  await page.getByText('合成录音已转写。', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByText(textReply, { exact: true }).waitFor();
  const spoken = await read('/v1/tasks/' + voiceTask.id);
  if (process.env.FAI_TEST_FFMPEG_PATH) {
    const playback = page.locator('#media-result audio');
    await playback.waitFor();
    await playback.click({ position: { x: 23, y: 26 } });
    await page.waitForFunction(() => document.querySelector('#media-result audio')?.currentTime > 0);
    t.diagnostic('UI action: 播放已合成的语音回答并验证播放进度');
  }
  const audioDownload = page.waitForEvent('download');
  await act('下载语音问答成品', page.getByRole('button', { name: '下载结果', exact: true }),
    request('GET', '/v1/assets/' + spoken.result.assetId + '/content'));
  assert.deepEqual(await readFile(await (await audioDownload).path()), audio);

  await api('POST', '/v1/tasks', { capabilityId: 'model.chat', mode: 'chat', modelId: 'platform-chat',
    idempotencyKey: 'hold-worker-for-cancel', parameters: { messages: [{ role: 'user', content: '占用本机测试执行器' }] } });
  try {
    await workerOccupied.promise;
    await open('models', taskForm);
    await model.selectOption('platform-chat');
    await message.fill('取消尚未执行的任务');
    const queuedResponse = await act('提交待取消文字任务', submit(taskForm), request('POST', '/v1/tasks'));
    const queued = await queuedResponse.json();
    const queuedPath = '/v1/tasks/' + queued.id;
    const cancelled = await act('取消从未开始的排队任务', page.locator('[data-cancel-task]'), request('POST', queuedPath + '/cancel'));
    assert.equal((await cancelled.json()).state, 'cancelled');
    await status.getByText('已取消', { exact: true }).waitFor();
  } finally {
    releaseWorker.resolve();
  }

  await open('inbox', '[data-read-all]');
  const notices = await read('/v1/notifications');
  const unread = notices.items.find(item => !item.readAt);
  assert.ok(unread);
  await act('标记单条任务通知已读', page.locator(`[data-read-id="${unread.id}"]`), request('POST', '/v1/notifications/' + unread.id + '/read'));
  await act('打开仅看未读', page.getByRole('link', { name: '仅看未读' }), request('GET', '/v1/notifications'));
  await act('标记所有通知已读', page.locator('[data-read-all]'), request('POST', '/v1/notifications/read-all'));
  await page.getByText('0 条未读', { exact: true }).waitFor();
  assert.equal((await read('/v1/notifications?limit=1')).unread, 0);
  await open('account', '[data-logout]');
  await act('从账号页退出登录', page.locator('#main [data-logout]'), request('POST', '/v1/auth/logout'));
  await form(page, 'auth').waitFor();
});

test('a disconnected streaming reply can resume from the last displayed chunk in Chrome', options, async t => {
  const finished = Promise.withResolvers();
  const first = '第一段已到达。';
  const second = '第二段续接成功。';
  const { page, open, act, read } = await createStudioFixture(t, { configureProviders(providers) {
    providers.set('model:platform-stream', {
      info: { id: 'platform-stream', model: 'Platform stream fixture', protocol: 'chat-completions', kind: 'text',
        capabilities: ['model.chat'], streamText: true },
      signature: 'platform-stream-fixture',
      supports: entry => entry.id === 'model.chat',
      run: async () => ({ type: 'text', text: first + second }),
      async streamText(_payload, send) {
        await send(1, first);
        await finished.promise;
        await send(2, second);
        return { type: 'text', text: first + second };
      },
    });
  } });
  let disconnected = false;
  await page.addInitScript(() => {
    const fetch = window.fetch;
    const drop = new AbortController();
    window.disconnectFixtureStream = () => drop.abort();
    let firstStream = true;
    window.fetch = (input, init) => {
      if (firstStream && new URL(input, location.origin).pathname.endsWith('/stream')) {
        firstStream = false;
        return fetch(input, { ...init, signal: AbortSignal.any([init.signal, drop.signal]) });
      }
      return fetch(input, init);
    };
  });
  await page.route(/\/v1\/tasks\/[^/]+\/stream\?/, route => disconnected ? route.abort() : route.fallback());
  try {
    const editor = form(page, 'task');
    await open('models', editor);
    await field(editor, 'modelId').selectOption('platform-stream');
    await field(editor, 'stream').check();
    await field(editor, 'conversation.user').fill('检查分段接续。');
    const response = await act('提交流式文字任务', submit(editor), request('POST', '/v1/tasks'));
    const { id } = await response.json();
    const endpoint = '/v1/tasks/' + id;
    await page.locator('#reply-text').filter({ hasText: first }).waitFor({ timeout: 20000 });
    disconnected = true;
    await page.evaluate(() => window.disconnectFixtureStream());
    const resume = page.locator('[data-resume-reply]');
    await resume.waitFor({ timeout: 25000 });
    disconnected = false;
    const resumed = await act('从上次分段继续接收', resume, request('GET', endpoint + '/stream'));
    assert.equal(new URL(resumed.url()).searchParams.get('after'), '1');
    finished.resolve();
    await page.locator('pre.live-result:not(#reply-text)').filter({ hasText: first + second }).waitFor({ timeout: 20000 });
    const completed = await read(endpoint);
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.result.text, first + second);
  } finally {
    finished.resolve();
  }
});
