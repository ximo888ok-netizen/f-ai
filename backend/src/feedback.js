import { row, rows } from './db.js';
import { ApiError, array, choice, invalid, object, page, paginate, route, text, uuid } from './http.js';

const tags = ['Workspace support'];
const feedback = '/v1/feedback';
const feedbackFields = {
  id: uuid, category: choice('issue','suggestion'), message: text(4000),
};
const feedbackRecord = object({ ...feedbackFields, createdAt: {type:'string',format:'date-time'} });
const columns = 'id,category,message,created_at AS "createdAt"';

export function registerFeedback(app, db) {
  route(app, 'GET', feedback, { tags, summary:'List feedback submitted by this workspace member', querystring:page,
    response: {200: object({items:array(feedbackRecord,100)})} }, async request => ({
    items:await rows(db,`SELECT ${columns} FROM workspace_feedback WHERE workspace_id=$1 AND account_id=$2
      ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,[request.context.workspaceId,request.context.accountId,...paginate(request.query)]),
  }));

  route(app, 'POST', feedback, { tags, summary:'Record private feedback with a client-assigned request ID', body:object(feedbackFields),
    response:{200:feedbackRecord,201:feedbackRecord} }, async (request,reply) => {
    const { workspaceId, accountId } = request.context;
    const { id,category } = request.body;
    const message = request.body.message.trim();
    if (!message) throw invalid('Feedback cannot be blank');
    const key = [workspaceId, accountId,id];
    const inserted = await row(db,`INSERT INTO workspace_feedback(workspace_id,account_id,id,category,message)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING ${columns}`,[...key,category,message]);
    if (inserted) {
      reply.code(201);
      return inserted;
    }
    const existing = await row(db,`SELECT ${columns} FROM workspace_feedback WHERE workspace_id=$1 AND account_id=$2 AND id=$3`,key);
    if (existing.category !== category || existing.message !== message) {
      throw new ApiError(409,'FEEDBACK_CONFLICT','The feedback ID is already in use');
    }
    return existing;
  });
}
