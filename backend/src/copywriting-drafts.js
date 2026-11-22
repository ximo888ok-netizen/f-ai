import { row, rows } from './db.js';
import { ApiError, array, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { lockPlugin } from './plugin-policy.js';

const root = '/v1/copywriting/drafts';
const tags = ['Copywriting drafts'];
const params = object({id:uuid});
const summary = {id:uuid,title:text(300),revision:integer(1,2147483647),
  sourceTaskId:{anyOf:[uuid,{type:'null'}]},updatedAt:{type:'string',format:'date-time'}};
const record = object({...summary,content:text(100000)});
const columns = 'id,title,revision,source_task_id AS "sourceTaskId",updated_at AS "updatedAt"';
const owned = 'workspace_id=$1 AND account_id=$2 AND id=$3';
const key = request => [request.context.workspaceId,request.context.accountId,request.params.id];
const changed = () => new ApiError(409,'COPY_DRAFT_CHANGED','Reload the latest draft before saving');

async function read(db, owner) {
  const draft = await row(db,'SELECT '+columns+',content FROM copywriting_drafts WHERE '+owned,owner);
  if (!draft) throw notFound('Copywriting draft');
  return draft;
}

export function registerCopywritingDrafts(app, db) {
  route(app,'GET',root,{tags,summary:'List owned copywriting drafts',querystring:page,
    response:{200:object({items:array(object(summary),100)})}},async request=>({
    items:await rows(db,'SELECT '+columns+' FROM copywriting_drafts WHERE workspace_id=$1 AND account_id=$2 '+
      'ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4',[request.context.workspaceId,request.context.accountId,...paginate(request.query)]),
  }));
  route(app,'GET',root+'/:id',{tags,params,summary:'Read an owned draft',response:{200:record}},
    request=>read(db,key(request)));
  route(app,'PUT',root+'/:id',{tags,params,summary:'Save edited copy or start from an owned completed copywriting task',
    body:object({revision:integer(0,2147483646),title:text(300),content:text(100000),sourceTaskId:uuid},['revision','title']),
    response:{200:record}},request=>db.transaction(async tx=>{
    const owner=key(request);
    const {revision,sourceTaskId}=request.body;
    const title=request.body.title.trim();
    let content=request.body.content;
    if (!title) throw invalid('Enter a draft title');
    if (revision>0 && (sourceTaskId || content===undefined)) throw invalid('Supply the edited content and preserve the original task reference');
    await lockPlugin(tx,owner[0],'copywriting');
    if (sourceTaskId) {
      const task=await row(tx,`SELECT result->>'text' AS content FROM tasks WHERE workspace_id=$1 AND account_id=$2 AND id=$3
        AND plugin_id='copywriting' AND state='succeeded' AND jsonb_typeof(result->'text')='string'`,[...owner.slice(0,2),sourceTaskId]);
      if (!task) throw notFound('Completed copywriting text task');
      content ??= task.content;
    }
    if (!content?.trim() || content.length>100000 || content.includes('\0')) throw invalid('Enter up to 100000 characters of copy');
    const values=[...owner,title,content];
    const saved=revision===0
      ? await row(tx,'INSERT INTO copywriting_drafts(workspace_id,account_id,id,title,content,source_task_id) '+
        'VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING '+columns+',content',[...values,sourceTaskId ?? null])
      : await row(tx,'UPDATE copywriting_drafts SET title=$4,content=$5,revision=revision+1,updated_at=now() WHERE '+
        owned+' AND revision=$6 RETURNING '+columns+',content',[...values,revision]);
    if (saved) return saved;
    const current=await read(tx,owner);
    if (current.revision===revision+1 && current.title===title && current.content===content &&
        (revision>0 || current.sourceTaskId===(sourceTaskId?.toLowerCase() ?? null))) return current;
    throw changed();
  }));
  route(app,'GET',root+'/:id/export',{tags,params,summary:'Download the requested draft revision as UTF-8 text',
    querystring:object({revision:integer(1,2147483647)}),produces:['text/plain']},async (request,reply)=>{
    const draft=await read(db,key(request));
    if (draft.revision!==request.query.revision) throw changed();
    return reply.header('content-disposition','attachment; filename="copy-'+draft.id+'-r'+draft.revision+'.txt"')
      .type('text/plain; charset=utf-8').send(Buffer.from(draft.content,'utf8'));
  });
}
