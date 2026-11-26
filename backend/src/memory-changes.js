import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, page, paginate, requireManager, route, text, uuid } from './http.js';

const path = '/v1/memory/:id/changes';
const revision = integer(0, 2147483646);
const change = object({ revision, action: choice('update','undo'), actorId: uuid, createdAt: {type:'string',format:'date-time'} });
const columns = 'revision,action,actor_id AS "actorId",created_at AS "createdAt"';

async function visible(db, request, lock = false) {
  const {workspaceId, accountId, kind} = request.context;
  const item = await row(db, 'SELECT id,content,revision,scope FROM memory_items WHERE workspace_id=$1 AND id=$2 ' +
    "AND ((scope='personal' AND account_id=$3) OR (scope='enterprise' AND $4))" + (lock ? ' FOR UPDATE' : ''),
    [workspaceId, request.params.id, accountId, kind === 'enterprise']);
  if (!item) throw notFound('Memory');
  return item;
}

export function registerMemoryChanges(app, db) {
  const options = { tags:['Memory'], params:object({id:uuid}) };
  route(app, 'GET', path, {...options, summary:'List scoped memory revisions',querystring:page,
    response:{200:object({items:array(change,100)})}}, async request => {
    await visible(db, request);
    return {items:await rows(db, 'SELECT '+columns+' FROM memory_changes WHERE item_id=$1 ORDER BY revision DESC LIMIT $2 OFFSET $3',
      [request.params.id,...paginate(request.query)])};
  });
  route(app, 'PUT', path+'/:requestId', {...options, params:object({id:uuid,requestId:uuid}),
    summary:'Confirm a memory update or undo the latest update',
    body:object({revision,action:choice('update','undo'),content:text(10000)},['revision','action']),
    response:{200:change}}, request => db.transaction(async tx => {
    const item = await visible(tx, request, true);
    if (item.scope === 'enterprise') requireManager(request);
    const {revision:base, action, content} = request.body;
    if (action === 'update' ? !content?.trim() : content !== undefined) throw invalid('Supply text only for an update');
    const {requestId} = request.params;
    const actor = request.context.accountId;
    const replay = await row(tx,'SELECT '+columns+' FROM memory_changes WHERE item_id=$1 AND request_id=$2',[item.id,requestId]);
    if (replay) {
      // The next change saved the resulting text as its previous value.
      const result = replay.revision === item.revision ? item.content :
        (await row(tx,'SELECT previous_content FROM memory_changes WHERE item_id=$1 AND revision=$2',[item.id,replay.revision+1])).previous_content;
      if (replay.actorId === actor && replay.revision === base+1 && replay.action === action && (action === 'undo' || result === content.trim())) return replay;
      throw new ApiError(409,'MEMORY_REQUEST_CONFLICT','This request ID was used for another change');
    }
    if (item.revision !== base) throw new ApiError(409,'MEMORY_REVISION_CONFLICT','Reload the current revision');
    let value = content?.trim();
    if (action === 'undo') {
      const last = await row(tx,'SELECT action,previous_content FROM memory_changes WHERE item_id=$1 AND revision=$2',[item.id,base]);
      if (last?.action !== 'update') throw new ApiError(409,'MEMORY_UNDO_UNAVAILABLE','Only the latest update can be undone');
      value = last.previous_content;
    }
    if (value === item.content) throw invalid('The update must change the text');
    const record = await row(tx,'INSERT INTO memory_changes(item_id,revision,request_id,actor_id,action,previous_content) '+
      'VALUES($1,$2,$3,$4,$5,$6) RETURNING '+columns,[item.id,base+1,requestId,actor,action,item.content]);
    await tx.query('UPDATE memory_items SET content=$2,revision=$3 WHERE id=$1',[item.id,value,base+1]);
    return record;
  }));
}
