
import { workspacePages } from './live-workspace.js';
import { taskPages } from './live-tasks.js';
import { customerPage } from './live-customer.js';
import { operationsPage } from './live-operations.js';
import { listingDrafts } from './live-drafts.js';
import { productPages } from './live-products.js';
import { psdPage } from './live-psd.js';
import { cloudAssetsPage, feishuPage } from './live-connectors.js';
import { skillsPage } from './live-skills.js';
import { copyReviewPage } from './live-copy-review.js';
import { rightsPage } from './live-rights.js';
import { mediaPage } from './live-media.js';

const main = document.querySelector('#main');
const tokenKey = 'fai.live.session';
const workspaceKey = 'fai.live.workspace';
const roleNames = { owner: '所有者', admin: '管理员', member: '成员' };
const pages = {
  desk: ['生产工作台', dashboard],
  create: ['创作台', taskPages.create],
  library: ['工具库', taskPages.library],
  skills: ['技能运行', skillsPage],
  'copy-review': ['平台文案校验', copyReviewPage],
  models: ['模型对话', taskPages.conversation],
  media: ['图片与视频处理', mediaPage],
  rights: ['权利通知', rightsPage],
  assets: ['素材库', workspacePages.assets],
  psd: ['分层设计', psdPage],
  'cloud-assets': ['网盘备份', cloudAssetsPage],
  feishu: ['飞书消息', feishuPage],
  tasks: ['任务记录', taskPages.tasks],
  commerce: ['拼多多运营', operationsPage],
  drafts: ['拼多多草稿', listingDrafts],
  products: ['商品档案', productPages.products],
  roi: ['投放收益测算', productPages.roi],
  schedules: ['定时任务', taskPages.schedules],
  projects: ['项目管理', workspacePages.projects],
  team: ['企业成员', workspacePages.team],
  resources: ['知识库与记忆', workspacePages.resources],
  customer: ['客服工作台', customerPage],
  shops: ['店铺运营', taskPages.shops],
  manager: ['插件管理', taskPages.manager],
  inbox: ['消息中心', workspacePages.inbox],
  account: ['账户与积分', workspacePages.account],
  settings: ['设置与诊断', workspacePages.settings],
};
const groups = [['desk', 'create', 'models', 'library', 'skills', 'assets', 'media', 'psd', 'tasks', 'schedules'],
  ['products', 'projects', 'team', 'resources', 'customer', 'shops', 'roi'], ['manager', 'inbox', 'rights', 'account', 'settings']];
const workspaceAliases = { home: 'desk', welcome: 'desk', assistant: 'schedules', image: 'create/image', video: 'create/video',
  copy: 'create/copywriting', service: 'customer', ops: 'shops',
  'desk-mainimg': 'create/image/image.main-image', 'desk-skuimg': 'media/images',
  'desk-detailimg': 'media/images', 'desk-retouch': 'media/images',
  'desk-quickfilm': 'create/video/video.from-image', 'desk-direct': 'media/storyboards',
  'desk-promptfilm': 'create/video/video.compose', 'desk-structure': 'create/video/video.reference',
  'desk-replace': 'create/video/video.replace-product', 'desk-speech': 'create/models/model.speech',
  'desk-roi': 'roi', 'desk-cloud': 'shops', 'desk-publish': 'create/operations/operations.publish',
  'desk-products': 'products', 'desk-categories': 'products/categories', 'desk-imports': 'products/transfers',
  'desk-exports': 'products/transfers', 'desk-saved': 'library', 'desk-history': 'tasks' };
let token = sessionStorage.getItem(tokenKey);
let identity = null;
let workspace = null;
let currentRender;
let preferences = {};
let authMode = 'login';

export function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
export const field = (title, control) => '<label>' + h(title) + control + '</label>';
export const input = (name, attrs = '') => '<input name="' + h(name) + '" ' + attrs + '>';
export const textarea = (name, attrs = '', value = '') => '<textarea name="' + h(name) + '" ' + attrs + '>' + h(value) + '</textarea>';
export const button = (title, attrs = '') => '<button class="primary" ' + attrs + '>' + h(title) + '</button>';
export const action = (title, name, value = '') => '<button class="plain" type="button" data-' + name + '="' + h(value) + '">' + h(title) + '</button>';
export const link = (title, route) => '<a class="smallbtn" href="#' + h(route) + '">' + h(title) + '</a>';
export const notice = text => '<p class="live-muted">' + h(text) + '</p>';
export const heading = (title, description = '') => '<div class="live-title"><h1>' + h(title) + '</h1>' + (description ? notice(description) : '') + '</div>';
export const panel = (title, body) => '<section class="card live-panel"><h2>' + h(title) + '</h2>' + body + '</section>';
export const grid = (...sections) => '<div class="live-grid">' + sections.join('') + '</div>';
export const form = (name, fields, title = '保存') => '<form class="live-form" data-form="' + h(name) + '">' + fields + button(title) + '</form>';
export const item = (title, description, controls = '') => '<article class="live-item"><strong>' + h(title) + '</strong>' + (description ? notice(description) : '') + controls + '</article>';
export const list = (items, render, fallback = '暂无记录。') => items.length ? items.map(render).join('') : notice(fallback);
export const result = value => '<pre class="live-result">' + h(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '</pre>';
export const date = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
export const path = value => encodeURIComponent(value);
export const uid = () => crypto.randomUUID();
export function retryKey() {
  let previous;
  let id;
  return value => {
    const next=JSON.stringify(value);
    if (next!==previous) {id=uid();previous=next;}
    return id;
  };
}
export function select(name, options, selected, attrs = '') {
  return '<select name="' + h(name) + '" ' + attrs + '>' + options.map(([key, label]) => '<option value="' + h(key) + '"' +
    ((Array.isArray(selected) ? selected.includes(key) : key === selected) ? ' selected' : '') + '>' + h(label) + '</option>').join('') + '</select>';
}
export function toast(message) {
  const control = document.querySelector('#live');
  control.textContent = message;
  control.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => control.classList.remove('show'), 3600);
}

const errorLabels = {
  UNAUTHENTICATED: '登录信息无效或会话已过期', FORBIDDEN: '当前账号没有这项权限',
  NOT_FOUND: '记录不存在或当前工作区无法访问', PROVIDER_NOT_CONFIGURED: '服务端尚未配置该能力',
  CAPABILITY_UNAVAILABLE: '当前没有可执行此能力的服务', PLUGIN_DISABLED: '当前工作区已停用该插件',
  MODEL_NOT_SUPPORTED: '所选模型不支持此能力', CONSENT_REQUIRED: '素材需要有效的授权记录',
  MODEL_STREAM_UNAVAILABLE: '所选模型未启用流式回复', TASK_STREAM_BUSY: '实时回复连接繁忙，请稍候',
  MODEL_RESPONSE_INCOMPLETE: '模型回复中断，未能完成任务', MODEL_CONTENT_BLOCKED: '模型未能返回这条回复',
  VOICE_MODEL_UNAVAILABLE: '请选择已配置的转写、对话和语音合成模型',
  VOICE_TURN_TIMEOUT: '语音任务超时，请用更短的录音重试',
  INSUFFICIENT_CREDITS: '可用积分不足', RATE_LIMITED: '请求过于频繁，请稍后再试',
  DRAFT_CHANGED: '草稿已被更新，请先复制需要保留的修改，然后重新打开草稿',
  ASSET_IN_DRAFT: '这张图片正被商品草稿使用，请先在草稿中替换或移除',
  EMAIL_IN_USE: '该邮箱已注册', DATABASE_UNAVAILABLE: '服务端数据库暂未就绪',
};
Object.assign(errorLabels, {
  AI_VIDEO_REQUIRED:'请选择已归档的 AI 视频任务结果。',
  VIDEO_EXPORT_INVALID:'请使用可读取的 MP4。时长最多 60 秒，每边最多 1920 像素，总像素不超过 1080p，帧率最多 60。',
  VIDEO_EXPORT_MP4_REQUIRED:'请选择 MP4 视频。',
  VIDEO_EXPORT_UNAVAILABLE:'当前部署的视频导出工具不可用。',
  VIDEO_EXPORT_BUSY:'有视频正在导出，请稍后重试。',
  VIDEO_EXPORT_TIMEOUT:'视频处理超时，请缩短素材后重试。',
  VIDEO_NO_AUDIO:'这段视频没有可导出的音轨。',
  VIDEO_FRAME_OUT_OF_RANGE:'抽帧时间超出视频时长。',
  STORYBOARD_CHANGED:'分镜版本已变化，请重新打开后保存或导出。',
  STORYBOARD_ASSET_LIMIT:'分镜使用的素材合计超过 24 MiB。',
  IMAGE_BATCH_LIMIT:'此批次的素材合计超过 24 MiB。',
  IMAGE_RENDER_BUSY:'图片服务正在处理其他请求，请稍后重试。',
  IMAGE_RENDER_TIMEOUT:'图片处理超时，请减少素材或缩小尺寸后重试。',
  IMAGE_RENDER_FAILED:'图片处理服务未完成本次处理。',
  LIBRARY_CONFLICT:'技能有更新或仍被其他条目引用，请检查当前记录。',
  LIBRARY_DISABLED:'这个技能已停用。',
  COPY_RULES_CHANGED:'规则版本已变化，请重新打开当前平台的规则。',
  RIGHTS_NOTICE_CONFLICT:'案件已更新或当前阶段不能执行该操作，请重新打开案件。',
});

export function describeError(error) {
  return (errorLabels[error.code] || error.message || '操作失败') + (error.requestId ? '（请求 ' + error.requestId + '）' : '');
}

async function request(url, options = {}) {
  const { method = 'GET', body, auth = true, tenant = true, raw = false, signal, workspaceId = workspace?.id } = options;
  const headers = {};
  if (auth && token) headers.authorization = 'Bearer ' + token;
  if (auth && tenant && workspaceId) headers['x-workspace-id'] = workspaceId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('无法连接后端，请检查服务后重试。');
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))).error ?? {};
    if (response.status === 401 && auth && headers.authorization === 'Bearer ' + token) {
      setIdentity(null);
      void render();
    }
    throw Object.assign(new Error(failure.message ?? 'HTTP ' + response.status), failure, { status: response.status });
  }
  if (raw) return response;
  return response.status === 204 ? null : response.json();
}

async function getAll(ctx, endpoint) {
  const items = [];
  const delimiter = endpoint.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += 100) {
    const page = (await ctx.api(endpoint + delimiter + 'limit=100&offset=' + offset)).items;
    items.push(...page);
    if (page.length < 100) return items;
  }
}

function setIdentity(data, selected = workspace?.id ?? sessionStorage.getItem(workspaceKey)) {
  const previousWorkspace = workspace?.id;
  token = data ? data.token ?? token : null;
  identity = data;
  workspace = data?.workspaces.find(entry => entry.id === selected) ?? data?.workspaces[0] ?? null;
  if (workspace?.id !== previousWorkspace) preferences = {};
  if (token) sessionStorage.setItem(tokenKey, token);
  else sessionStorage.removeItem(tokenKey);
  if (workspace) sessionStorage.setItem(workspaceKey, workspace.id);
  else sessionStorage.removeItem(workspaceKey);
}

function updateHeader(route, title) {
  document.querySelector('#nav').innerHTML = identity ? groups.map(group => '<div class="live-navgroup">' +
    group.map(id => '<a class="navitem ' + (id === route ? 'active' : '') + '" href="#' + id + '"' +
      (id === route ? ' aria-current="page"' : '') + '><span>' + h(pages[id][0]) + '</span></a>').join('') + '</div>').join('') : '';
  document.querySelector('#profile').textContent = identity ? identity.account.displayName + ' · ' + roleNames[workspace?.role] : '';
  document.querySelector('#queueLink').hidden = !identity;
  document.querySelector('#crumb').innerHTML = workspace ? field('工作区', select('workspace',
    identity.workspaces.map(entry => [entry.id, entry.name]), workspace.id, 'id="workspace-selector"')) : h(title);
  document.querySelector('#workspace-selector')?.addEventListener('change', async event => {
    setIdentity(identity, event.target.value);
    if (route !== 'desk' || location.hash !== '#desk') location.hash = 'desk';
    else void render();
    void syncPreferences(workspace.id);
  });
}

function viewContext(controller, routeArgs) {
  const selected = workspace;
  const session = identity;
  const active = () => !controller.signal.aborted;
  const ctx = {
    args: routeArgs, workspace: selected, account: session?.account, active, signal: controller.signal,
    manager: selected?.role === 'owner' || selected?.role === 'admin',
    enterprise: selected?.kind === 'enterprise',
    api: (url, options) => request(url, { signal: controller.signal, workspaceId: selected?.id, ...options }),
    all: url => getAll(ctx, url),
    html: body => {
      if (!active()) return;
      main.innerHTML = '<div class="live-main">' + body + '</div>';
      if (typeof StudioGlass !== 'undefined') StudioGlass.schedule();
    },
    go: to => {
      if (!active()) return;
      if (location.hash === '#' + to) void render();
      else location.hash = to;
    },
    reload: () => { if (active()) void render(); },
    acceptInvitation: data => {
      if (!active()) return;
      setIdentity({ ...session, workspaces: data.workspaces }, data.workspaceId);
      ctx.go('desk');
      void syncPreferences(workspace.id);
    },
    logout: async () => {
      await ctx.api('/v1/auth/logout', { method: 'POST', tenant: false });
      if (active()) { setIdentity(null); ctx.go('desk'); }
    },
    on: (selector, event, handler) => main.querySelectorAll(selector).forEach(node => node.addEventListener(event, async evt => {
      evt.preventDefault();
      if (node.dataset.pending || !active()) return;
      node.dataset.pending = 'true';
      const disabled = [...(node.matches('form') ? node.querySelectorAll('button[type=submit],button:not([type])') : node.matches('button') ? [node] : [])].filter(control => !control.disabled);
      disabled.forEach(control => { control.disabled = true; });
      try { await handler(node, evt); }
      catch (error) { if (active() && error.name !== 'AbortError') toast(describeError(error)); }
      finally {
        delete node.dataset.pending;
        disabled.forEach(control => { control.disabled = false; });
      }
    })),
  };
  ctx.submit = (name, fn) => ctx.on('[data-form="' + name + '"]', 'submit', (node, event) => fn(new FormData(node), node, event));
  ctx.click = (name, fn) => ctx.on('[data-' + name + ']', 'click', node => fn(node.getAttribute('data-' + name), node));
  return ctx;
}

function authPage(ctx) {
  const signUp = authMode === 'register';
  ctx.html(heading('电商生产工作台') + '<div class="live-auth">' + panel(signUp ? '注册账号' : '登录',
    form('auth', field('邮箱', input('email', 'type="email" required autocomplete="username" maxlength="254"')) +
      field('密码', input('password', 'type="password" required minlength="10" maxlength="128" autocomplete="' + (signUp ? 'new-password' : 'current-password') + '"')) +
      (signUp ? field('显示名', input('displayName', 'required maxlength="100"')) +
        field('账号类型', select('type', [['personal','个人'], ['enterprise','企业']], 'personal')) +
        '<div id="enterprise-name" hidden>' + field('企业工作区名称', input('workspaceName', 'maxlength="100"')) + '</div>' : ''),
    signUp ? '注册并登录' : '登录') + action(signUp ? '已有账号' : '创建账号', 'auth-mode')) + '</div>');
  ctx.click('auth-mode', () => { authMode = signUp ? 'login' : 'register'; ctx.reload(); });
  ctx.on('[name=type]', 'change', node => {
    const container = document.querySelector('#enterprise-name');
    container.hidden = node.value !== 'enterprise';
    container.querySelector('input').required = !container.hidden;
  });
  ctx.submit('auth', async data => {
    const body = Object.fromEntries(data);
    if (body.type !== 'enterprise') delete body.workspaceName;
    const session = await ctx.api('/v1/auth/' + authMode, { method: 'POST', auth: false, body });
    if (!ctx.active()) return;
    setIdentity(session);
    ctx.reload();
    void syncPreferences(workspace.id);
  });
}

async function dashboard(ctx) {
  const [wallet, data, tasks, messages] = await Promise.all([
    ctx.api('/v1/credits/wallet'), ctx.api('/v1/plugins'), ctx.api('/v1/tasks?limit=5'), ctx.api('/v1/notifications?limit=1'),
  ]);
  ctx.html(heading('商品上新工作台', ctx.workspace.name + ' · ' + roleNames[ctx.workspace.role]) +
    grid(panel('账户余额', item(wallet.available + ' 可用积分', wallet.reserved + ' 积分预占', link('查看账本', 'account'))),
      panel('消息', item(messages.unread + ' 条未读', '', link('消息中心', 'inbox')))) +
    panel('创作与经营', '<div class="live-grid">' + data.items.map(plugin => item(plugin.name,
      plugin.enabled ? plugin.capabilities.filter(capability => capability.available).length + ' 项服务可用' : '工作区已停用',
      link('查看', { 'customer-service': 'customer', operations: 'shops' }[plugin.id] ?? 'create/' + plugin.id))).join('') + '</div>') +
    panel('最近任务', list(tasks.items, task => item(task.capabilityId, date(task.createdAt), link('查看任务', 'tasks/' + task.id)))));
}

async function syncPreferences(id) {
  try {
    const response = await request('/v1/settings', { workspaceId: id });
    if (workspace?.id !== id) return;
    preferences = response.preferences;
    window.applyStudioTheme?.(preferences.studioTheme ?? 'glass');
    window.applyStudioMotion?.(preferences.studioMotion);
  } catch (error) {
    if (workspace?.id === id) toast(describeError(error));
  }
}

let appearancePending = Promise.resolve();
function persistAppearance(key, choice, restore) {
  const id = workspace?.id;
  if (!id) return;
  const currentToken = token;
  appearancePending = appearancePending.then(async () => {
    if (token !== currentToken) return;
    try {
      const updated = await request('/v1/settings', { method: 'PATCH', workspaceId: id, body: { [key]: choice } });
      if (workspace?.id === id) preferences = updated.preferences;
    } catch (error) {
      if (workspace?.id === id) {
        restore(preferences[key]);
        toast(describeError(error));
      }
    }
  });
}
document.addEventListener('studio-theme', event => persistAppearance('studioTheme', event.detail, value => window.applyStudioTheme?.(value ?? 'glass')));
document.addEventListener('studio-motion', event => persistAppearance('studioMotion', event.detail, value => window.applyStudioMotion?.(value)));

async function render() {
  currentRender?.abort();
  const controller = new AbortController();
  currentRender = controller;
  const fragment = location.hash.slice(1);
  const [requested, ...args] = (Object.hasOwn(workspaceAliases, fragment) ? workspaceAliases[fragment] : fragment).split('/');
  const route = Object.hasOwn(pages, requested) ? requested : 'desk';
  const [label, page] = pages[route];
  const ctx = viewContext(controller, args);
  updateHeader(route, label);
  if (!identity || !workspace) { authPage(ctx); return; }
  ctx.html(heading(label) + notice('正在读取工作区…'));
  try { await page(ctx); }
  catch (error) {
    if (error.name === 'AbortError' || !ctx.active()) return;
    ctx.html(heading(label) + '<p class="live-error" role="alert">' + h(describeError(error)) + '</p>' + action('重试', 'retry'));
    ctx.click('retry', ctx.reload);
  }
}

window.addEventListener('hashchange', () => { if (location.hash !== '#main') void render(); });
async function start() {
  const connection = document.querySelector('#connection');
  try {
    await request('/ready', { auth: false });
    connection.textContent = '服务已连接';
    if (token) {
      setIdentity(await request('/v1/auth/me', { tenant: false }));
      if (workspace) void syncPreferences(workspace.id);
    }
  } catch (error) {
    connection.textContent = error.code === 'UNAUTHENTICATED' ? '服务已连接' : '连接异常';
    if (error.code !== 'UNAUTHENTICATED') toast(describeError(error));
  }
  await render();
}
void start();
