
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { row, rows } from './db.js';
import { ApiError, choice, invalid, notFound, object, requireEnterprise, route, text, uuid } from './http.js';

const derive = promisify(scrypt);
const emailSchema = { ...text(254, 3), format: 'email' };
const passwordSchema = text(128, 10);
const tags = ['Identity'];
const authLimit = { rateLimit: { max: 15, timeWindow: '1 minute' } };

export const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const normalizeEmail = value => value.trim().toLowerCase();
const invalidCredentials = () => new ApiError(401, 'UNAUTHENTICATED', 'Invalid email or password');

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64);
  return salt + ':' + hash.toString('hex');
}

async function checkPassword(password, stored) {
  const [salt, hash] = (stored ?? ('0'.repeat(32) + ':' + '0'.repeat(128))).split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = await derive(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

export async function getWorkspaces(db, accountId) {
  return rows(db, 'SELECT w.id, w.name, w.kind, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.account_id = $1 ORDER BY m.created_at, w.id', [accountId]);
}

async function createSession(db, account) {
  const token = secret();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await db.query('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [digest(token), account.id, expiresAt]);
  return {
    token,
    expiresAt,
    account: { id: account.id, email: account.email, displayName: account.display_name, type: account.account_type },
    workspaces: await getWorkspaces(db, account.id),
  };
}

export function registerAuth(app, db) {
  app.decorateRequest('account', null);
  app.decorateRequest('sessionHash', null);
  app.decorateRequest('context', null);
  app.decorate('authenticate', async request => {
    const authorization = request.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid session is required');
    const hash = digest(match[1]);
    const account = await row(db, 'SELECT a.id, a.email, a.display_name, a.account_type FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.expires_at > now()', [hash]);
    if (!account) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid session is required');
    request.account = { id: account.id, email: account.email, displayName: account.display_name, type: account.account_type };
    request.sessionHash = hash;
  });
  app.decorate('authenticateWorkspace', async request => {
    await app.authenticate(request);
    const workspaceId = request.headers['x-workspace-id'];
    const membership = await row(db, 'SELECT m.role, w.kind FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.account_id = $1 AND m.workspace_id = $2', [request.account.id, workspaceId]);
    if (!membership) throw notFound('Workspace');
    request.context = { workspaceId, accountId: request.account.id, ...membership };
  });

  route(app, 'POST', '/v1/auth/register', {
    auth: false, tags, config: authLimit, summary: 'Register an account and create its initial workspace',
    body: object({
      email: emailSchema, password: passwordSchema, displayName: text(100),
      type: choice('personal', 'enterprise'), workspaceName: text(100),
    }, ['email', 'password', 'displayName', 'type']),
  }, async (request, reply) => {
    const { displayName, type, password, workspaceName } = request.body;
    if (type === 'enterprise' && !workspaceName?.trim()) throw invalid('workspaceName is required for enterprise registration');
    const display = displayName.trim();
    if (!display) throw invalid('displayName cannot be blank');
    const email = normalizeEmail(request.body.email);
    const passwordHash = await hashPassword(password);
    try {
      const result = await db.transaction(async connection => {
        const account = await row(connection, 'INSERT INTO accounts (id, email, password_hash, display_name, account_type) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name, account_type', [randomUUID(), email, passwordHash, display, type]);
        const workspaceId = randomUUID();
        await connection.query('INSERT INTO workspaces (id, kind, name) VALUES ($1, $2, $3)', [workspaceId, type, workspaceName?.trim() || display]);
        await connection.query("INSERT INTO memberships (workspace_id, account_id, role) VALUES ($1, $2, 'owner')", [workspaceId, account.id]);
        await connection.query('INSERT INTO wallets (workspace_id, account_id) VALUES ($1, $2)', [workspaceId, account.id]);
        return createSession(connection, account);
      });
      reply.code(201);
      return result;
    } catch (error) {
      if (error.code === '23505') throw new ApiError(409, 'EMAIL_IN_USE', 'Email is already registered');
      throw error;
    }
  });

  route(app, 'POST', '/v1/auth/login', {
    auth: false, tags, config: authLimit, summary: 'Create a session', body: object({ email: emailSchema, password: passwordSchema }),
  }, async request => {
    const account = await row(db, 'SELECT * FROM accounts WHERE email = $1', [normalizeEmail(request.body.email)]);
    if (!(await checkPassword(request.body.password, account?.password_hash)) || !account) throw invalidCredentials();
    return createSession(db, account);
  });

  route(app, 'GET', '/v1/auth/me', { tenant: false, tags, summary: 'Get account and available workspaces' },
    async request => ({ account: request.account, workspaces: await getWorkspaces(db, request.account.id) }));

  route(app, 'POST', '/v1/auth/logout', { tenant: false, tags, summary: 'Revoke the current session' },
    async (request, reply) => {
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [request.sessionHash]);
      reply.code(204).send();
    });

  route(app, 'GET', '/v1/members', { manager: true, tags, summary: 'List workspace members' }, async request => {
    requireEnterprise(request);
    return { items: await rows(db, 'SELECT a.id, a.email, a.display_name AS "displayName", m.role FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.workspace_id = $1 ORDER BY m.created_at, a.id', [request.context.workspaceId]) };
  });

  route(app, 'POST', '/v1/invitations', {
    manager: true, tags, summary: 'Create a one-time invitation for a specific email',
    body: object({ email: emailSchema, role: choice('admin', 'member') }),
  }, async (request, reply) => {
    requireEnterprise(request);
    const { workspaceId } = request.context;
    const { role } = request.body;
    if (role === 'admin' && request.context.role !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Only owners may invite administrators');
    const email = normalizeEmail(request.body.email);
    const token = secret();
    const expiresAt = new Date(Date.now() + 48 * 3600 * 1000);
    await db.query('INSERT INTO invitations (token_hash, workspace_id, email, role, expires_at) VALUES ($1, $2, $3, $4, $5)', [digest(token), workspaceId, email, role, expiresAt]);
    reply.code(201);
    return { token, expiresAt };
  });

  route(app, 'POST', '/v1/invitations/accept', {
    tenant: false, tags, summary: 'Accept an invitation using the invited account',
    body: object({ token: { ...text(43, 43), pattern: '^[A-Za-z0-9_-]+$' } }),
  }, async request => db.transaction(async connection => {
    const tokenHash = digest(request.body.token);
    const invitation = await row(connection, 'SELECT workspace_id, role FROM invitations WHERE token_hash = $1 AND email = $2 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE', [tokenHash, request.account.email]);
    if (!invitation) throw notFound('Invitation');
    const workspaceId = invitation.workspace_id;
    await connection.query('INSERT INTO memberships (workspace_id, account_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, account_id) DO NOTHING', [workspaceId, request.account.id, invitation.role]);
    await connection.query('INSERT INTO wallets (workspace_id, account_id) VALUES ($1, $2) ON CONFLICT (workspace_id, account_id) DO NOTHING', [workspaceId, request.account.id]);
    await connection.query('UPDATE invitations SET accepted_at = now() WHERE token_hash = $1', [tokenHash]);
    return { workspaceId, workspaces: await getWorkspaces(connection, request.account.id) };
  }));

  route(app, 'PATCH', '/v1/members/:id', {
    manager: true, tags, summary: 'Change an enterprise member role',
    params: object({ id: uuid }), body: object({ role: choice('admin', 'member') }),
  }, async request => {
    requireEnterprise(request);
    if (request.context.role !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Workspace owner required');
    const result = await row(db, "UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND account_id = $2 AND role <> 'owner' RETURNING account_id AS id, role", [request.context.workspaceId, request.params.id, request.body.role]);
    if (!result) throw notFound('Editable member');
    return result;
  });
}
