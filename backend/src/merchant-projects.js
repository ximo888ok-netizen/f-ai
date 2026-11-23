import { randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, choice, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { audit } from './merchant-audit.js';

const tags = ['Projects'];
const idParams = object({ id: uuid });
const fields = 'id,name,archived_at AS "archivedAt",created_at AS "createdAt"';
const canManage = context => context.role !== 'member';
const projectState = choice('active', 'archived');

function nameOf(input) {
  const name = input.trim();
  if (!name) throw invalid('Project name cannot be blank');
  return name;
}

export async function accessibleProject(db, context, projectId, active = false, lock = false) {
  if (!projectId) return null;
  const result = await row(db, `SELECT ${fields} FROM projects p WHERE p.workspace_id=$1 AND p.id=$2
    AND ($3::boolean OR EXISTS (SELECT 1 FROM project_members m WHERE m.workspace_id=p.workspace_id AND m.project_id=p.id AND m.account_id=$4))`
    + (lock ? ' FOR SHARE OF p' : ''), [context.workspaceId, projectId, canManage(context), context.accountId]);
  if (!result) throw notFound('Project');
  if (active && result.archivedAt) throw new ApiError(409, 'PROJECT_ARCHIVED', 'Project has been archived');
  return result;
}

export function registerProjects(app, db) {
  route(app, 'GET', '/v1/projects', {
    tags, summary: 'List visible projects', querystring: object({ ...page.properties, state: choice('active', 'archived', 'all') }, []),
  }, async request => ({
    items: await rows(db, `SELECT ${fields} FROM projects p WHERE workspace_id=$1
      AND ($3::boolean OR EXISTS (SELECT 1 FROM project_members m WHERE m.workspace_id=p.workspace_id AND m.project_id=p.id AND m.account_id=$2))
      AND ($4='all' OR ($4='archived')=(archived_at IS NOT NULL)) ORDER BY created_at DESC,id LIMIT $5 OFFSET $6`,
    [request.context.workspaceId, request.context.accountId, canManage(request.context), request.query.state ?? 'active', ...paginate(request.query)]),
  }));

  route(app, 'POST', '/v1/projects', {
    manager: true, tags, body: object({ name: text(120) }), summary: 'Create a project',
  }, async (request, reply) => {
    const project = await db.transaction(async tx => {
      const result = await row(tx, 'INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3) RETURNING ' + fields,
        [randomUUID(), request.context.workspaceId, nameOf(request.body.name)]);
      await audit(tx, request, 'workspace', 'project.created', result.id, {});
      return result;
    });
    return reply.code(201).send(project);
  });

  route(app, 'GET', '/v1/projects/:id', { tags, params: idParams, summary: 'Get a visible project' },
    request => accessibleProject(db, request.context, request.params.id));

  route(app, 'PATCH', '/v1/projects/:id', {
    manager: true, tags, params: idParams, body: object({ name: text(120), state: projectState }, []),
    summary: 'Rename, archive, or restore a project',
  }, request => db.transaction(async tx => {
    const { name, state } = request.body;
    if (name === undefined && state === undefined) throw invalid('Specify a name or state');
    const lookup = [request.context.workspaceId, request.params.id];
    const current = await row(tx, 'SELECT ' + fields + ' FROM projects WHERE workspace_id=$1 AND id=$2 FOR UPDATE', lookup);
    if (!current) throw notFound('Project');
    const nextName = name === undefined ? current.name : nameOf(name);
    const wasArchived = Boolean(current.archivedAt);
    const archive = state === undefined ? wasArchived : state === 'archived';
    if (nextName === current.name && archive === wasArchived) return current;
    const updated = await row(tx, `UPDATE projects SET name=$3,archived_at=CASE
      WHEN $4 THEN COALESCE(archived_at,now()) ELSE NULL END WHERE workspace_id=$1 AND id=$2 RETURNING ` + fields,
    [...lookup, nextName, archive]);
    await audit(tx, request, 'workspace', 'project.updated', updated.id, { archived: archive, renamed: current.name !== nextName });
    return updated;
  }));

  route(app, 'GET', '/v1/projects/:id/members', {
    manager: true, enterprise: true, tags, params: idParams, querystring: page, summary: 'List project access grants',
  }, async request => {
    await accessibleProject(db, request.context, request.params.id);
    return { items: await rows(db, `SELECT a.id,a.display_name AS "displayName",m.role,m.state
      FROM project_members p JOIN memberships m ON (m.workspace_id,m.account_id)=(p.workspace_id,p.account_id)
      JOIN accounts a ON a.id=p.account_id WHERE p.workspace_id=$1 AND p.project_id=$2
      ORDER BY a.display_name,a.id LIMIT $3 OFFSET $4`, [request.context.workspaceId, request.params.id, ...paginate(request.query)]) };
  });

  route(app, ['PUT', 'DELETE'], '/v1/projects/:id/members/:memberId', {
    manager: true, enterprise: true, tags, params: object({ id: uuid, memberId: uuid }), summary: 'Grant or remove project access',
  }, async (request, reply) => {
    await db.transaction(async tx => {
      const { workspaceId } = request.context;
      const { id, memberId } = request.params;
      const project = await row(tx, 'SELECT archived_at FROM projects WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, id]);
      if (!project) throw notFound('Project');
      const grant = request.method === 'PUT';
      if (grant && project.archived_at) throw new ApiError(409, 'PROJECT_ARCHIVED', 'Project has been archived');
      if (grant && !await row(tx, "SELECT 1 FROM memberships WHERE workspace_id=$1 AND account_id=$2 AND state='active'", [workspaceId, memberId])) {
        throw notFound('Active workspace member');
      }
      const sql = grant
        ? 'INSERT INTO project_members(workspace_id,project_id,account_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING account_id'
        : 'DELETE FROM project_members WHERE workspace_id=$1 AND project_id=$2 AND account_id=$3 RETURNING account_id';
      if (await row(tx, sql, [workspaceId, id, memberId])) {
        await audit(tx, request, 'workspace', grant ? 'project.access-granted' : 'project.access-revoked', id, { memberId });
      }
    });
    return reply.code(204).send();
  });
}
