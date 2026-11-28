const base = '/v1/admin/workspace';
const modelPath = id => '/v1/merchant/connections/model/' + encodeURIComponent(id);

const events = {
  'credits.reallocated': '分配或收回积分',
  'invitation.created': '创建邀请',
  'invitation.accepted': '接受邀请',
  'invitation.revoked': '撤销邀请',
  'invitation.renewed': '续期邀请',
  'member.role-changed': '调整成员角色',
  'member.state-changed': '调整成员状态',
  'connection.checked': '检查连接',
  'connection.state-changed': '调整连接状态'
};

async function models(ctx) {
  const { items } = await ctx.api('/v1/merchant/connections');
  return items.filter(item => item.kind === 'model');
}

export async function workspaceData(ctx, tab) {
  const native = { native: true, owner: ctx.workspace.role === 'owner', accountId: ctx.account.id };
  if (tab === 'overview') {
    const [summary, history, channels] = await Promise.all([
      ctx.api(base + '/overview'),
      ctx.api('/v1/merchant/audit-events?limit=30'),
      models(ctx)
    ]);
    return {
      ...native, trend: summary.trend,
      totals: { ...summary.totals, models: channels.filter(model => model.enabled).length },
      audit: history.items.map(event => ({
        at: event.occurredAt, actor: event.actorName,
        message: events[event.action] ?? event.action
      }))
    };
  }
  if (tab === 'models') return { ...native, models: await models(ctx) };
  if (tab === 'credits') {
    const [users, { items: ledger }, wallet] = await Promise.all([
      ctx.all(base + '/members'), ctx.api(base + '/ledger?limit=30'), ctx.api('/v1/credits/wallet')
    ]);
    return { ...native, users, ledger, wallet };
  }
  return { ...native, users: await ctx.all(base + '/members') };
}

export async function workspaceAction(ctx, action, values, operationId) {
  const id = encodeURIComponent(values.id ?? '');
  switch (action) {
    case 'invite': {
      const result = await ctx.api('/v1/invitations', { method: 'POST', body: values });
      const url = new URL('/', location.origin);
      url.hash = 'team/' + result.token;
      return { invitation: { url: url.href, expiresAt: result.expiresAt }, message: '已生成一次性邀请链接。' };
    }
    case 'member-role':
      await ctx.api('/v1/members/' + id, { method: 'PATCH', body: { role: values.role } });
      return '成员角色已更新。';
    case 'user-status':
      await ctx.api('/v1/members/' + id + '/state', {
        method: 'PATCH', body: { state: values.enabled ? 'active' : 'suspended' }
      });
      return values.enabled ? '成员已恢复。' : '成员已停用。';
    case 'adjust': {
      const { userId, delta, reason } = values;
      await ctx.api(base + '/credits/adjust', { method: 'POST', body: { userId, delta, reason, operationId } });
      return '积分和流水已更新。';
    }
    case 'member-limit':
      await ctx.api('/v1/credits/members/' + id + '/limit', { method: 'PUT', body: { limit: values.limit } });
      return '任务额度已更新。';
    case 'model-status':
      await ctx.api(modelPath(values.id), {
        method: 'PUT', body: { enabled: values.enabled, revision: values.revision }
      });
      return values.enabled ? '模型已启用。' : '模型已停用。';
    case 'model-test': {
      const result = await ctx.api(modelPath(values.id) + '/check', { method: 'POST' });
      return result.checkState === 'reachable' ? '模型连通性检查通过。' : '模型连通性检查失败，请检查部署配置。';
    }
    case 'health': {
      const [ready, database] = await Promise.all([
        ctx.api('/ready', { auth: false }), ctx.api('/v1/workspace/database')
      ]);
      if (ready.status !== 'ready' || database.state !== 'ready') throw Error('工作区数据库尚未就绪。');
      return database.mode === 'dedicated' ? '服务和独立工作区数据库均已就绪。' : '服务和共享数据库均已就绪。';
    }
    default:
      throw Error('当前工作台服务不支持该管理操作。');
  }
}
