export const roles = { superadmin: '超级管理员', admin: '管理员', member: '普通成员' };
export const modelKinds = { llm: 'LLM', image: 'Image', video: 'Video' };
const day = 86400000;

export function initialDemo(account) {
  return {
    version: 1,
    users: [
      {
        id: account.id,
        name: account.displayName || '当前管理员',
        email: account.email || '',
        role: 'superadmin',
        enabled: true,
        balance: 0
      }
    ],
    tiers: [{ id: 'standard', name: '标准档', priceCents: 1000, base: 100, bonus: 0, enabled: true }],
    rules: ['文本生成', '图片生成', '视频生成'].map((name, index) => ({
      id: String(index + 1),
      name,
      multiplier: 1
    })),
    plans: [
      ['free', '免费版', 0, 0, 1],
      ['pro', '专业版', 9900, 1000, 3],
      ['enterprise', '企业版', 29900, 5000, 10]
    ].map(([id, name, priceCents, monthlyCredits, seats]) => ({ id, name, priceCents, monthlyCredits, seats })),
    models: [],
    subscriptions: [],
    ledger: [],
    orders: [],
    audit: []
  };
}

export function dayKey(value) {
  const d = new Date(value);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join(
    '-'
  );
}

export function overview(state, now = Date.now()) {
  const totals = {
    users: state.users.length,
    revenueCents: state.orders.reduce((v, o) => v + o.amountCents, 0),
    credits: state.users.reduce((v, u) => v + u.balance, 0),
    models: state.models.filter((m) => m.enabled).length
  };
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - 6 + i);
    return { date: dayKey(d), revenueCents: 0, usage: 0 };
  });
  for (const order of state.orders) {
    const slot = dates.find((row) => row.date === dayKey(order.at));
    if (slot) slot.revenueCents += order.amountCents;
  }
  for (const entry of state.ledger) {
    const slot = dates.find((row) => row.date === dayKey(entry.at));
    if (slot && entry.delta < 0) slot.usage -= entry.delta;
  }
  return { totals, trend: dates, audit: state.audit };
}

function find(rows, id, label) {
  const row = rows.find((item) => item.id === id);
  if (!row) throw Error(label + '已不存在，请刷新。');
  return row;
}

function integer(value, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw Error('请输入范围内的整数。');
  return value;
}

function positive(value) {
  if (!Number.isFinite(value) || value <= 0) throw Error('倍率必须大于零。');
  return value;
}

function required(text) {
  if (typeof text !== 'string' || !text.trim()) throw Error('请填写必填项。');
  return text.trim();
}

function upsert(rows, id, values, label) {
  if (id) return Object.assign(find(rows, id, label), values);
  const entry = { id: crypto.randomUUID(), ...values };
  rows.push(entry);
  return entry;
}

function record(state, actor, user, delta, reason, at) {
  integer(user.balance + delta);
  user.balance += delta;
  state.ledger.unshift({
    id: crypto.randomUUID(),
    userId: user.id,
    userName: user.name,
    delta,
    balance: user.balance,
    reason,
    at,
    actor: actor.displayName
  });
}

function normalizeDefaults(rows, kind, preferred) {
  const group = rows.filter((m) => m.kind === kind);
  const selected =
    group.find((m) => m.enabled && m.id === preferred) ||
    group.find((m) => m.enabled && m.isDefault) ||
    group.find((m) => m.enabled);
  for (const model of group) model.isDefault = model === selected;
}

export function applyDemo(state, actor, action, v, now = Date.now()) {
  const at = new Date(now).toISOString();
  let message;
  if (action === 'user') {
    const name = required(v.name),
      email = required(v.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Object.hasOwn(roles, v.role))
      throw Error('请核对邮箱和角色。');
    if (state.users.some((u) => u.email.toLowerCase() === email && u.id !== v.id)) throw Error('该邮箱已存在。');
    if (v.id === actor.id && v.role !== 'superadmin') throw Error('当前操作者须保留管理权限。');
    const values = { name, email, role: v.role };
    upsert(state.users, v.id, v.id ? values : { ...values, enabled: true, balance: 0 }, '用户');
    message = (v.id ? '编辑' : '新增') + '用户 · ' + name;
  } else if (action === 'user-status' || action === 'user-delete') {
    const user = find(state.users, v.id, '用户');
    if (user.id === actor.id) throw Error('无法停用或删除当前操作者。');
    if (action === 'user-status') user.enabled = v.enabled;
    else {
      state.users = state.users.filter((u) => u.id !== user.id);
      for (const sub of state.subscriptions.filter((s) => s.userId === user.id)) sub.cancelled = true;
    }
    message = (action === 'user-delete' ? '删除' : v.enabled ? '启用' : '停用') + '用户 · ' + user.name;
  } else if (action === 'adjust') {
    const user = find(state.users, v.userId, '用户'),
      reason = required(v.reason);
    if (!user.enabled) throw Error('用户已禁用。');
    if (!Number.isSafeInteger(v.delta) || v.delta === 0) throw Error('积分变动必须是非零整数。');
    if (user.balance + v.delta < 0) throw Error('积分余额不足。');
    const amount = integer(v.amountCents);
    if (amount && v.delta < 0) throw Error('扣减积分时入账金额应为零。');
    record(state, actor, user, v.delta, reason, at);
    if (amount)
      state.orders.unshift({
        id: crypto.randomUUID(),
        userId: user.id,
        userName: user.name,
        amountCents: amount,
        at
      });
    message = '积分调账 · ' + user.name + ' ' + (v.delta > 0 ? '+' : '') + v.delta + ' · ' + reason;
  } else if (action === 'tier') {
    const tier = upsert(
      state.tiers,
      v.id,
      {
        name: required(v.name),
        priceCents: integer(v.priceCents),
        base: integer(v.base, 1),
        bonus: integer(v.bonus),
        enabled: v.enabled
      },
      '充值档位'
    );
    message = '保存充值档位 · ' + tier.name;
  } else if (action === 'tier-status') {
    const tier = find(state.tiers, v.id, '档位');
    tier.enabled = v.enabled;
    message = (v.enabled ? '上架' : '下架') + '充值档位 · ' + tier.name;
  } else if (action === 'rule') {
    const rule = find(state.rules, v.id, '扣费规则');
    rule.multiplier = positive(v.multiplier);
    message = '变更扣费倍率 · ' + rule.name;
  } else if (action === 'plan') {
    const plan = find(state.plans, v.id, '套餐');
    Object.assign(plan, {
      priceCents: integer(v.priceCents),
      monthlyCredits: integer(v.monthlyCredits),
      seats: integer(v.seats, 1)
    });
    message = '编辑套餐 · ' + plan.name;
  } else if (['subscribe', 'renew', 'cancel-sub'].includes(action)) {
    let sub;
    if (action === 'subscribe') {
      const user = find(state.users, v.userId, '用户'),
        plan = find(state.plans, v.planId, '套餐');
      if (!user.enabled) throw Error('用户已禁用。');
      if (state.subscriptions.some((s) => s.userId === user.id && !s.cancelled && Date.parse(s.until) > now))
        throw Error('用户已有活跃订阅。');
      sub = {
        id: crypto.randomUUID(),
        userId: user.id,
        userName: user.name,
        planId: plan.id,
        until: at,
        cancelled: false
      };
      state.subscriptions.unshift(sub);
    } else sub = find(state.subscriptions, v.id, '订阅');
    if (sub.cancelled) throw Error('订阅已取消。');
    if (action === 'cancel-sub') sub.cancelled = true;
    else {
      const user = find(state.users, sub.userId, '用户'),
        plan = find(state.plans, sub.planId, '套餐');
      if (!user.enabled) throw Error('用户已禁用。');
      sub.until = new Date(Math.max(now, Date.parse(sub.until)) + 30 * day).toISOString();
      if (plan.monthlyCredits) record(state, actor, user, plan.monthlyCredits, '套餐赠送 · ' + plan.name, at);
    }
    message =
      { subscribe: '手动开通', renew: '续期 30 天', 'cancel-sub': '取消订阅' }[action] + ' · ' + sub.userName;
  } else if (action === 'model') {
    const kind = v.kind,
      name = required(v.name),
      modelId = required(v.modelId);
    if (!Object.hasOwn(modelKinds, kind)) throw Error('请选择模型类型。');
    const prior = v.id ? find(state.models, v.id, '模型') : null;
    const oldKind = prior?.kind;
    if (state.models.some((m) => m.id !== v.id && m.modelId === modelId && m.name === name))
      throw Error('该通道和模型已存在。');
    const model = upsert(
      state.models,
      v.id,
      {
        kind,
        name,
        modelId,
        baseUrl: required(v.baseUrl),
        hasKey: Boolean(v.apiKey) || Boolean(prior?.hasKey),
        multiplier: positive(v.multiplier),
        enabled: v.enabled,
        isDefault: v.isDefault
      },
      '模型'
    );
    if (oldKind && oldKind !== kind) normalizeDefaults(state.models, oldKind);
    normalizeDefaults(state.models, kind, model.isDefault ? model.id : null);
    message = '保存模型通道 · ' + name + ' / ' + modelId;
  } else if (['model-status', 'model-delete', 'model-test'].includes(action)) {
    const model = find(state.models, v.id, '模型');
    if (action === 'model-test') {
      if (!model.enabled) throw Error('请先启用该通道。');
      message = '演示连通性检查通过 · ' + model.modelId;
    } else {
      if (action === 'model-delete') state.models = state.models.filter((m) => m !== model);
      else model.enabled = v.enabled;
      normalizeDefaults(state.models, model.kind);
      message = (action === 'model-delete' ? '移除' : v.enabled ? '启用' : '停用') + '模型 · ' + model.modelId;
    }
  } else if (action === 'health') message = '演示健康检查通过';
  else if (action === 'config') message = '更新管理连接配置';
  else throw Error('未知管理操作。');
  state.audit.unshift({ id: crypto.randomUUID(), at, actor: actor.displayName, message });
  return message;
}
