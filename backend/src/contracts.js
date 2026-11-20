
const string = { type: 'string' };
const date = { type: 'string', format: 'date-time' };
const uuid = { type: 'string', format: 'uuid' };
const count = { type: 'integer' };
const bool = { type: 'boolean' };
const anyObject = { type: 'object', additionalProperties: true };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const enumOf = (...values) => ({ type: 'string', enum: values });
const shape = properties => ({ type: 'object', properties, required: Object.keys(properties) });
const items = schema => ({ type: 'array', items: schema });
const collection = schema => shape({ items: items(schema) });
const none = { type: 'null', description: 'No content' };

const account = shape({ id: uuid, email: string, displayName: string, type: enumOf('personal', 'enterprise', 'agent') });
const workspace = shape({ id: uuid, name: string, kind: enumOf('personal', 'enterprise', 'agent'), role: enumOf('owner', 'admin', 'member') });
const identity = { account, workspaces: items(workspace) };
const session = shape({ ...identity, token: string, expiresAt: date });
const wallet = shape({ balance: count, reserved: count, available: count });
const member = shape({ id: uuid, email: string, displayName: string, role: string });
const project = shape({ id: uuid, name: string, archivedAt: nullable(date), createdAt: date });
const base = shape({ id: uuid, name: string, createdAt: date });
const document = shape({ id: uuid, name: string, category: string, createdAt: date });
const asset = shape({
  id: uuid, name: string, mediaType: string, source: string, purpose: string,
  consentReference: nullable(string), consentExpiresAt: nullable(date), sizeBytes: count, createdAt: date,
});
const task = shape({
  id: uuid, capabilityId: string, pluginId: string, projectId: nullable(uuid), parentId: nullable(uuid),
  state: enumOf('queued', 'running', 'succeeded', 'failed', 'cancelled'), cost: count, attempts: count,
  result: nullable(anyObject), errorCode: nullable(string), createdAt: date, updatedAt: date,
});
const pluginCapability = shape({
  id: string, name: string, pluginId: string, available: bool, cost: count, modes: items(string),
  minAssets: count, requiresConsent: bool, requiresConfirmation: bool, parameters: anyObject,
});
pluginCapability.properties.endpoint = string;
const plugin = shape({
  id: string, name: string, enabled: bool, capabilities: items(pluginCapability),
});
const notification = shape({ id: string, type: string, data: anyObject, readAt: nullable(date), createdAt: date });
const memory = shape({ id: uuid, scope: enumOf('personal', 'enterprise'), content: string, createdAt: date });
const preferences = shape({ preferences: anyObject });
const conversationState = enumOf('assistant', 'human');
const conversation = shape({
  id: uuid, accountId: uuid, operatorId: nullable(uuid), subject: string,
  knowledgeBaseIds: items(uuid), state: conversationState, lastSearch: nullable(string), createdAt: date, updatedAt: date,
});
const message = shape({
  id: string, sender: enumOf('customer', 'assistant', 'operator'), content: string, createdAt: date,
  sources: items(shape({ baseId: uuid, baseName: string, documentId: uuid, documentName: string, ordinal: count, snippet: string })),
});
const schedule = shape({
  id: uuid, runAt: date, request: anyObject, state: enumOf('pending', 'submitted', 'failed', 'cancelled'),
  taskId: nullable(uuid), errorCode: nullable(string), createdAt: date, updatedAt: date,
});
const quickReply = shape({ id: uuid, title: string, scenario: string, content: string, revision: count, updatedAt: date });
const failure = shape({ error: shape({ code: string, message: string, requestId: string }) });

export const contracts = new Map([
  ['/v1/auth/register', { POST: { 201: session } }],
  ['/v1/auth/login', { POST: { 200: session } }],
  ['/v1/auth/me', { GET: { 200: shape(identity) } }],
  ['/v1/auth/logout', { POST: { 204: none } }],
  ['/v1/members', { GET: { 200: collection(member) } }],
  ['/v1/members/:id', { PATCH: { 200: shape({ id: uuid, role: string }) } }],
  ['/v1/invitations', { POST: { 201: shape({ token: string, expiresAt: date }) } }],
  ['/v1/invitations/accept', { POST: { 200: shape({ workspaceId: uuid, workspaces: items(workspace) }) } }],
  ['/v1/credits/wallet', { GET: { 200: wallet } }],
  ['/v1/credits/allocate', { POST: { 200: wallet } }],
  ['/v1/credits/ledger', { GET: { 200: collection(shape({ id: string, reference: string, operation: string, amount: count, createdAt: date })) } }],
  ['/v1/projects', { GET: { 200: collection(project) }, POST: { 201: project } }],
  ['/v1/projects/:id', { GET: { 200: project }, PATCH: { 200: project } }],
  ['/v1/projects/:id/members/:memberId', { PUT: { 204: none }, DELETE: { 204: none } }],
  ['/v1/knowledge/bases', { GET: { 200: collection(base) }, POST: { 201: base } }],
  ['/v1/knowledge/bases/:id', { PATCH: { 200: base }, DELETE: { 204: none } }],
  ['/v1/knowledge/bases/:id/grants/:memberId', { PUT: { 204: none }, DELETE: { 204: none } }],
  ['/v1/knowledge/bases/:id/documents', { GET: { 200: collection(document) }, POST: { 201: document } }],
  ['/v1/knowledge/bases/:id/documents/:documentId', { GET: { 200: shape({ ...document.properties, content: string }) }, DELETE: { 204: none } }],
  ['/v1/knowledge/search', { POST: { 200: collection(shape({ baseId: uuid, baseName: string, documentId: uuid, name: string, category: string, ordinal: count, snippet: string })) } }],
  ['/v1/assets', { GET: { 200: collection(asset) }, POST: { 201: asset } }],
  ['/v1/assets/:id', { DELETE: { 204: none } }],
  ['/v1/plugins', { GET: { 200: collection(plugin) } }],
  ['/v1/plugins/:id/state', { PUT: { 200: shape({ id: string, enabled: bool }) } }],
  ['/v1/customer-service/conversations', { GET: { 200: collection(conversation) }, POST: { 201: conversation } }],
  ['/v1/customer-service/conversations/:id/messages', {
    GET: { 200: shape({ conversation, items: items(message) }) },
    POST: { 201: shape({ message, assistant: nullable(message), state: conversationState }) },
  }],
  ['/v1/customer-service/conversations/:id/handoff', { POST: { 200: conversation } }],
  ['/v1/customer-service/quick-replies', { GET: { 200: collection(quickReply) }, POST: { 201: quickReply } }],
  ['/v1/customer-service/quick-replies/:id', { PUT: { 200: quickReply }, DELETE: { 204: none } }],
  ['/v1/shops', { GET: { 200: collection(shape({ id: uuid, name: string, platform: string, capabilities: items(string) })) } }],
  ['/v1/shops/previews', { POST: { 201: shape({ confirmationId: uuid, expiresAt: date, capabilityId: string, parameters: anyObject }) } }],
  ['/v1/tasks', { GET: { 200: collection(task) }, POST: { 200: task, 202: task } }],
  ['/v1/tasks/:id', { GET: { 200: task } }],
  ['/v1/tasks/:id/cancel', { POST: { 200: task } }],
  ['/v1/tasks/:id/regenerate', { POST: { 200: task, 202: task } }],
  ['/v1/schedules', { GET: { 200: collection(schedule) }, POST: { 200: schedule, 201: schedule } }],
  ['/v1/schedules/:id/cancel', { POST: { 200: schedule } }],
  ['/v1/notifications', { GET: { 200: shape({ items: items(notification), unread: count }) } }],
  ['/v1/notifications/:id/read', { POST: { 204: none } }],
  ['/v1/notifications/read-all', { POST: { 204: none } }],
  ['/v1/settings', { GET: { 200: preferences }, PATCH: { 200: preferences } }],
  ['/v1/memory', { GET: { 200: collection(memory) }, POST: { 201: memory } }],
  ['/v1/memory/:id', { DELETE: { 204: none } }],
  ['/health', { GET: { 200: shape({ status: string }) } }],
  ['/ready', { GET: { 200: shape({ status: string }) } }],
]);

export const errorContracts = { '4xx': failure, '5xx': failure };
