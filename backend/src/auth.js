
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { row, rows } from './db.js';
import { ApiError, choice, invalid, notFound, object, route, text } from './http.js';

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
  return rows(db, 'SELECT w.id, w.name, w.kind, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.account_id = $1 AND m.state=\'active\' ORDER BY m.created_at, w.id', [accountId]);
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

async function insertWorkspaceAccount(connection, { email, passwordHash, displayName, type, workspaceName }) {
  const account = await row(connection, 'INSERT INTO accounts (id, email, password_hash, display_name, account_type) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name, account_type', [randomUUID(), email, passwordHash, displayName, type]);
  const workspaceId = randomUUID();
  await connection.query('INSERT INTO workspaces (id, kind, name) VALUES ($1, $2, $3)', [workspaceId, type, workspaceName]);
  await connection.query("INSERT INTO memberships (workspace_id, account_id, role) VALUES ($1, $2, 'owner')", [workspaceId, account.id]);
  await connection.query('INSERT INTO wallets (workspace_id, account_id) VALUES ($1, $2)', [workspaceId, account.id]);
  return account;
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
    const membership = await row(db, 'SELECT m.role, m.state, w.kind FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.account_id = $1 AND m.workspace_id = $2', [request.account.id, workspaceId]);
    if (!membership) throw notFound('Workspace');
    if (membership.state !== 'active') throw new ApiError(403, 'MEMBER_SUSPENDED', 'Workspace membership is suspended');
    request.context = { workspaceId, accountId: request.account.id, ...membership };
  });

  route(app, 'POST', '/v1/auth/register', {
    auth: false, tags, config: authLimit, summary: 'Register an account and create its initial workspace',
    body: object({
      email: emailSchema, password: passwordSchema, displayName: text(100),
      type: choice('personal', 'enterprise','agent'), workspaceName: text(100),
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
        const account = await insertWorkspaceAccount(connection, {
          email, passwordHash, displayName: display, type, workspaceName: workspaceName?.trim() || display,
        });
        return createSession(connection, account);
      });
      reply.code(201);
      return result;
    } catch (error) {
      if (error.code === '23505') throw new ApiError(409, 'EMAIL_IN_USE', 'Email is already registered');
      throw error;
    }
  });

  const standardLogin = object({ email: emailSchema, password: passwordSchema });
  route(app, 'POST', '/v1/auth/login', {
    auth: false, tags, config: authLimit, summary: 'Create a session',
    body: standardLogin,
  }, async request => {
    const email = normalizeEmail(request.body.email);
    const account = await row(db, 'SELECT * FROM accounts WHERE email = $1', [email]);
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

}
