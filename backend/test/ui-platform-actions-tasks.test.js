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
  const { page, read, open, act, api } = await createStudioFixture(t, { configureProviders(providers) {
    provider(providers, { id: 'platform-chat', capability: 'model.chat', kind: 'text', protocol: 'chat-completions',
      run: async (_task, payload) => {
        const messages = payload.parameters.messages;
        modelCalls.push(messages);
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
  await act('打开工作区访问范围', assistant.getByRole('button', { name: '访问范围' }));
  await assistant.getByText('当前角色 · 所有者', { exact: true }).waitFor();
  await assistant.locator('#composer-access a[href="#settings"]').click();

  const settings = form(page, 'settings');
  await field(settings, 'rememberConversations').uncheck();
  const prefs = await act('保存个人偏好', submit(settings), request('PATCH', '/v1/settings'));
  assert.equal((await prefs.json()).preferences.rememberConversations, false);
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
  await act('通过搜索进入模型对话', search.getByRole('link', { name: '模型对话', exact: true }), request('GET', '/v1/models'));

  await model.selectOption('platform-chat');
  await message.fill('任务初次问题');
  const task = await submitTask('提交文字模型任务');
  const taskPath = '/v1/tasks/' + task.id;
  assert.equal((await read(taskPath)).result.text, textReply);
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
  await message.fill('追问内容');
  const follow = await submitTask('提交续聊任务');
  assert.equal((await read('/v1/tasks/' + follow.id)).parentId, task.id);
  assert.ok(modelCalls.at(-1).some(entry => entry.role === 'assistant' && entry.content === textReply));
  const regenerated = await act('重新生成已经完成的对话', page.locator('[data-regenerate-task]'), request('POST', '/v1/tasks/' + follow.id + '/regenerate'));
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
  const audioDownload = page.waitForEvent('download');
  await act('下载语音问答成品', page.getByRole('button', { name: '下载结果', exact: true }),
    request('GET', '/v1/assets/' + spoken.result.assetId + '/content'));
  assert.deepEqual(await readFile(await (await audioDownload).path()), audio);

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
