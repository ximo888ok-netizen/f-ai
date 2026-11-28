import { applyDemo, initialDemo, overview } from './admin-demo.js';

export const tabs = {
  overview: '总览',
  users: '用户管理',
  credits: '积分与充值',
  subscriptions: '订阅套餐',
  models: '模型接入',
  server: '服务器配置'
};
export const canOpenAdmin = (workspace) =>
  workspace?.kind === 'enterprise' && ['owner', 'admin'].includes(workspace.role);
const defaults = { mode: 'demo', baseUrl: '', auth: 'bearer', webhook: '', timeout: 10000 };
const memory = new Map(),
  volatile = new Set(),
  credentials = new Map(),
  modelKeys = new Map(),
  queues = new Map();
const scope = (ctx) => 'fai.admin.v1:' + ctx.account.id + ':' + ctx.workspace.id;
export function forgetAdminCredentials() {
  credentials.clear();
  modelKeys.clear();
}
export const modelKey = (ctx, id) => modelKeys.get(scope(ctx) + ':' + id) || '';
export const adminStorageKey = (ctx) => scope(ctx) + ':data';
export const usesMemory = (ctx) => volatile.has(adminStorageKey(ctx)) || volatile.has(scope(ctx) + ':connection');

function read(key, fallback) {
  if (!volatile.has(key)) {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const value = JSON.parse(raw);
        memory.set(key, value);
        return value;
      }
      memory.delete(key);
    } catch {
      volatile.add(key);
    }
  }
  return memory.get(key) ?? fallback();
}
function write(key, value) {
  memory.set(key, value);
  if (!volatile.has(key)) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      volatile.add(key);
    }
  }
}
function demo(ctx) {
  return read(adminStorageKey(ctx), () => initialDemo(ctx.account));
}
function mutate(ctx, action, data) {
  const key = adminStorageKey(ctx);
  const commit = () => {
    if (!ctx.active()) throw new DOMException('操作已取消', 'AbortError');
    const state = structuredClone(demo(ctx));
    const message = applyDemo(state, ctx.account, action, data);
    write(key, state);
    if (action === 'model' && data.apiKey) {
      const model = state.models.find((m) => m.name === data.name && m.modelId === data.modelId);
      modelKeys.set(scope(ctx) + ':' + model.id, data.apiKey);
    }
    if (action === 'model-delete') modelKeys.delete(scope(ctx) + ':' + data.id);
    return message;
  };
  if (navigator.locks) return navigator.locks.request(key, commit);
  const job = (queues.get(key) || Promise.resolve()).catch(() => {}).then(commit);
  queues.set(key, job);
  return job;
}

export const connection = (ctx) => ({ ...defaults, ...read(scope(ctx) + ':connection', () => ({})) });
export function hasCredential(ctx) {
  const config = connection(ctx),
    saved = credentials.get(scope(ctx));
  return Boolean(saved?.secret && saved.baseUrl === config.baseUrl && saved.auth === config.auth);
}
export function safeAddress(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('请填写完整的服务地址。');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || url.origin === location.origin))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('请使用 HTTPS 或本机地址，地址中不能包含凭据、查询串或片段。');
  return url.href.replace(/\/+$/, '');
}

export async function saveConnection(ctx, values) {
  const mode = values.mode,
    auth = values.auth;
  if (!['demo', 'remote'].includes(mode) || !['bearer', 'secret'].includes(auth)) throw Error('连接方式无效。');
  const baseUrl = values.baseUrl ? safeAddress(values.baseUrl) : '';
  const webhook = values.webhook ? safeAddress(values.webhook) : '';
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) throw Error('超时范围为 1000–60000 毫秒。');
  const previous = connection(ctx);
  const credential = credentials.get(scope(ctx));
  const secret =
    values.secret || (credential?.baseUrl === baseUrl && credential.auth === auth ? credential.secret : '');
  if (mode === 'remote' && (!baseUrl || !secret)) throw Error('请填写后台地址及该后台专用的管理员凭据。');
  if (mode === 'demo' || previous.mode === 'demo') await mutate(ctx, 'config', {});
  if (!ctx.active()) return;
  if (mode === 'remote') credentials.set(scope(ctx), { baseUrl, auth, secret });
  else credentials.delete(scope(ctx));
  write(scope(ctx) + ':connection', { mode, baseUrl, auth, webhook, timeout });
}

export const contracts = {
  overview: 'GET /v1/admin/overview',
  users: 'GET, POST /v1/admin/users · PATCH, DELETE /v1/admin/users/:id',
  credits: 'POST /v1/admin/credits/adjust · GET, PUT /v1/admin/recharge-tiers',
  subscriptions: 'GET, POST /v1/admin/subscriptions · PATCH /v1/admin/subscriptions/:id',
  models: 'GET, POST /v1/admin/models · PUT, DELETE /v1/admin/models/:id · POST /v1/admin/models/:id/test',
  health: 'GET /health'
};

async function request(ctx, path, method = 'GET', body, operationId) {
  const config = connection(ctx),
    credential = credentials.get(scope(ctx));
  if (!credential || credential.baseUrl !== config.baseUrl || credential.auth !== config.auth)
    throw Error('请在服务器配置中重新输入本次会话的管理员凭据。');
  const service = safeAddress(config.baseUrl);
  const headers = { Accept: 'application/json' };
  if (path !== '/health') {
    if (config.auth === 'bearer') headers.Authorization = 'Bearer ' + credential.secret;
    else headers['X-Admin-Secret'] = credential.secret;
  }
  if (operationId) headers['Idempotency-Key'] = operationId;
  if (body) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(service + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeout)]),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw Error(
      error.name === 'TimeoutError'
        ? '管理后台请求超时。'
        : '无法连接指定后台，请检查服务地址、部署允许的来源及跨域配置。'
    );
  }
  if (!response.ok)
    throw Error(
      '管理后台返回 HTTP ' +
        response.status +
        (response.status === 401 || response.status === 403 ? '，请检查凭据和管理权限。' : '。')
    );
  if (response.status === 204) return null;
  if (!response.headers.get('content-type')?.includes('json')) throw Error('管理后台没有返回约定的 JSON 数据。');
  return response.json();
}

function assertAccess(ctx) {
  if (!canOpenAdmin(ctx.workspace)) throw Error('当前工作区账号没有管理权限。');
}

export async function adminData(ctx, tab) {
  assertAccess(ctx);
  if (connection(ctx).mode === 'demo') {
    const state = demo(ctx);
    return tab === 'overview' ? overview(state) : state;
  }
  const endpoints = {
    overview: ['overview'],
    users: ['users'],
    credits: ['recharge-tiers', 'users'],
    subscriptions: ['subscriptions', 'users'],
    models: ['models']
  };
  const values = await Promise.all(endpoints[tab].map((endpoint) => request(ctx, '/v1/admin/' + endpoint)));
  const data = Object.assign({}, ...values);
  const lists = {
    overview: ['trend', 'audit'],
    users: ['users'],
    credits: ['tiers', 'rules', 'orders', 'ledger', 'users'],
    subscriptions: ['plans', 'subscriptions', 'users'],
    models: ['models']
  };
  if (lists[tab].some((k) => !Array.isArray(data[k])) || (tab === 'overview' && !data.totals))
    throw Error('管理后台响应缺少本页需要的字段。');
  return data;
}

const mutations = {
  user: (v) => [v.id ? 'PATCH' : 'POST', 'users', v.id],
  'user-status': (v) => ['PATCH', 'users', v.id],
  'user-delete': (v) => ['DELETE', 'users', v.id],
  adjust: () => ['POST', 'credits/adjust'],
  tier: () => ['PUT', 'recharge-tiers'],
  'tier-status': () => ['PUT', 'recharge-tiers'],
  rule: () => ['PUT', 'recharge-tiers'],
  plan: (v) => ['PATCH', 'subscriptions', v.id],
  subscribe: () => ['POST', 'subscriptions'],
  renew: (v) => ['PATCH', 'subscriptions', v.id],
  'cancel-sub': (v) => ['PATCH', 'subscriptions', v.id],
  model: (v) => [v.id ? 'PUT' : 'POST', 'models', v.id],
  'model-status': (v) => ['PUT', 'models', v.id],
  'model-delete': (v) => ['DELETE', 'models', v.id],
  'model-test': (v) => ['POST', 'models', v.id, '/test']
};
export async function adminAction(ctx, action, values = {}, operationId) {
  assertAccess(ctx);
  if (connection(ctx).mode === 'demo') return mutate(ctx, action, values);
  if (action === 'health') {
    const data = await request(ctx, '/health');
    if (data?.status !== 'ok') throw Error('管理后台未报告健康状态。');
    return '后台健康检查通过';
  }
  const [method, resource, id, suffix = ''] = mutations[action](values);
  const path = '/v1/admin/' + resource + (id ? '/' + encodeURIComponent(id) : '') + suffix;
  const result = await request(
    ctx,
    path,
    method,
    method === 'DELETE' ? undefined : { ...values, action },
    operationId
  );
  if (action === 'model-test') {
    if (result?.ok !== true) throw Error('供应商未确认模型连通性。');
    return '模型连通性测试通过';
  }
  return '后台已保存';
}
