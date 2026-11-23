import { rows } from './db.js';
import { array, bool, choice, integer, invalid, object, page, paginate, route, text, uuid } from './http.js';

const eventLevels = ['info','warn','error'];
const states = ['queued','running','provider_pending','retrying','succeeded','failed','cancelled'];
const timestamp = {type:'string',format:'date-time'};
export const eventCursor = {type:'string',pattern:'^(0|[1-9][0-9]{0,18})$',
  description:'Decimal task event ID. Use 0 to start from the first event.'};
const eventRecord = object({ id: text(24), event: choice(...states), level: choice(...eventLevels),
  attempt: integer(0,2147483647), errorCode:{ type:['string','null'] }, createdAt:timestamp });
const taskEvent = object({...eventRecord.properties,taskId:uuid,retryable:bool});

export async function logTask(db, taskId, event, attempt, errorCode = null) {
  const code = errorCode && !/^[A-Z0-9_]{1,80}$/.test(errorCode) ? 'TASK_EXECUTION_ERROR' : errorCode;
  const level = event === 'failed' ? 'error' : event === 'retrying' ? 'warn' : 'info';
  await db.query('INSERT INTO task_events(task_id,event,level,attempt,error_code) VALUES($1,$2,$3,$4,$5)',
    [taskId,event,level,attempt,code]);
}

export function registerTaskEvents(app, db, readTask) {
  route(app,'GET','/v1/diagnostics/task-events',{tags:['Workspace support'],manager:true,
    summary:'Search committed workspace task events by task, severity and time',
    querystring:object({...page.properties,taskId:uuid,level:choice(...eventLevels),from:timestamp,to:timestamp},[]),
    response:{200:object({items:array(object({...eventRecord.properties,taskId:uuid}),100)})}},async request=>{
    const {taskId,level,from,to}=request.query;
    if (from && to && Date.parse(from)>Date.parse(to)) throw invalid('Invalid event time range');
    return {items:await rows(db,`SELECT e.id::text,e.task_id AS "taskId",e.event,e.level,e.attempt,e.error_code AS "errorCode",e.created_at AS "createdAt"
      FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.workspace_id=$1 AND ($2::uuid IS NULL OR e.task_id=$2)
      AND ($3::text IS NULL OR e.level=$3) AND ($4::timestamptz IS NULL OR e.created_at >= $4)
      AND ($5::timestamptz IS NULL OR e.created_at <= $5) ORDER BY e.created_at DESC,e.id DESC LIMIT $6 OFFSET $7`,
    [request.context.workspaceId,taskId ?? null,level ?? null,from ?? null,to ?? null,...paginate(request.query)])};
  });
  route(app, 'GET', '/v1/tasks/:id/events', { tags:['Tasks'], summary:'List or resume polling task lifecycle events for the current member',
    params:object({id:uuid}), querystring:object({ ...page.properties, after:eventCursor, level:choice(...eventLevels), from:timestamp, to:timestamp },[]),
    response:{200:object({items:array(taskEvent,100),nextCursor:eventCursor},['items'])} }, async request => {
    const {after,level,from,to} = request.query;
    if (from && to && Date.parse(from)>Date.parse(to)) throw invalid('Invalid event time range');
    if (after !== undefined && (BigInt(after)>9223372036854775807n || request.query.offset)) {
      throw invalid('Use a valid event cursor without a nonzero offset');
    }
    const task = await readTask(db,request.context,request.params.id);
    const history = await rows(db,`SELECT id::text,event,level,attempt,error_code AS "errorCode",created_at AS "createdAt"
      FROM task_events WHERE task_id=$1 AND ($2::text IS NULL OR level=$2)
      AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at <= $4)
      AND ($5::bigint IS NULL OR id > $5) AND id <= $6::bigint
      ORDER BY task_events.id ${after === undefined ? 'DESC' : 'ASC'} LIMIT $7 OFFSET $8`,
    [task.id,level ?? null,from ?? null,to ?? null,after ?? null,task.eventCursor,...paginate(request.query)]);
    const items = history.map(event => ({...event,taskId:task.id,
      retryable:Boolean(task.imagePlan?.canRetry) && ['failed','cancelled'].includes(event.event)}));
    return after === undefined ? {items} : {items,nextCursor:items.at(-1)?.id ?? after};
  });
}
