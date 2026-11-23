import { randomBytes, randomUUID } from 'node:crypto';
import { digest, getWorkspaces } from './auth.js';
import { row, rows } from './db.js';
import { ApiError, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { audit } from './merchant-audit.js';
import { recordMemberEvent } from './workspace-database.js';

const options = { manager: true, enterprise: true, database: 'identity', tags: ['Merchant members'] };
const role = choice('admin', 'member');
const state = choice('active', 'suspended');
const email = { ...text(254, 3), format: 'email' };
const inviteToken = { ...text(43, 43), pattern: '^[A-Za-z0-9_-]+$' };
const idParams = object({ id: uuid });
const date = { type: 'string', format: 'date-time' };
const invitationFields = `id,email,role,revision,created_at AS "createdAt",expires_at AS "expiresAt",
  CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked'
    WHEN expires_at<=now() THEN 'expired' ELSE 'pending' END AS status`;

function requireOwner(context) {
  if (context.role !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Workspace owner required');
}

async function workspaceMember(tx, request) {
  const member = await row(tx, `SELECT account_id AS id,role,state FROM memberships
    WHERE workspace_id=$1 AND account_id=$2 AND role<>'owner' FOR UPDATE`,
  [request.context.workspaceId, request.params.id]);
  if (!member) throw notFound('Editable member');
  if (member.role === 'admin') requireOwner(request.context);
  return member;
}

async function changeMember(db, request, field) {
  return db.transaction(async tx => {
    const { workspaceId } = request.context;
    const member = await workspaceMember(tx, request);
    const next = request.body[field];
    if (member[field] !== next) {
      const sql = field === 'role'
        ? 'UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND account_id=$2'
        : 'UPDATE memberships SET state=$3 WHERE workspace_id=$1 AND account_id=$2';
      await tx.query(sql, [workspaceId, member.id, next]);
      const action = 'member.' + field + '-changed';
      const detail = { previous: member[field], current: next };
      // Preserve the member-facing role event shape.
      const notification = field === 'role' ? { previousRole: member.role, role: next } : { state: next };
      await recordMemberEvent(tx, workspaceId, member.id, action, action + ':' + randomUUID(), notification);
      await audit(tx, request, 'identity', action, member.id, detail);
    }
    return { ...member, [field]: next };
  });
}

const lockAddress = (tx, workspace, address) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtext($1),401927)', [workspace + ':' + address]);

async function insertInvitation(tx, request, address, invitedRole) {
  const workspace = request.context.workspaceId;
  // Serialize creation for the same address before expiring any previous link.
  await lockAddress(tx, workspace, address);
  if (await row(tx, `SELECT 1 FROM accounts a JOIN memberships m ON m.account_id=a.id
    WHERE m.workspace_id=$1 AND a.email=$2`, [workspace, address])) {
    throw new ApiError(409, 'ALREADY_MEMBER', 'This account already belongs to the workspace');
  }
  await tx.query(`UPDATE invitations SET revoked_at=now()
    WHERE workspace_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=now()`, [workspace, address]);
  const token = randomBytes(32).toString('base64url');
  const invitation = await row(tx, `INSERT INTO invitations(token_hash,workspace_id,email,role,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '48 hours') ON CONFLICT DO NOTHING RETURNING id,revision,expires_at AS "expiresAt"`,
  [digest(token), workspace, address, invitedRole]);
  if (!invitation) throw new ApiError(409, 'INVITATION_PENDING', 'A pending invitation already exists');
  await audit(tx, request, 'identity', 'invitation.created', invitation.id, { role: invitedRole });
  return { ...invitation, token };
}

async function acceptInvitation(db, request) {
  return db.transaction(async tx => {
    const hash = digest(request.body.token);
    const address = request.account.email;
    const candidate = await row(tx, 'SELECT workspace_id FROM invitations WHERE token_hash=$1 AND email=$2', [hash, address]);
    if (!candidate) throw notFound('Invitation');
    await lockAddress(tx, candidate.workspace_id, address);
    const invitation = await row(tx, `SELECT id,workspace_id,role FROM invitations WHERE token_hash=$1 AND email=$2
      AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`, [hash, address]);
    if (!invitation) throw notFound('Invitation');
    const workspace = invitation.workspace_id;
    const member = await row(tx, `INSERT INTO memberships(workspace_id,account_id,role) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,account_id) DO NOTHING RETURNING role`, [workspace, request.account.id, invitation.role]);
    const existing = member ?? await row(tx, 'SELECT state FROM memberships WHERE workspace_id=$1 AND account_id=$2', [workspace, request.account.id]);
    if (existing?.state === 'suspended') throw new ApiError(403, 'MEMBER_SUSPENDED', 'Workspace membership is suspended');
    await tx.query(`INSERT INTO wallets(workspace_id,account_id)
      SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM workspace_database_routes WHERE workspace_id=$1)
      ON CONFLICT(workspace_id,account_id) DO NOTHING`, [workspace, request.account.id]);
    await tx.query('UPDATE invitations SET accepted_at=now() WHERE id=$1', [invitation.id]);
    if (member) await recordMemberEvent(tx, workspace, request.account.id, 'member.joined', 'member:join:' + workspace, { role: member.role });
    const actor = { id: request.id, context: { workspaceId: workspace, accountId: request.account.id } };
    await audit(tx, actor, 'identity', 'invitation.accepted', invitation.id, { role: invitation.role });
    return { workspaceId: workspace, workspaces: await getWorkspaces(tx, request.account.id) };
  });
}

async function updateInvitation(db, request) {
  const { workspaceId } = request.context;
  return db.transaction(async tx => {
    const id = request.params.id;
    const invitation = await row(tx, `SELECT role,token_hash,accepted_at,revoked_at,revision,expires_at AS "expiresAt"
      FROM invitations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, id]);
    if (!invitation) throw notFound('Invitation');
    if (invitation.role === 'admin') requireOwner(request.context);
    if (invitation.accepted_at) throw new ApiError(409, 'INVITATION_USED', 'The invitation was already accepted');
    if (request.method === 'DELETE') {
      if (!invitation.revoked_at) {
        await tx.query('UPDATE invitations SET revoked_at=now() WHERE id=$1', [id]);
        await audit(tx, request, 'identity', 'invitation.revoked', id, {});
      }
      return null;
    }
    if (invitation.revoked_at) throw new ApiError(409, 'INVITATION_REVOKED', 'Create a new invitation for this address');
    const { token, revision } = request.body;
    const hash = digest(token);
    if (invitation.token_hash === hash) return { id, token, revision: invitation.revision, expiresAt: invitation.expiresAt };
    if (invitation.revision !== revision) {
      throw new ApiError(409, 'INVITATION_CHANGED', 'Reload invitation before replacing its token');
    }
    const renewed = await row(tx, `UPDATE invitations SET token_hash=$2,expires_at=now()+interval '48 hours',revision=revision+1
      WHERE id=$1 RETURNING revision,expires_at AS "expiresAt"`, [id, hash]);
    await audit(tx, request, 'identity', 'invitation.renewed', id, {});
    return { id, token, ...renewed };
  }).catch(error => {
    if (error.code === '23505') throw new ApiError(409, 'INVITATION_TOKEN_CONFLICT', 'Generate a different invitation token');
    throw error;
  });
}

export function registerMerchantMembers(app, db) {
  route(app, 'GET', '/v1/members', {
    ...options, summary: 'List workspace members',
    querystring: object({ ...page.properties, q: text(100), role: choice('owner', 'admin', 'member'), state }, []),
  }, async request => ({
    items: await rows(db, `SELECT a.id,a.email,a.display_name AS "displayName",m.role,m.state
      FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.workspace_id=$1
      AND ($2::text IS NULL OR strpos(lower(a.email || ' ' || a.display_name),lower($2))>0)
      AND ($3::text IS NULL OR m.role=$3) AND ($4::text IS NULL OR m.state=$4)
      ORDER BY m.created_at,a.id LIMIT $5 OFFSET $6`, [request.context.workspaceId,
      request.query.q?.trim() || null, request.query.role ?? null, request.query.state ?? null, ...paginate(request.query)]),
  }));

  route(app, 'PATCH', '/v1/members/:id', {
    ...options, params: idParams, body: object({ role }), summary: 'Change a member role',
  }, request => {
    requireOwner(request.context);
    return changeMember(db, request, 'role');
  });

  route(app, 'PATCH', '/v1/members/:id/state', {
    ...options, params: idParams, body: object({ state }), summary: 'Suspend or restore membership',
    response: { 200: object({ id: uuid, role, state }) },
  }, request => changeMember(db, request, 'state'));

  route(app, 'POST', '/v1/invitations', {
    ...options, body: object({ email, role }), summary: 'Create a one-time invitation',
  }, async (request, reply) => {
    const address = request.body.email.trim().toLowerCase();
    if (!address) throw invalid('Specify an email address');
    if (request.body.role === 'admin') requireOwner(request.context);
    const result = await db.transaction(tx => insertInvitation(tx, request, address, request.body.role));
    return reply.code(201).send(result);
  });

  route(app, 'GET', '/v1/invitations', { ...options, querystring: page, summary: 'List invitation states' }, async request => ({
    items: await rows(db, `SELECT ${invitationFields} FROM invitations WHERE workspace_id=$1
      ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, [request.context.workspaceId, ...paginate(request.query)]),
  }));

  route(app, 'POST', '/v1/invitations/accept', {
    tenant: false, tags: ['Identity'], body: object({ token: inviteToken }), summary: 'Accept an invitation',
  }, request => acceptInvitation(db, request));

  route(app, 'DELETE', '/v1/invitations/:id', {
    ...options, params: idParams, summary: 'Revoke an invitation',
  }, async (request, reply) => {
    await updateInvitation(db, request);
    return reply.code(204).send();
  });

  route(app, 'PUT', '/v1/invitations/:id/token', {
    ...options, params: idParams, body: object({ token: inviteToken, revision: integer(0, 2147483646) }), summary: 'Replace and extend an invitation token',
    response: { 200: object({ id: uuid, token: inviteToken, revision: integer(0, 2147483647), expiresAt: date }) },
  }, request => updateInvitation(db, request));
}
