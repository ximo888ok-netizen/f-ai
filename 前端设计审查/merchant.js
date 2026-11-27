import { mountStudioAuth } from './studio-auth.js';
import { studioIcon } from './studio-icons.js';
import { bindNavigationSearch, findNavigation } from './live-nav-search.js';
import { bindStudioAppearance } from './studio-appearance.js';
import { requestStudio, sessionKey, workspaceKey } from './studio-session.js';
import { h, select } from './live-ui.js';
import { membersPage } from './merchant-team.js';
import { projectsPage } from './merchant-projects.js';
import { auditPage, connectionsPage, featuresPage } from './merchant-settings.js';
import { roleNames, sectionTitle } from './merchant-ui.js';

const main = document.querySelector('#merchantContent');
const menu = document.querySelector('.merchant-menu');
const nav = document.querySelector('#nav');
bindNavigationSearch(nav);
const workspaceSelect = document.querySelector('#merchantWorkspace');
const message = document.querySelector('#merchantNotice');
const pages = {
  members: ['成员与邀请', membersPage], projects: ['项目管理', projectsPage], features: ['功能管理', featuresPage],
  connections: ['项目接入', connectionsPage], audit: ['操作记录', auditPage],
};
const errors = {
  UNAUTHENTICATED: '会话已过期，请重新登录。', FORBIDDEN: '当前账号缺少该操作权限。',
  ENTERPRISE_REQUIRED: '请选择有管理权限的企业工作区。', MEMBER_SUSPENDED: '该工作区的成员资格已停用。',
  NOT_FOUND: '当前工作区内找不到该记录。', FEATURE_CHANGED: '功能已被其他管理员更新，刷新后再保存。',
  INVITATION_PENDING: '已有有效邀请，可在邀请记录中重发链接。', INVITATION_USED: '邀请已经被接受。',
  INVITATION_CHANGED: '邀请链接已有更新，请刷新记录。',
  INVITATION_REVOKED: '此邀请已撤回。', ALREADY_MEMBER: '该邮箱已加入本企业。',
  PROJECT_ARCHIVED: '项目已归档，恢复后即可编辑。', CONNECTION_CHANGED: '连接记录有更新，请刷新。',
  CONNECTION_CHECK_REQUIRED: '请先完成一次连接检查。', RATE_LIMITED: '操作过于频繁，请稍后再试。',
};
const canManage = workspace => workspace.kind === 'enterprise' && ['owner', 'admin'].includes(workspace.role);
const freshState = () => ({
  filters: {}, memberOffset: 0, inviteOffset: 0, invitation: null,
  projectOffset: 0, projectFilter: 'all', auditFilters: {}, auditCursor: null,
});
let state = freshState();
let session = sessionStorage.getItem(sessionKey);
let workspaceId = sessionStorage.getItem(workspaceKey);
let activeRender;
let messageTimer;
const connectAppearance = bindStudioAppearance(error => flash(report(error)));

function flash(text) {
  clearTimeout(messageTimer);
  message.textContent = text;
  message.classList.add('show');
  messageTimer = setTimeout(() => { message.classList.remove('show'); message.textContent = ''; }, 4000);
}

async function request(url, { workspace, auth = true, ...rest } = {}) {
  try {
    return await requestStudio(url, { ...rest, token: auth ? session : null, workspaceId: workspace });
  } catch (error) {
    if (auth) error.message = errors[error.code] ?? error.message;
    throw error;
  }
}

function report(error) {
  return error.message + (error.requestId ? '（请求 ' + error.requestId + '）' : '');
}

function remember(next) {
  connectAppearance(null);
  session = next;
  if (session) sessionStorage.setItem(sessionKey, session);
  else {
    sessionStorage.removeItem(sessionKey);
    state = freshState();
  }
}

function makeContext(controller, workspace, args) {
  const { signal } = controller;
  const active = () => !signal.aborted;
  const api = (url, options) => request(url, { signal, workspace: workspace?.id, ...options });
  const reload = () => { if (active()) void render(); };
  const go = route => {
    if (!active()) return;
    if (location.hash === '#' + route) reload();
    else location.hash = route;
  };
  function on(selector, event, handler) {
    for (const element of main.querySelectorAll(selector)) element.addEventListener(event, async current => {
      current.preventDefault();
      if (element.dataset.pending || !active()) return;
      element.dataset.pending = 'true';
      element.setAttribute('aria-busy', 'true');
      const controls = element.matches('button') ? [element] : [...element.querySelectorAll('button:not(:disabled)')];
      controls.forEach(control => { control.disabled = true; });
      try {
        await handler(element);
      } catch (error) {
        if (active() && error.name !== 'AbortError') {
          if (error.status === 401 && workspace) { remember(null); reload(); }
          flash(report(error));
        }
      } finally {
        delete element.dataset.pending;
        element.removeAttribute('aria-busy');
        controls.forEach(control => { control.disabled = false; });
      }
    });
  }
  return {
    active, api, signal, workspace, args, state, reload, go, notify: flash,
    async all(endpoint) {
      const items = [];
      const divider = endpoint.includes('?') ? '&' : '?';
      for (let offset = 0; ; offset += 100) {
        const result = await api(endpoint + divider + 'limit=100&offset=' + offset);
        items.push(...result.items);
        if (result.items.length < 100) return items;
      }
    },
    html(content) {
      if (!active()) return;
      main.innerHTML = content;
      if (typeof StudioGlass !== 'undefined') StudioGlass.schedule();
    },
    form(name, callback) { on('[data-form="' + name + '"]', 'submit', element => callback(new FormData(element))); },
    click(name, callback) { on('[data-' + name + ']', 'click', element => callback(element.getAttribute('data-' + name), element)); },
    complete(text) { if (active()) { flash(text); reload(); } },
  };
}

function login(ctx) {
  menu.hidden = true;
  mountStudioAuth(ctx, main, true, session => {
    remember(session.token);
    ctx.reload();
  });
}

function updateMenu(workspaces, workspace, page) {
  const temporary = document.createElement('div');
  temporary.innerHTML = select('workspace', workspaces.map(item => [item.id, item.name]), workspace.id);
  workspaceSelect.replaceChildren(...temporary.firstElementChild.children);
  workspaceSelect.value = workspace.id;
  document.querySelector('#merchantRole').textContent = roleNames[workspace.role];
  nav.innerHTML = Object.entries(pages).map(([id, [label]]) =>
    '<a class="navitem' + (id === page ? ' active' : '') + '" href="#' + id + '"' +
    (id === page ? ' aria-current="page"' : '') + '>' + studioIcon(({ projects: 'data', audit: 'tasks' })[id] ?? id) + '<span>' + h(label) + '</span></a>').join('') + findNavigation;
  menu.hidden = false;
}

async function render() {
  activeRender?.abort();
  const controller = new AbortController();
  activeRender = controller;
  const [route, ...args] = location.hash.slice(1).split('/');
  const page = Object.hasOwn(pages, route) ? route : 'members';
  const anonymous = makeContext(controller, null, args);
  if (!session) return login(anonymous);
  main.innerHTML = '<p role="status">正在读取后台数据…</p>';
  try {
    const { workspaces, account } = await anonymous.api('/v1/auth/me');
    if (!anonymous.active()) return;
    const eligible = workspaces.filter(canManage);
    const workspace = eligible.find(item => item.id === workspaceId) ?? eligible[0];
    if (!workspace) {
      connectAppearance(null);
      menu.hidden = true;
      anonymous.html(sectionTitle('当前账号没有管理权限', '请用企业所有者或管理员账号打开后台。') +
        '<a class="plain" href="/">返回普通工作台</a> <button class="smallbtn" data-sign-out>切换账号</button>');
      anonymous.click('sign-out', logout);
      return;
    }
    const ctx = makeContext(controller, workspace, args);
    await ctx.api('/v1/merchant/context');
    if (!ctx.active()) return;
    connectAppearance(session, workspace.id, account.id);
    updateMenu(eligible, workspace, page);
    await pages[page][1](ctx);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.status === 401) { remember(null); login(anonymous); return; }
    if (error.status === 403 || error.status === 404) menu.hidden = true;
    anonymous.html(sectionTitle('后台读取失败', report(error)) + '<button class="smallbtn" data-retry>重新读取</button>');
    anonymous.click('retry', () => anonymous.reload());
  }
}

async function logout() {
  try {
    if (session) await request('/v1/auth/logout', { method: 'POST' });
    remember(null);
    void render();
  } catch (error) {
    if (error.status === 401) { remember(null); void render(); }
    else flash(report(error));
  }
}

workspaceSelect.addEventListener('change', () => {
  connectAppearance(null);
  workspaceId = workspaceSelect.value;
  sessionStorage.setItem(workspaceKey, workspaceId);
  state = freshState();
  if (location.hash === '#members') void render();
  else location.hash = 'members';
});
document.querySelector('#merchantLogout').addEventListener('click', logout);
window.addEventListener('hashchange', () => { if (location.hash !== '#merchantContent') void render(); });
void render();
