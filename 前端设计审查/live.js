import { bindRecordSearch } from './live-record-tools.js';
import { bindStudioAppearance } from './studio-appearance.js';
import { dashboard } from './live-home.js';
import { agentHome } from './live-agent-home.js';
import { workspaceNavigation } from './live-navigation.js';
import { bindAccountMenu } from './live-account-menu.js';
import { capabilityCenter } from './live-capability-center.js';
import { dataCenter } from './live-data-center.js';
import { requestStudio, sessionKey as tokenKey, workspaceKey } from './studio-session.js';
import { describeError } from './studio-errors.js';
export { describeError } from './studio-errors.js';
import { action, field, form, h, heading, input, notice, panel, select } from './live-ui.js';
export * from './live-ui.js';

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
bindRecordSearch(main);
const roleNames = { owner: '所有者', admin: '管理员', member: '成员' };
const pages = {
  home: ['首页', agentHome],
  capabilities: ['能力中心', capabilityCenter],
  data: ['资料库', dataCenter],
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
  projects: ['我的项目', workspacePages.projects],
  team: ['企业邀请', workspacePages.team],
  resources: ['知识库与记忆', workspacePages.resources],
  customer: ['客服工作台', customerPage],
  shops: ['店铺运营', taskPages.shops],
  manager: ['插件能力', taskPages.manager],
  inbox: ['消息中心', workspacePages.inbox],
  account: ['账户与积分', workspacePages.account],
  settings: ['设置与诊断', workspacePages.settings],
};
const updateNavigation = workspaceNavigation(pages);
const updateAccount = bindAccountMenu(error => toast(describeError(error)));
const workspaceAliases = { welcome: 'home', assistant: 'schedules', image: 'create/image', video: 'create/video',
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
const connectAppearance = bindStudioAppearance(error => toast(describeError(error)));
let authMode = 'login';

export function toast(message) {
  const control = document.querySelector('#live');
  control.textContent = message;
  control.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => control.classList.remove('show'), 3600);
}

async function request(url, options = {}) {
  const { auth = true, tenant = true, workspaceId = workspace?.id, ...rest } = options;
  const sentToken = auth ? token : null;
  try {
    return await requestStudio(url, { ...rest, token: sentToken, workspaceId: auth && tenant ? workspaceId : undefined });
  } catch (error) {
    if (error.status === 401 && sentToken && sentToken === token) {
      setIdentity(null);
      void render();
    }
    throw error;
  }
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
  token = data ? data.token ?? token : null;
  identity = data;
  workspace = data?.workspaces.find(entry => entry.id === selected) ?? data?.workspaces[0] ?? null;
  connectAppearance(token, workspace?.id, identity?.account.id);
  if (token) sessionStorage.setItem(tokenKey, token);
  else sessionStorage.removeItem(tokenKey);
  if (workspace) sessionStorage.setItem(workspaceKey, workspace.id);
  else sessionStorage.removeItem(workspaceKey);
}

function updateHeader(route, title, ctx) {
  updateNavigation(route, Boolean(identity));
  updateAccount(ctx, roleNames[workspace?.role]);
  document.querySelector('#queueLink').hidden = !identity;
  const merchantLink = document.querySelector('#merchantLink');
  merchantLink.hidden = workspace?.kind !== 'enterprise' || !['owner', 'admin'].includes(workspace.role);
  document.querySelector('#crumb').innerHTML = workspace ? field('工作区', select('workspace',
    identity.workspaces.map(entry => [entry.id, entry.name]), workspace.id, 'id="workspace-selector"')) : h(title);
  document.querySelector('#workspace-selector')?.addEventListener('change', async event => {
    setIdentity(identity, event.target.value);
    if (route !== 'home' || location.hash !== '#home') location.hash = 'home';
    else void render();
  });
}

function viewContext(controller, routeArgs) {
  const selected = workspace;
  const session = identity;
  const active = () => !controller.signal.aborted;
  const ctx = {
    args: routeArgs, workspace: selected, account: session?.account, active, signal: controller.signal,
    navigation: Object.fromEntries(Object.entries(pages).map(([id,[label]])=>[label,id])),
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
      ctx.go('home');
    },
    logout: async () => {
      await ctx.api('/v1/auth/logout', { method: 'POST', tenant: false });
      if (active()) { setIdentity(null); ctx.go('home'); }
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
  });
}

async function render() {
  currentRender?.abort();
  const controller = new AbortController();
  currentRender = controller;
  const fragment = location.hash.slice(1);
  const [requested, ...args] = (Object.hasOwn(workspaceAliases, fragment) ? workspaceAliases[fragment] : fragment).split('/');
  const route = Object.hasOwn(pages, requested) ? requested : 'home';
  const [label, page] = pages[route];
  const ctx = viewContext(controller, args);
  updateHeader(route, label, ctx);
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
    }
  } catch (error) {
    connection.textContent = error.code === 'UNAUTHENTICATED' ? '服务已连接' : '连接异常';
    if (error.code !== 'UNAUTHENTICATED') toast(describeError(error));
  }
  await render();
}
void start();
