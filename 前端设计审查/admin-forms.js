import { h, select } from './live-ui.js';
import { roles, modelKinds } from './admin-demo.js';
import { connection, modelKey, safeAddress } from './admin-data.js';

const fields = {
  user: '用户资料',
  invite: '邀请成员',
  'member-role': '调整成员角色',
  'member-limit': '编辑任务额度',
  adjust: '手动调账',
  tier: '充值档位',
  rule: '功能扣费倍率',
  plan: '订阅套餐',
  subscribe: '手动开通订阅',
  model: '模型通道',
  config: '连接配置',
  'user-delete': '删除用户',
  'model-delete': '移除模型',
  'cancel-sub': '取消订阅',
  renew: '续费 30 天'
};
const label = (title, html) => '<label class="adm-field"><span>' + h(title) + '</span>' + html + '</label>';
const input = (key, title, value = '', attrs = 'required maxlength="160"') =>
  label(title, '<input class="adm-input" name="' + h(key) + '" value="' + h(value) + '" ' + attrs + '>');
const pick = (key, title, values, value) => label(title, select(key, values, value, 'required class="adm-select"'));
const boolean = (key, title, value) =>
  label(title, '<input type="checkbox" name="' + h(key) + '"' + (value ? ' checked' : '') + '>');
const numeric = (key, title, value, min = '0', step = '1') =>
  input(key, title, value, 'type="number" required min="' + min + '" step="' + step + '"');
const secret = (key, title, value = '') =>
  input(key, title, value, 'type="password" maxlength="4096" autocomplete="new-password"') +
  '<button class="adm-btn sm" type="button" data-reveal="' +
  h(key) +
  '" aria-pressed="false">显示' +
  h(title) +
  '</button>';
const memberChoices = (data) => data.users.filter((u) => u.enabled).map((u) => [u.id, u.name + ' · ' + u.email]);

function formContent(action, id, data, ctx) {
  const row = (collection) => data[collection]?.find((x) => x.id === id) || {};
  const memberRoles = [['member', '普通成员'], ...(data.owner ? [['admin', '企业管理员']] : [])];
  if (action === 'invite')
    return input('email', '邮箱', '', 'type="email" required maxlength="254"') +
      pick('role', '角色', memberRoles, 'member');
  if (action === 'member-role') return pick('role', '角色', memberRoles, row('users').role);
  if (action === 'member-limit')
    return input('limit', '累计任务积分上限（留空为不限）', row('users').taskLimit ?? '',
      'type="number" min="0" max="1000000000" step="1"');
  if (action === 'user') {
    const u = row('users');
    return (
      input('name', '姓名', u.name) +
      input('email', '邮箱', u.email, 'type="email" required maxlength="254"') +
      pick('role', '角色', Object.entries(roles), u.role || 'member')
    );
  }
  if (action === 'adjust')
    return (
      pick('userId', '用户', data.native ? data.users
        .filter(user => user.enabled && user.id !== data.accountId)
        .map(user => [user.id, user.name + ' · ' + user.available + ' 可用积分']) : memberChoices(data), id) +
      pick(
        'direction',
        '变动方向',
        [
          ['add', data.native ? '分配给成员' : '充值 / 增加'],
          ['subtract', data.native ? '从成员收回' : '扣减']
        ],
        'add'
      ) +
      numeric('quantity', '积分数', 1, 1) +
      (data.native ? '' : numeric('amount', '实际入账金额（元）', 0, 0, '.01')) +
      input('reason', '调账原因')
    );
  if (action === 'tier') {
    const t = row('tiers');
    return (
      input('name', '档位名称', t.name) +
      numeric('price', '售价（元）', (t.priceCents || 0) / 100, 0, '.01') +
      numeric('base', '基础积分', t.base ?? 100, 1) +
      numeric('bonus', '赠送积分', t.bonus ?? 0) +
      boolean('enabled', '上架', t.enabled ?? true)
    );
  }
  if (action === 'rule') return numeric('multiplier', '积分扣费倍率', row('rules').multiplier, '.01', '.01');
  if (action === 'plan') {
    const p = row('plans');
    return (
      numeric('price', '月费（元）', p.priceCents / 100, 0, '.01') +
      numeric('monthlyCredits', '月赠积分', p.monthlyCredits) +
      numeric('seats', '并发席位', p.seats, 1)
    );
  }
  if (action === 'subscribe')
    return (
      pick('userId', '用户', memberChoices(data)) +
      pick(
        'planId',
        '套餐',
        data.plans.map((p) => [p.id, p.name])
      )
    );
  if (action === 'model') {
    const m = row('models');
    return (
      input('name', 'Provider', m.name) +
      input('modelId', 'Model ID', m.modelId) +
      pick('kind', '类型', Object.entries(modelKinds), m.kind || 'llm') +
      input('baseUrl', 'Base URL', m.baseUrl, 'type="url" required maxlength="2000"') +
      secret('apiKey', m.hasKey ? 'API Key（留空保留）' : 'API Key', modelKey(ctx, id)) +
      numeric('multiplier', '计费倍率', m.multiplier ?? 1, '.01', '.01') +
      boolean('isDefault', '默认路由', m.isDefault) +
      boolean('enabled', '启用', m.enabled ?? true)
    );
  }
  if (action === 'config') {
    const c = connection(ctx);
    return (
      pick(
        'mode',
        '运行模式',
        [
          ['workspace', '当前工作台服务'],
          ['demo', '本地演示'],
          ['remote', '对接自建后端']
        ],
        c.mode
      ) +
      input(
        'baseUrl',
        '后台 Base URL',
        c.baseUrl,
        'type="url" maxlength="2000" placeholder="https://admin.example.com"'
      ) +
      pick(
        'auth',
        '鉴权方式',
        [
          ['bearer', 'Bearer JWT'],
          ['secret', 'X-Admin-Secret']
        ],
        c.auth
      ) +
      secret('secret', '管理凭据') +
      '<small>凭据仅用于本次登录。切换服务地址或鉴权方式时，请填写对应的新凭据。</small>' +
      input('webhook', '支付回调 Webhook', c.webhook, 'type="url" maxlength="2000"') +
      numeric('timeout', '请求超时（毫秒）', c.timeout, 1000)
    );
  }
  const target =
    action === 'user-delete'
      ? row('users').name
      : action === 'model-delete'
        ? row('models').modelId
        : row('subscriptions').userName;
  return '<p>确认对「' + h(target) + '」执行' + h(fields[action]) + '？</p>';
}

function valuesFor(action, id, form) {
  const values = Object.fromEntries(new FormData(form));
  for (const key of ['enabled', 'isDefault']) if (form.elements[key]) values[key] = form.elements[key].checked;
  if (action === 'adjust') {
    const amountCents = Math.round(Number(values.amount ?? 0) * 100);
    const delta = Number(values.quantity) * (values.direction === 'subtract' ? -1 : 1);
    if (
      !Number.isSafeInteger(delta) ||
      !delta ||
      !Number.isSafeInteger(amountCents) ||
      amountCents < 0 ||
      (delta < 0 && amountCents)
    )
      throw Error('请核对积分和入账金额。');
    return { userId: values.userId, delta, amountCents, reason: values.reason.trim() };
  }
  if (action === 'member-limit') values.limit = values.limit === '' ? null : Number(values.limit);
  for (const key of ['seats', 'monthlyCredits', 'timeout', 'base', 'bonus', 'multiplier'])
    if (key in values) values[key] = Number(values[key]);
  if ('price' in values) {
    values.priceCents = Math.round(values.price * 100);
    delete values.price;
  }
  if (action === 'model') {
    values.baseUrl = safeAddress(values.baseUrl);
    if (!values.enabled && values.isDefault) throw Error('默认路由须启用。');
    if (!values.apiKey) delete values.apiKey;
  }
  if (id) values.id = id;
  return values;
}

export function openAdminDialog(ctx, action, id, data, save) {
  const dialog = document.createElement('dialog');
  dialog.className = 'ui-dialog admin-dialog';
  dialog.setAttribute('aria-labelledby', 'admin-dialog-title');
  const previous = document.activeElement;
  dialog.innerHTML =
    '<form><div class="adm-dlg-head"><h3 id="admin-dialog-title">' +
    h(fields[action]) +
    '</h3>' +
    '<button type="button" class="adm-btn" data-dismiss aria-label="关闭">×</button></div><div class="adm-dlg-body">' +
    formContent(action, id, data, ctx) +
    '<p class="live-error" role="alert" hidden></p></div><div class="adm-dlg-foot">' +
    '<button type="button" class="adm-btn" data-dismiss>取消</button><button type="submit" class="adm-btn primary">确认</button></div></form>';
  const form = dialog.querySelector('form'),
    error = dialog.querySelector('[role=alert]'),
    submit = form.querySelector('[type=submit]');
  let pending = false;
  const remove = () => {
    dialog.close();
    dialog.remove();
    if (previous?.isConnected) previous.focus();
  };
  const dismiss = () => {
    if (!pending) remove();
  };
  ctx.signal.addEventListener('abort', remove, { once: true });
  dialog.addEventListener('close', () => ctx.signal.removeEventListener('abort', remove), { once: true });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.querySelectorAll('[data-dismiss]').forEach((button) => (button.onclick = dismiss));
  for (const button of dialog.querySelectorAll('[data-reveal]'))
    button.onclick = () => {
      const control = form.elements[button.dataset.reveal];
      const show = control.type === 'password';
      control.type = show ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(show));
      button.textContent = (show ? '隐藏' : '显示') + control.labels[0].querySelector('span').textContent;
    };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    submit.disabled = true;
    error.hidden = true;
    try {
      await save(valuesFor(action, id, form));
      if (dialog.isConnected) remove();
    } catch (e) {
      if (ctx.active()) {
        error.hidden = false;
        error.textContent = e.message;
      }
    } finally {
      pending = false;
      submit.disabled = false;
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  if (['user-delete', 'model-delete', 'cancel-sub'].includes(action))
    form.querySelector('.adm-dlg-foot [data-dismiss]').focus();
}
