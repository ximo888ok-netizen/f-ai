
import { action, button, date, field, form, grid, h, heading, input, item, link, list, notice, panel, path, result, select, textarea, toast, uid } from './live.js';

const platforms = { taobao: '淘宝', pinduoduo: '拼多多', douyin: '抖店' };
const labels = {
  prompt:'创作提示词', assetIds:'素材库文件', ratio:'画幅比例', templateId:'模板编号', format:'输出格式', options:'进阶参数',
  skuCodes:'SKU 编号，每行一个', productColor:'商品颜色', scale:'放大倍数', durationSeconds:'视频时长（秒）', keepAudio:'保留音轨',
  editInstructions:'编辑要求', product:'商品信息', platform:'平台', language:'语言', instructions:'补充要求', content:'待检测文案',
  shopId:'店铺', startDate:'开始日期', endDate:'结束日期', productIds:'商品编号，每行一个', listing:'发布内容', title:'商品标题',
  categoryId:'平台分类编号', description:'商品详情', variants:'规格清单', changes:'待变更商品清单', messages:'对话消息',
  input:'输入文本', voice:'音色', query:'查询文本', documents:'待重排文档，每行一项', topN:'最多返回数量',
  chat:'模型对话', embed:'文本向量', rerank:'文本重排', speech:'语音合成', transcribe:'语音转写',
};
const states = { queued:'排队中', running:'执行中', succeeded:'成功', failed:'失败', cancelled:'已取消',
  pending:'待派发', submitted:'已派发' };
const pending = v => v.state === 'queued' || v.state === 'running';
const cardTitle = capability => labels[capability.name] ?? capability.name;
const getCatalog = async ctx => {
  const directory = await ctx.api('/v1/plugins');
  return [...directory.items, directory.models];
};
const getManagersShops = async ctx => ctx.manager ? (await ctx.api('/v1/shops')).items : [];
const taskPath = id => '/v1/tasks/' + path(id);
const taskRoute = id => 'tasks/' + id;
const capLink = capability => capability.endpoint ? 'customer' : 'create/' + capability.pluginId + '/' + capability.id;
const displayStatus = (plugin, capability, ctx) => !plugin.enabled ? '工作区已停用' :
  plugin.id === 'operations' && !ctx.manager ? '需要工作区管理员权限' : capability.available ? '可用' : '服务未配置';

async function library(ctx) {
  const [plugins, settings] = await Promise.all([getCatalog(ctx), ctx.api('/v1/settings')]);
  const favorites = new Set(settings.preferences.favoriteCapabilities ?? []);
  const tile = (plugin, capability, editable) => item(cardTitle(capability),
    displayStatus(plugin, capability, ctx) + ' · ' + capability.cost + ' 积分',
    link('详情', capLink(capability)) + (editable ? action(favorites.has(capability.id) ? '取消收藏' : '收藏', 'favorite', capability.id) : ''));
  const saved = plugins.flatMap(plugin => plugin.capabilities.filter(capability => favorites.has(capability.id)).map(capability => tile(plugin, capability, false)));
  ctx.html(heading('工具库') + panel('我的收藏', saved.length ? '<div class="live-grid">' + saved.join('') + '</div>' : notice('暂无收藏。')) +
    plugins.map(plugin => panel(plugin.name, '<div class="live-grid">' + plugin.capabilities.map(capability => tile(plugin, capability, true)).join('') + '</div>')).join(''));
  let pendingFavorite = false;
  ctx.click('favorite', async id => {
    if (pendingFavorite) return;
    pendingFavorite = true;
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      await ctx.api('/v1/settings', { method:'PATCH', body:{ favoriteCapabilities:[...next] } });
      ctx.reload();
    } finally { pendingFavorite = false; }
  });
}

async function manager(ctx) {
  const plugins = await getCatalog(ctx);
  ctx.html(heading('插件管理', '启停状态由当前工作区保存。') + grid(...plugins.map(plugin => panel(plugin.name,
    item(plugin.enabled ? '已启用' : '已停用', plugin.capabilities.filter(cap => cap.available).length + ' 项已配置能力',
      ctx.manager ? action(plugin.enabled ? '停用' : '启用', 'plugin-state', plugin.id) : '') +
    link('查看能力', 'create/' + plugin.id)))));
  ctx.click('plugin-state', async id => {
    const plugin = plugins.find(plugin => plugin.id === id);
    await ctx.api('/v1/plugins/' + path(id) + '/state', { method: 'PUT', body: { enabled: !plugin.enabled } });
    ctx.reload();
  });
}

function schemaFields(schema, prefix, data) {
  return Object.entries(schema.properties ?? {}).map(([key, node]) => {
    const name = prefix + key;
    if (key === 'platform' && data.capability.pluginId === 'operations') return '';
    const label = labels[key] ?? key;
    const required = schema.required?.includes(key) ?? false;
    let attributes = required ? 'required ' : '';
    if (node.type === 'object') return '<fieldset><legend>' + h(label) + '</legend>' + schemaFields(node, name + '.', data) + '</fieldset>';
    if (node.enum) return field(label, select(name, (required ? [] : [['', '请选择']]).concat(node.enum.map(value => [value, platforms[value] ?? value])), undefined, attributes));
    if (key === 'assetIds') {
      const assets = data.assets.filter(asset => !data.capability.requiresConsent || (asset.consentReference && Date.parse(asset.consentExpiresAt) > Date.now()));
      return field(label + '（支持多选）', select(name, assets.map(asset => [asset.id, asset.name]), undefined, 'multiple ' + attributes)) +
        (!assets.length ? notice('素材库没有符合条件的文件。') : '') + link('打开素材库', 'assets');
    }
    if (key === 'shopId') return field(label, select(name, data.shops.map(shop => [shop.id, shop.name + ' · ' + platforms[shop.platform]]), undefined, attributes));
    if (node.type === 'boolean') return field(label, select(name, [['','使用默认值'],['true','是'],['false','否']]));
    if (node.type === 'integer') return field(label, input(name, attributes + 'type="number" min="' + node.minimum + '" max="' + node.maximum + '"'));
    if (key === 'messages') return field('系统指令（选填）', textarea('conversation.system', 'maxlength="8000"')) +
      field('你的消息', textarea('conversation.user', 'required maxlength="8000"'));
    if (node.type === 'array') {
      const examples = {
        variants:'[{"sku":"A1","priceMinor":9900,"stock":12}]',
        changes:'[{"productId":"填写平台商品号","stock":12}]',
        messages:'[{"role":"user","content":"填写问题"}]',
      };
      return field(label + (node.items.type === 'object' ? '（JSON 列表）' : ''), textarea(name,
        attributes + (examples[key] ? 'placeholder="' + h(examples[key]) + '"' : '')));
    }
    if (node.maxLength) attributes += 'maxlength="' + node.maxLength + '" ';
    return field(label, node.maxLength > 300 ? textarea(name, attributes) : input(name, attributes + (node.format === 'date' ? 'type="date"' : '')));
  }).join('');
}

function parametersFrom(schema, prefix, formData, shops) {
  const params = {};
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const name = prefix + key;
    if (key === 'messages') {
      const system = formData.get('conversation.system')?.trim();
      const user = formData.get('conversation.user');
      params.messages = [...(system ? [{ role:'system', content:system }] : []), { role:'user', content:user }];
      continue;
    }
    const value = formData.get(name);
    if (node.type === 'object') {
      const nested = parametersFrom(node, name + '.', formData, shops);
      if (Object.keys(nested).length) params[key] = nested;
    } else if (key === 'assetIds') {
      const ids = formData.getAll(name);
      if (ids.length) params[key] = ids;
    } else if (value !== null && value !== '') {
      if (node.type === 'integer') params[key] = Number(value);
      else if (node.type === 'boolean') params[key] = value === 'true';
      else if (node.type === 'array' && node.items.type === 'object') {
        try { params[key] = JSON.parse(value); }
        catch { throw new Error((labels[key] ?? key) + '需要填写有效的 JSON 列表。'); }
        if (!Array.isArray(params[key])) throw new Error((labels[key] ?? key) + '需要填写 JSON 列表。');
      } else if (node.type === 'array') params[key] = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      else params[key] = value;
    }
  }
  if (params.shopId) params.platform = shops.find(shop => shop.id === params.shopId)?.platform;
  return params;
}

const drafts = new Map();
function submissionKey(scope, payload) {
  const data = JSON.stringify(payload);
  if (drafts.get(scope)?.data !== data) drafts.set(scope, { data, key: uid() });
  return drafts.get(scope).key;
}

async function create(ctx) {
  const plugins = await getCatalog(ctx);
  const [pluginId, capabilityId] = ctx.args;
  const plugin = plugins.find(candidate => candidate.id === pluginId);
  const capability = plugin?.capabilities.find(candidate => candidate.id === capabilityId);
  if (!plugin) {
    ctx.html(heading('创作台') + grid(...plugins.map(entry => panel(entry.name,
      item(entry.enabled ? '已启用' : '已停用', '', link('查看能力', 'create/' + entry.id))))));
    return;
  }
  if (!capability) {
    ctx.html(heading(plugin.name) + grid(...plugin.capabilities.map(entry => panel(cardTitle(entry),
      item(displayStatus(plugin, entry, ctx), entry.cost + ' 积分', link('详情', capLink(entry)))))));
    return;
  }
  const title = heading(cardTitle(capability), plugin.name + ' · ' + displayStatus(plugin, capability, ctx));
  if (capability.endpoint || !capability.available || !plugin.enabled || (plugin.id === 'operations' && !ctx.manager)) {
    ctx.html(title + (capability.endpoint ? link('打开客服工作台', 'customer') : notice('当前工作区无法提交此能力。')) + link('返回创作台', 'create/' + plugin.id));
    return;
  }

  const [assets, projects, models, wallet, allShops, products] = await Promise.all([
    ctx.all('/v1/assets'), ctx.all('/v1/projects'), ctx.api('/v1/models?capabilityId=' + path(capability.id)),
    ctx.api('/v1/credits/wallet'), plugin.id === 'operations' ? getManagersShops(ctx) : [],
    capability.parameters.properties?.product ? ctx.all('/v1/studio/products') : [],
  ]);
  const shops = allShops.filter(shop => shop.capabilities.includes(capability.id));
  if (plugin.id === 'operations' && !shops.length) {
    ctx.html(title + notice('当前工作区没有已绑定且获准执行此操作的店铺。') + link('查看店铺', 'shops'));
    return;
  }
  let fields = field('执行方式', select('mode', capability.modes.map(mode => [mode, mode === 'chat' ? '对话' : '分步工作流']), 'workflow', 'required'));
  if (models.items.length) fields += field('模型', select('modelId', [['', '服务端自动选择'], ...models.items.map(model => [model.id, model.id + ' · ' + model.model])]));
  if (projects.length) fields += field('关联项目', select('projectId', [['', '未关联'], ...projects.map(project => [project.id, project.name])]));
  if (products.length) fields += field('从商品档案带入信息', select('productRecord',
    [['', '手动填写'], ...products.map(product => [product.id, product.sku + ' · ' + product.name])]));
  fields += schemaFields(capability.parameters, 'params.', { assets, shops, capability });
  if (!capability.requiresConfirmation) fields += field('定时运行时间（留空则立即执行）', input('runAt', 'type="datetime-local"'));
  const description = '本次任务 ' + capability.cost + ' 积分 · 当前可用 ' + wallet.available + ' 积分';
  ctx.html(title + panel(description, form('task', fields, capability.requiresConfirmation ? '生成变更预览' : '提交任务')) +
    '<div id="shop-confirmation"></div>' + link('返回能力列表', 'create/' + plugin.id));

  ctx.on('[name=productRecord]', 'change', node => {
    const product = products.find(entry => entry.id === node.value);
    if (product) document.querySelector('[name="params.product"]').value = [product.name, product.sku, product.description].join('\n').slice(0, 4000);
  });
  const scope = ctx.workspace.id + ':' + ctx.account.id + ':' + capability.id;
  ctx.submit('task', async (data, node) => {
    const parameters = parametersFrom(capability.parameters, 'params.', data, shops);
    const payload = { capabilityId: capability.id, mode: data.get('mode'), parameters };
    if (data.get('modelId')) payload.modelId = data.get('modelId');
    if (data.get('projectId')) payload.projectId = data.get('projectId');
    if (data.get('runAt')) payload.runAt = new Date(data.get('runAt')).toISOString();
    if (capability.requiresConfirmation) {
      const preview = await ctx.api('/v1/shops/previews', { method: 'POST', body: { capabilityId: capability.id, parameters } });
      if (!ctx.active()) return;
      const grant = { ...payload, parameters: preview.parameters, confirmationId: preview.confirmationId };
      node.hidden = true;
      document.querySelector('#shop-confirmation').innerHTML = panel('请核对以下店铺变更',
        notice('有效期至 ' + date(preview.expiresAt)) + result(preview.parameters) +
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

export async function downloadAsset(ctx, id, name) {
  const data = await ctx.api('/v1/assets/' + path(id) + '/content', { raw: true });
  const blob = await data.blob();
  const url = URL.createObjectURL(blob);
  if (!ctx.active()) { URL.revokeObjectURL(url); return; }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function tasks(ctx) {
  const [id] = ctx.args;
  if (!id) {
    const [items, plugins] = await Promise.all([ctx.all('/v1/tasks'), getCatalog(ctx)]);
    const names = new Map(plugins.flatMap(plugin => plugin.capabilities.map(capability => [capability.id, cardTitle(capability)])));
    ctx.html(heading('任务记录') + panel('当前工作区任务', list(items, task => item(names.get(task.capabilityId) ?? task.capabilityId,
      states[task.state] + ' · ' + date(task.createdAt), link('查看任务', taskRoute(task.id))))));
    if (items.some(pending)) watch(ctx, '/v1/tasks?limit=100', status => status.items.map(task => task.id + task.state).join(','),
      items.slice(0, 100).map(task => task.id + task.state).join(','));
    return;
  }
  const [task, plugins] = await Promise.all([ctx.api(taskPath(id)), getCatalog(ctx)]);
  const capability = plugins.flatMap(plugin => plugin.capabilities).find(entry => entry.id === task.capabilityId);
  const output = task.result;
  const externalUrl = httpsUrl(output?.url);
  const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'audio/mpeg': '.mp3' }[output?.mediaType] ?? '';
  let outputPanel = '';
  if (output) {
    if (output.assetId) outputPanel += action('下载结果', 'asset-download', output.assetId) + '<div id="media-result"></div>';
    else if (externalUrl) outputPanel += mediaTag(externalUrl, output.type) + '<a class="smallbtn" href="' + h(externalUrl) +
      '" target="_blank" rel="noopener noreferrer">打开生成结果</a>';
    else if (output.text !== undefined) outputPanel += result(output.text);
    else outputPanel += result(output);
  }
  const controls = (task.state === 'queued' && task.attempts === 0 ? action('取消任务', 'cancel-task') : '') +
    (!pending(task) && capability && !capability.requiresConfirmation && capability.available ? action('重新生成', 'regenerate-task') : '');
  ctx.html(heading(capability ? cardTitle(capability) : task.capabilityId, task.id) +
    panel('执行状态', item(states[task.state], date(task.updatedAt) + ' · ' + task.cost + ' 积分' + (task.errorCode ? ' · ' + task.errorCode : ''), controls)) +
    (outputPanel ? panel('实际结果', outputPanel) : '') + link('返回任务记录', 'tasks'));
  ctx.click('cancel-task', async () => { await ctx.api(taskPath(id) + '/cancel', { method: 'POST' }); ctx.reload(); });
  ctx.click('regenerate-task', async () => {
    const stableKey = submissionKey('retry:' + id, {});
    const child = await ctx.api(taskPath(id) + '/regenerate', { method: 'POST', body: { idempotencyKey: stableKey } });
    drafts.delete('retry:' + id);
    ctx.go(taskRoute(child.id));
  });
  ctx.click('asset-download', asset => downloadAsset(ctx, asset, task.id + extension));
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
  if (pending(task)) watch(ctx, taskPath(id), item => item.state + item.attempts, task.state + task.attempts);
}

function watch(ctx, endpoint, snapshot, original) {
  const check = async () => {
    if (!ctx.active()) return;
    try {
      const data = await ctx.api(endpoint);
      if (snapshot(data) !== original && !document.querySelector('[data-pending]')) { ctx.reload(); return; }
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
  ctx.html(heading('店铺运营') + link('拼多多草稿', 'drafts') + panel('已授权店铺', !ctx.manager ? notice('需要工作区管理员权限。') :
    list(shops, shop => item(shop.name, platforms[shop.platform],
      shop.capabilities.map(id => link(plugin.capabilities.find(cap => cap.id === id)?.name ?? id, 'create/operations/' + id)).join(' ')),
    '当前工作区没有已绑定的店铺。')) + link('查看运营能力', 'create/operations'));
}

export const taskPages = { library, manager, create, tasks, schedules, shops };
