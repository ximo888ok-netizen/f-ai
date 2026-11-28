import { renderImageTool, bindImageTool } from './live-image-studio.js';
import { bindTextDelivery, textDelivery } from './live-text-delivery.js';
import { taskIntake } from './live-task-intake.js';
import { editContext, restoreInputs, editSummary, journalPanel, bindJournal } from './live-task-edit.js';
import { cardTitle, platforms, schemaFields, parametersFrom } from './live-task-fields.js';
import { capabilityList, creationStart, displayStatus, getCatalog, library, manager } from './live-catalog.js';

import { downloadFile } from './live-files.js';
import { replyStreamPanel, watchReplyStream } from './live-task-stream.js';
import { mountTaskTrace } from './live-task-trace.js';
import { voiceQuestion } from './live-voice.js';
import { action, date, field, form, h, heading, input, item, link, list, notice, panel, path, result, select, toast, uid } from './live.js';

const states = { queued:'排队中', running:'执行中', succeeded:'成功', failed:'失败', cancelled:'已取消',
  pending:'待派发', submitted:'已派发' };
const pending = v => v.state === 'queued' || v.state === 'running';
const getManagersShops = async ctx => ctx.manager ? (await ctx.api('/v1/shops')).items : [];
const taskPath = id => '/v1/tasks/' + path(id);
const taskRoute = id => 'tasks/' + id;
const drafts = new Map();
function submissionKey(scope, payload) {
  const data = JSON.stringify(payload);
  if (drafts.get(scope)?.data !== data) drafts.set(scope, { data, key: uid() });
  return drafts.get(scope).key;
}

const conversationLinks = () => '<div class="live-row">' + link('文字对话', 'models') + link('语音问答', 'models/voice') + '</div>';

function conversation(ctx) {
  return create(ctx, ['models', ctx.args[0] === 'voice' ? 'model.voice-turn' : 'model.chat']);
}

async function create(ctx, args = ctx.args) {
  const plugins = await getCatalog(ctx);
  const [pluginId, capabilityId] = args;
  const plugin = plugins.find(candidate => candidate.id === pluginId);
  const capability = plugin?.capabilities.find(candidate => candidate.id === capabilityId);
  if (!plugin) {
    ctx.html(creationStart(plugins, ctx));
    return;
  }
  const localTools={
    image:link('打开本地图片处理','media/images'),
    video:link('打开视频分镜','media/storyboards')+link('视频导出','media/video'),
    copywriting:link('平台文案校验','copy-review'),
    models:conversationLinks(),
  }[plugin.id] ?? '';
  if (!capability) {
    ctx.html(capabilityList(plugin, ctx, localTools));
    return;
  }
  const title = heading(cardTitle(capability), plugin.name + ' · ' + displayStatus(plugin, capability, ctx));
  const chat = capability.id === 'model.chat';
  if (capability.id === 'model.voice-turn') {
    return voiceQuestion(ctx, {title, links:localTools, enabled:plugin.enabled, capability});
  }
  if (capability.endpoint || !plugin.enabled || (plugin.id === 'operations' && !ctx.manager)) {
    ctx.html(title + (capability.endpoint ? link('打开客服工作台', 'customer') : notice('当前工作区无法提交此能力。')) +
      '<div class="live-row">'+localTools+link('返回创作台','create/'+plugin.id)+'</div>');
    return;
  }

  const [assets, projects, models, wallet, allShops, products, guidance] = await Promise.all([
    ctx.all('/v1/assets'), ctx.all('/v1/projects'), ctx.api('/v1/models?capabilityId=' + path(capability.id)),
    ctx.api('/v1/credits/wallet'), plugin.id === 'operations' ? getManagersShops(ctx) : [],
    capability.parameters.properties?.product ? ctx.all('/v1/studio/products') : [],
    chat ? ctx.all('/v1/library?enabled=true') : [],
  ]);
  const shops = allShops.filter(shop => shop.capabilities.includes(capability.id));
  if (plugin.id === 'operations' && !shops.length) {
    ctx.html(title + notice('当前工作区没有已绑定且获准执行此操作的店铺。') + link('查看店铺', 'shops'));
    return;
  }
  let fields = field('执行方式', select('mode', capability.modes.map(mode => [mode, mode === 'chat' ? '对话' : '分步工作流']), chat ? 'chat' : 'workflow', 'required'));
  const defaultStream = chat && models.items.find(model => model.streamText);
  if (models.items.length) fields += field('模型', select('modelId',
    [['', '服务端自动选择'], ...models.items.map(model => [model.id, model.id + ' · ' + model.model])], defaultStream?.id));
  if (defaultStream) fields += '<label class="live-check">' + input('stream', 'type="checkbox" checked') + '流式显示回复</label>';
  if (projects.length) fields += field('关联项目', select('projectId', [['', '未关联'], ...projects.map(project => [project.id, project.name])]));
  if (products.length) fields += field('从商品档案带入信息', select('productRecord',
    [['', '手动填写'], ...products.map(product => [product.id, product.sku + ' · ' + product.name])]));
  fields += schemaFields(capability.parameters, 'params.', { assets, shops, capability, guidance, selectedGuidance:ctx.args[0]==='expert'?[ctx.args[1]]:[] });
  if (!capability.requiresConfirmation) fields += field('定时运行时间（留空则立即执行）', input('runAt', 'type="datetime-local"'));
  const edit=await editContext(ctx,capability,args);
  if (!ctx.active()) return;
  const description = '本次任务 ' + capability.cost + ' 积分 · 当前可用 ' + wallet.available + ' 积分';
  const taskFields = form('task', fields, capability.requiresConfirmation ? '生成变更预览' : chat ? '发送消息' : '提交任务');
  if (plugin.id === 'image') {
    renderImageTool(ctx, capability, description, editSummary(edit), taskFields);
  } else {
    ctx.html(title + (chat ? localTools : '') + editSummary(edit) + panel(description, taskFields) +
      '<div id="shop-confirmation"></div>' + link('返回能力列表', 'create/' + plugin.id));
  }
  const taskForm = document.querySelector('[data-form=task]');
  restoreInputs(taskForm, edit);
  taskIntake(taskForm, capability);
  if (plugin.id === 'image') bindImageTool(ctx, capability, taskForm);
  ctx.on('[name=productRecord]', 'change', node => {
    const product = products.find(entry => entry.id === node.value);
    if (product) document.querySelector('[name="params.product"]').value = [product.name, product.sku, product.description].join('\n').slice(0, 4000);
  });
  if (defaultStream) ctx.on('[name=modelId]', 'change', node => {
    const toggle = node.form.elements.stream;
    const canStream = models.items.some(model => model.id === node.value && model.streamText);
    if (toggle.disabled && canStream) toggle.checked = true;
    if (!canStream) toggle.checked = false;
    toggle.disabled = !canStream;
  });
  if (!capability.available) {
    const submit=taskForm.querySelector('button[type=submit],button:not([type])');
    submit.disabled=true;submit.textContent='需要已接入的服务';
    taskForm.addEventListener('submit',event=>event.preventDefault());
    return;
  }
  const scope = ctx.workspace.id + ':' + ctx.account.id + ':' + capability.id;
  ctx.submit('task', async (data, node) => {
    const parameters = parametersFrom(capability.parameters, 'params.', data, shops);
    if(edit?.follow){
      const messages=parameters.messages;
      parameters.messages=[...messages.filter(m=>m.role==='system'),...edit.history,messages.at(-1)];
    }
    if (defaultStream && data.has('stream')) parameters.stream = true;
    const payload = { capabilityId: capability.id, mode: data.get('mode'), parameters };
    if (edit && !data.get('runAt')) payload.parentId=edit.id;
    if (data.get('modelId')) payload.modelId = data.get('modelId');
    if (data.get('projectId')) payload.projectId = data.get('projectId');
    if (data.get('runAt')) payload.runAt = new Date(data.get('runAt')).toISOString();
    if (capability.requiresConfirmation) {
      const preview = await ctx.api('/v1/shops/previews', { method: 'POST', body: { capabilityId: capability.id, parameters } });
      if (!ctx.active()) return;
      const grant = { ...payload, parameters: preview.parameters, confirmationId: preview.confirmationId };
      node.hidden = true;
      document.querySelector('#shop-confirmation').innerHTML = panel('请核对以下店铺变更',
        notice('店铺：'+(shops.find(s=>s.id===preview.parameters.shopId)?.name??preview.parameters.shopId)+' · 有效期至 ' + date(preview.expiresAt)) + result(preview.parameters) +
        form('confirm-shop', field('我已核对目标店铺及变更内容', input('confirm', 'type="checkbox" required')), '确认并提交') +
        action('修改参数', 'change-preview'));
      ctx.click('change-preview', () => {
        document.querySelector('#shop-confirmation').textContent = '';
        node.hidden = false;
      });
      ctx.submit('confirm-shop', () => enqueue(grant));
    } else await enqueue(payload);
  });

  async function enqueue(payload) {
    const endpoint = payload.runAt ? '/v1/schedules' : '/v1/tasks';
    const data = await ctx.api(endpoint, { method: 'POST', body: { ...payload, idempotencyKey: submissionKey(scope, payload) } });
    drafts.delete(scope);
    ctx.go(payload.runAt ? 'schedules' : taskRoute(data.id));
  }
}

function mediaTag(url, type) {
  if (type === 'image') return '<img class="live-media" alt="生成结果" src="' + h(url) + '">';
  if (type === 'video' || type === 'audio') return '<' + type + ' class="live-media" controls src="' + h(url) + '"></' + type + '>';
  return '';
}

function httpsUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export function downloadAsset(ctx,id,name,variant='content',options={}) {
  return downloadFile(ctx,'/v1/assets/'+path(id)+'/'+variant,name,options);
}

async function tasks(ctx) {
  const [id, filter, pageNumber] = ctx.args;
  if (!id || id==='state') {
    const allowed=['queued','running','succeeded','failed','cancelled'];
    const state = allowed.includes(filter) ? filter : 'all';
    const page = /^\d{1,6}$/.test(pageNumber ?? '') ? Math.min(Number(pageNumber), 25000) : 0;
    const pageSize = 40;
    const query = new URLSearchParams({limit: String(pageSize + 1), offset: String(page * pageSize)});
    if (state !== 'all') query.set('state', state);
    const endpoint = '/v1/tasks?' + query;
    const choices='<div class="live-row">'+link('全部任务','tasks')+allowed.map(k=>link(states[k],'tasks/state/'+k)).join('')+'</div>';
    const [result, plugins] = await Promise.all([ctx.api(endpoint), getCatalog(ctx)]);
    const items = result.items.slice(0, pageSize);
    const pageRoute = 'tasks/state/' + state + '/';
    const pagination = '<div class="live-row">' +
      (page ? link('上一页', pageRoute + (page - 1)) : '') +
      (page < 25000 && result.items.length > pageSize ? link('下一页', pageRoute + (page + 1)) : '') + '</div>';
    const names = new Map(plugins.flatMap(plugin => plugin.capabilities.map(capability => [capability.id, cardTitle(capability)])));
    ctx.html(heading('任务记录') + choices + panel('当前工作区任务', list(items, task => item(names.get(task.capabilityId) ?? task.capabilityId,
      states[task.state] + ' · ' + date(task.createdAt), link('查看任务', taskRoute(task.id)))) + pagination));
    const snapshot = data => data.items.map(task => task.id + task.state).join(',');
    if (items.some(pending)) watch(ctx, endpoint, snapshot, snapshot(result));
    return;
  }
  const [task, plugins] = await Promise.all([ctx.api(taskPath(id)), getCatalog(ctx)]);
  if (!ctx.active()) return;
  const capability = plugins.flatMap(plugin => plugin.capabilities).find(entry => entry.id === task.capabilityId);
  const output = task.result;
  const voice = task.capabilityId === 'model.voice-turn';
  const showStream = task.streamed && pending(task);
  const externalUrl = httpsUrl(output?.url);
  const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4' }[output?.mediaType] ?? '';
  let outputPanel = '';
  if (output) {
    if (voice) outputPanel += '<h3>录音转写</h3>' + result(output.transcript) + '<h3>模型回答</h3>' + result(output.answer);
    if (['image','video'].includes(output.type)) outputPanel += notice('AI 生成');
    if (output.assetId) {
      outputPanel += action('下载结果', 'asset-download', output.assetId) + link('在素材库查看', 'assets') + '<div id="media-result"></div>';
      if (['image/png','image/jpeg'].includes(output.mediaType)) {
        outputPanel += action('下载带标识图片','delivery-download',output.assetId) + link('用作新草稿主图', 'drafts/new/image/' + path(output.assetId));
      } else if (output.mediaType==='video/mp4') {
        const {available}=await ctx.api('/v1/video-export/status');
        if (available) outputPanel += action('下载带标识视频','delivery-download',output.assetId) +
          link('调整画幅或导出音轨','media/video/'+output.assetId);
        else outputPanel += notice('当前部署未启用视频标识导出。');
      }
    }
    else if (externalUrl) outputPanel += mediaTag(externalUrl, output.type) + '<a class="smallbtn" href="' + h(externalUrl) +
      '" target="_blank" rel="noopener noreferrer">打开生成结果</a>';
    else if (output.text !== undefined) {
      outputPanel += result(output.text);
      if(typeof output.text==='string'&&output.text)outputPanel+=textDelivery(output.text,capability?cardTitle(capability):task.capabilityId,ctx.manager?await ctx.all('/v1/knowledge/bases'):[]);
      if (typeof output.text === 'string' && output.text.length && output.text.length <= 8000) {
        outputPanel += link('用作新草稿描述', 'drafts/new/text/' + path(task.id));
      }
    }
    else outputPanel += result(output);
  }
  const controls = (task.state === 'queued' && task.attempts === 0 ? action('取消任务', 'cancel-task') : '') +
    (!pending(task) && capability && !capability.requiresConfirmation && capability.available ? action('重新生成', 'regenerate-task') : '');
  const parent=task.parentId?link('查看原任务',taskRoute(task.parentId)):'';
  const revise=!pending(task)&&capability&&!voice?link('修改参数再提交','create/'+capability.pluginId+'/'+capability.id+'/revise/'+path(id)):'';
  const follow=task.capabilityId==='model.chat'&&task.state==='succeeded'&&output?.text?link('继续这段对话','models/follow/'+path(id)):'';
  if (!ctx.active()) return;
  ctx.html(heading(capability ? cardTitle(capability) : task.capabilityId, task.id) +
    panel('执行状态', '<div id="execution-state">' + item(states[task.state], date(task.updatedAt) + ' · ' +
      task.cost + ' 积分' + (task.featureVersion ? ' · 功能版本 ' + task.featureVersion : '') + (task.errorCode ? ' · ' + task.errorCode : ''), controls+revise+follow+parent) + '</div>' +
      '<div data-task-trace>' + notice('正在读取执行轨迹…') + '</div>'+journalPanel()) +
    (showStream ? replyStreamPanel() : '') + (outputPanel ? panel('实际结果', outputPanel) : '') +
    '<div class="live-row">' + (voice ? link('继续语音问答', 'models/voice') : task.capabilityId === 'model.chat' ? link('返回文字对话', 'models') : '') +
    link('返回任务记录', 'tasks') + '</div>');
  bindTextDelivery(ctx, id);
  bindJournal(ctx,taskPath(id));
  const refreshTrace = mountTaskTrace(ctx, document.querySelector('[data-task-trace]'), taskPath(id));
  const traceVersion = record => [record.state, record.attempts, record.updatedAt].join(':');
  let lastTrace = traceVersion(task);
  function syncTrace(record) {
    const version = traceVersion(record);
    if (version !== lastTrace) { lastTrace = version; void refreshTrace(); }
  }
  ctx.click('cancel-task', async () => { await ctx.api(taskPath(id) + '/cancel', { method: 'POST' }); ctx.reload(); });
  ctx.click('regenerate-task', async () => {
    const stableKey = submissionKey('retry:' + id, {});
    const child = await ctx.api(taskPath(id) + '/regenerate', { method: 'POST', body: { idempotencyKey: stableKey } });
    drafts.delete('retry:' + id);
    ctx.go(taskRoute(child.id));
  });
  ctx.click('asset-download', asset => downloadAsset(ctx, asset, task.id + extension));
  ctx.click('delivery-download',asset=>downloadAsset(ctx,asset,'delivery-'+task.id+extension,'delivery'));
  if (output?.assetId && ['image','audio','video'].includes(output.type)) {
    try {
      const response = await ctx.api('/v1/assets/' + path(output.assetId) + '/content', { raw: true });
      const blob = await response.blob();
      if (ctx.active()) {
        const url = URL.createObjectURL(blob);
        ctx.signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true });
        document.querySelector('#media-result').innerHTML = mediaTag(url, output.type);
      }
    } catch (error) { if (ctx.active()) toast(error.message); }
  }
  if (showStream) watchReplyStream(ctx, taskPath(id), data => {
    document.querySelector('#execution-state strong').textContent = states[data.state];
    syncTrace(data);
    const cancel = document.querySelector('[data-cancel-task]');
    if (cancel && (data.state !== 'queued' || data.attempts > 0)) cancel.hidden = true;
  });
  else if (pending(task)) watch(ctx, taskPath(id), item => item.state + item.attempts, task.state + task.attempts, syncTrace);
}

function watch(ctx, endpoint, snapshot, original, onUpdate) {
  const check = async () => {
    if (!ctx.active()) return;
    try {
      const data = await ctx.api(endpoint);
      if (snapshot(data) !== original && !document.querySelector('[data-pending]')) { ctx.reload(); return; }
      if (ctx.active()) onUpdate?.(data);
    } catch (error) { if (ctx.active()) toast(error.message); }
    if (ctx.active()) timer = setTimeout(check, 2500);
  };
  let timer = setTimeout(check, 2500);
  ctx.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
}

async function schedules(ctx) {
  const records = await ctx.all('/v1/schedules');
  ctx.html(heading('定时任务', '在创作表单选择定时运行时间即可创建计划。') + panel('执行计划', list(records, schedule =>
    item(schedule.request.capabilityId, states[schedule.state] + ' · ' + date(schedule.runAt) + (schedule.errorCode ? ' · ' + schedule.errorCode : ''),
      (schedule.state === 'pending' ? action('取消计划', 'cancel-schedule', schedule.id) : '') +
      (schedule.taskId ? link('查看任务', taskRoute(schedule.taskId)) : '')))) + link('创建定时任务', 'create'));
  ctx.click('cancel-schedule', async id => { await ctx.api('/v1/schedules/' + path(id) + '/cancel', { method: 'POST' }); ctx.reload(); });
  if (records.some(record => record.state === 'pending')) watch(ctx, '/v1/schedules?limit=100',
    data => data.items.map(record => record.id + record.state).join(','), records.slice(0, 100).map(record => record.id + record.state).join(','));
}

async function shops(ctx) {
  const [plugins, shops] = await Promise.all([getCatalog(ctx), getManagersShops(ctx)]);
  const plugin = plugins.find(entry => entry.id === 'operations');
  ctx.html(heading('店铺运营') + (ctx.manager&&ctx.enterprise?'<a class="smallbtn" href="/merchant#connections">管理店铺接入</a>':'') + (ctx.manager ? link('拼多多运营台账', 'commerce') : '') + link('拼多多草稿', 'drafts') + panel('已授权店铺', !ctx.manager ? notice('需要工作区管理员权限。') :
    list(shops, shop => item(shop.name, platforms[shop.platform]+' · '+(shop.authorizedUntil?(Date.parse(shop.authorizedUntil)<=Date.now()?'授权已到期 · ':'授权至 ')+date(shop.authorizedUntil):'未登记到期日'),
      shop.capabilities.map(id => link(plugin.capabilities.find(cap => cap.id === id)?.name ?? id, 'create/operations/' + id)).join(' ')),
    '当前工作区没有已绑定的店铺。')) + link('查看运营能力', 'create/operations'));
}

export const taskPages = { library, manager, create, tasks, schedules, shops, conversation };
