
import { randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { capabilityId } from './catalog.js';
import { array, bool, choice, integer, invalid, notFound, object, page, paginate, requireEnterprise, requireManager, route, text, uuid } from './http.js';

const notificationTags = ['Notifications'];
const settingsTags = ['Settings'];
const memoryTags = ['Memory'];
const notificationId = { type: 'string', pattern: '^[1-9][0-9]{0,17}$' };
const preferenceSchema = object({
  theme: choice('system', 'light', 'dark'),
  studioTheme: choice('glass', 'paper', 'jade', 'noir'),
  studioMotion: choice('on', 'off'),
  favoriteCapabilities: { ...array(capabilityId, capabilityId.enum.length), uniqueItems: true },
  locale: choice('zh-CN', 'en-US'),
  onboardingStep: integer(0, 6),
  doNotDisturb: bool, taskNotifications: bool, memberNotifications: bool, rightsNotifications: bool, rememberConversations: bool,
}, []);

export function registerSupport(app, db) {
  route(app, 'GET', '/v1/notifications', {
    tags: notificationTags, summary: 'List notifications and unread count', querystring: page,
  }, async request => {
    const { workspaceId, accountId } = request.context;
    const [items, count] = await Promise.all([
      rows(db, 'SELECT id::text, type, data, read_at AS "readAt", created_at AS "createdAt" FROM notifications WHERE workspace_id = $1 AND account_id = $2 ORDER BY notifications.id DESC LIMIT $3 OFFSET $4', [workspaceId, accountId, ...paginate(request.query)]),
      row(db, 'SELECT count(*)::integer AS unread FROM notifications WHERE workspace_id = $1 AND account_id = $2 AND read_at IS NULL', [workspaceId, accountId]),
    ]);
    return { items, unread: count.unread };
  });

  route(app, 'POST', '/v1/notifications/:id/read', {
    tags: notificationTags, summary: 'Mark a notification as read', params: object({ id: notificationId }),
  }, async (request, reply) => {
    const item = await row(db, 'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE workspace_id = $1 AND account_id = $2 AND id = $3 RETURNING id', [request.context.workspaceId, request.context.accountId, request.params.id]);
    if (!item) throw notFound('Notification');
    reply.code(204).send();
  });

  route(app, 'POST', '/v1/notifications/read-all', {
    tags: notificationTags, summary: 'Mark current member notifications as read',
  }, async (request, reply) => {
    await db.query('UPDATE notifications SET read_at = now() WHERE workspace_id = $1 AND account_id = $2 AND read_at IS NULL', [request.context.workspaceId, request.context.accountId]);
    reply.code(204).send();
  });

  route(app, 'GET', '/v1/settings', { tags: settingsTags, summary: 'Read member preferences for the current workspace' }, async request => {
    const result = await row(db, 'SELECT preferences FROM account_settings WHERE workspace_id = $1 AND account_id = $2', [request.context.workspaceId, request.context.accountId]);
    return { preferences: result?.preferences ?? {} };
  });

  route(app, 'PATCH', '/v1/settings', {
    tags: settingsTags, summary: 'Persist validated member preferences', body: preferenceSchema,
  }, async request => row(db, [
    'INSERT INTO account_settings (workspace_id, account_id, preferences) VALUES ($1, $2, $3)',
    'ON CONFLICT (workspace_id, account_id) DO UPDATE SET preferences = account_settings.preferences || EXCLUDED.preferences',
    'RETURNING preferences',
  ].join(' '), [request.context.workspaceId, request.context.accountId, request.body]));

  const scopeSchema = choice('personal', 'enterprise');
  const memoryFields = 'id, content, scope, created_at AS "createdAt"';
  route(app, 'GET', '/v1/memory', {
    tags: memoryTags, summary: 'Read personal or enterprise memory in the current workspace',
    querystring: object({ scope: scopeSchema, ...page.properties }, ['scope']),
  }, async request => {
    const { workspaceId, accountId } = request.context;
    const { scope } = request.query;
    if (scope === 'enterprise') requireEnterprise(request);
    return { items: await rows(db, 'SELECT ' + memoryFields + " FROM memory_items WHERE workspace_id = $1 AND scope = $3 AND (scope = 'enterprise' OR account_id = $2) ORDER BY created_at DESC, id LIMIT $4 OFFSET $5", [workspaceId, accountId, scope, ...paginate(request.query)]) };
  });

  route(app, 'POST', '/v1/memory', {
    tags: memoryTags, summary: 'Store private or enterprise memory',
    body: object({ scope: scopeSchema, content: text(10000) }),
  }, async (request, reply) => {
    const { workspaceId, accountId } = request.context;
    const { scope, content } = request.body;
    if (scope === 'enterprise') {
      requireEnterprise(request);
      requireManager(request);
    }
    if (!content.trim()) throw invalid('Memory cannot be blank');
    const result = await row(db, 'INSERT INTO memory_items (id, workspace_id, account_id, scope, content) VALUES ($1, $2, $3, $4, $5) RETURNING ' + memoryFields, [randomUUID(), workspaceId, accountId, scope, content.trim()]);
    reply.code(201);
    return result;
  });

  route(app, 'DELETE', '/v1/memory/:id', {
    tags: memoryTags, summary: 'Delete owned memory or manage enterprise memory', params: object({ id: uuid }),
  }, async (request, reply) => {
    const context = request.context;
    const item = await row(db, [
      'DELETE FROM memory_items WHERE workspace_id = $1 AND id = $2',
      "AND ((scope = 'personal' AND account_id = $3) OR (scope = 'enterprise' AND $4::boolean)) RETURNING id",
    ].join(' '), [context.workspaceId, request.params.id, context.accountId, context.kind === 'enterprise' && context.role !== 'member']);
    if (!item) throw notFound('Memory item');
    reply.code(204).send();
  });
}
