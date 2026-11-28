import { h, retryKey } from './live-ui.js';
import {
  tabs,
  canOpenAdmin,
  adminData,
  adminAction,
  adminStorageKey,
  connection,
  saveConnection,
  usesMemory,
  contracts,
  workspaceContracts
} from './admin-data.js';
import { openAdminDialog } from './admin-forms.js';
import {
  control,
  connectionNames,
  tabLink,
  shell,
  overviewView,
  usersView,
  userRows,
  creditsView,
  subscriptionsView,
  modelsView,
  modelRows,
  serverView
} from './admin-views.js';

export { canOpenAdmin, forgetAdminCredentials } from './admin-data.js';
const pages = {
  overview: overviewView,
  users: usersView,
  credits: creditsView,
  subscriptions: subscriptionsView,
  models: modelsView
};
const localDescription = '本地演示数据仅保存在当前浏览器，按账号和工作区隔离。';

export function adminEntry(ctx) {
  if (!canOpenAdmin(ctx.workspace)) return '';
  const mode = connection(ctx).mode;
  return (
    '<section class="admin-entry-card"><div class="admin-entry-info"><span class="admin-entry-kicker">' +
    h(connectionNames[mode]) +
    '</span><h2 class="admin-entry-title">管理员控制台</h2>' +
    '<p class="admin-entry-desc" data-admin-summary aria-live="polite">正在读取管理摘要…</p><nav class="admin-entry-shortcuts" aria-label="管理快捷入口">' +
    Object.keys(tabs)
      .filter((k) => k !== 'overview')
      .map((k) => tabLink(k))
      .join('') +
    '</nav></div><div class="admin-entry-actions">' +
    '<a class="adm-btn primary" href="#admin">进入管理员控制台 →</a></div></section>'
  );
}
export async function updateAdminEntry(ctx) {
  if (!canOpenAdmin(ctx.workspace)) return;
  const node = document.querySelector('[data-admin-summary]');
  if (!node) return;
  try {
    const { totals } = await adminData(ctx, 'overview');
    if (ctx.active())
      node.textContent =
        (connection(ctx).mode === 'demo' ? '本地演示就绪' : '后台已连接') +
        ' · ' +
        totals.users +
        ' 位用户 · ' +
        totals.models +
        ' 个启用模型';
  } catch (e) {
    if (ctx.active()) node.textContent = e.message;
  }
}

function exportConfig(ctx) {
  const conf = connection(ctx);
  const contents = JSON.stringify({ ...conf, endpoints: conf.mode === 'workspace' ? workspaceContracts : contracts }, null, 2);
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'fai-admin-config.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function adminPage(ctx) {
  if (!canOpenAdmin(ctx.workspace)) {
    ctx.html(
      '<h1>管理员控制台</h1><p role="alert">此入口仅供企业工作区所有者和管理员使用。</p><a href="#settings">返回设置与诊断</a>'
    );
    return;
  }
  const tab = ctx.args[0] || 'overview';
  if (!Object.hasOwn(tabs, tab) || ctx.args.length > 1) {
    ctx.go('admin/overview');
    return;
  }
  const filters = { search: '', role: '', status: '', kind: '' };
  let data,
    invitation,
    revision = 0,
    refreshAfterDialog = false;
  const root = () => document.querySelector('.admin-shell');
  const status = (message) => {
    const node = root()?.querySelector('[data-admin-status]');
    if (node) node.textContent = message;
  };
  async function draw(message = '') {
    const ticket = ++revision;
    let body;
    try {
      const loaded = tab === 'server' ? {} : await adminData(ctx, tab);
      if (!ctx.active() || ticket !== revision) return;
      data = loaded;
      body = tab === 'server' ? serverView(ctx) : pages[tab](data, filters, invitation);
    } catch (e) {
      if (!ctx.active() || ticket !== revision) return;
      body =
        '<p role="alert" class="live-error">' +
        h(e.message) +
        '</p><div class="adm-toolbar">' +
        control('refresh', '重试') +
        tabLink('server', '检查服务器配置') +
        '</div>';
    }
    const note = usesMemory(ctx)
      ? '浏览器存储不可用，本次更改只保留到页面关闭。'
      : connection(ctx).mode === 'demo'
        ? localDescription
        : '';
    ctx.html(shell(ctx, tab, body, [message, note].filter(Boolean).join(' ')));
    const area = root();
    area.addEventListener('input', (e) => {
      const key = e.target.dataset.filter;
      if (!key) return;
      filters[key] = e.target.value;
      area.querySelector('[data-filter-results]').innerHTML =
        tab === 'users' ? userRows(data, filters) : modelRows(data, filters);
    });
    area.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-admin-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.adminAction,
        id = button.dataset.id;
      const operationId = retryKey();
      const perform = async (values) => {
        let message;
        if (action === 'config') {
          await saveConnection(ctx, values);
          message = '连接配置已保存';
        } else {
          const result = await adminAction(ctx, action, values, operationId(values));
          if (result?.invitation) invitation = result.invitation;
          message = result?.message ?? result;
        }
        if (ctx.active()) {
          if (data.native && action === 'adjust') {
            const balance = await ctx.api('/v1/credits/wallet').catch(() => null);
            const badge = document.querySelector('#topCreditText');
            if (ctx.active() && badge && balance) badge.textContent = balance.available.toLocaleString('zh-CN');
          }
          await draw(message);
        }
      };
      try {
        if (action === 'refresh') {
          await draw();
          return;
        }
        if (action === 'export') {
          exportConfig(ctx);
          status('已导出配置，已省略凭据。');
          return;
        }
        if (action === 'copy-invite') {
          const link = area.querySelector('[data-invite-link]');
          try {
            await navigator.clipboard.writeText(link.value);
            status('已复制邀请链接。');
          } catch {
            link.select();
            status('请选择并复制邀请链接。');
          }
          return;
        }
        if (['user-status', 'tier-status', 'model-status', 'model-test', 'health'].includes(action)) {
          button.disabled = true;
          try {
            const values = id ? { id } : {};
            if (button.hasAttribute('aria-checked'))
              values.enabled = button.getAttribute('aria-checked') !== 'true';
            if (action === 'model-status' && data.native) values.revision = data.models.find(model => model.id === id).revision;
            await perform(values);
          } finally {
            button.disabled = false;
          }
          return;
        }
        openAdminDialog(ctx, action, id, data, perform);
        const dlg = document.querySelector('.admin-dialog[open]');
        dlg.addEventListener(
          'close',
          () => {
            if (refreshAfterDialog && ctx.active()) {
              refreshAfterDialog = false;
              void draw();
            }
          },
          { once: true }
        );
      } catch (e) {
        if (ctx.active()) status(e.message);
      }
    });
  }
  window.addEventListener(
    'storage',
    (event) => {
      if (
        event.key === adminStorageKey(ctx) ||
        event.key === adminStorageKey(ctx).replace(/:data$/, ':connection')
      ) {
        if (document.querySelector('.admin-dialog[open]')) refreshAfterDialog = true;
        else void draw();
      }
    },
    { signal: ctx.signal }
  );
  if (tab === 'overview' && connection(ctx).mode !== 'demo') {
    let updating = false;
    const refresh = async () => {
      if (updating || document.hidden || !ctx.active() || connection(ctx).mode === 'demo') return;
      updating = true;
      try {
        await draw();
      } finally {
        updating = false;
      }
    };
    const timer = setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh, { signal: ctx.signal });
    ctx.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  }
  await draw();
}
