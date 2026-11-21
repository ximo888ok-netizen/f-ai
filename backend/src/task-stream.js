import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { row, rows } from './db.js';
import { ApiError, integer, invalid, notFound, object, route, uuid } from './http.js';
import { ProviderError } from './model-http.js';
import { maxTextChunks } from './model-stream.js';

const terminal=new Set(['succeeded','failed','cancelled']);
const maxConnections=48;
const endAfterMs=25000;
const pollDelayMs=400;

function event(name,data,id) {
  return (id===undefined?'':'id: '+id+'\n')+'event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n';
}

export async function appendTaskText(db,task,sequence,content) {
  const added=await row(db,`WITH owned AS (
    SELECT id FROM tasks WHERE id=$1 AND state='running' AND lease_id=$2 FOR UPDATE
  ) INSERT INTO task_text_chunks(task_id,sequence,content) SELECT id,$3,$4 FROM owned RETURNING sequence`,
    [task.id,task.lease_id,sequence,content]);
  if (!added) throw new ProviderError('TASK_LEASE_LOST');
}

function stateOf(task) {
  return {state:task.state,attempts:task.attempts,errorCode:task.errorCode};
}

export function registerTaskStream(app,findTask) {
  let active=0;
  route(app,'GET','/v1/tasks/:id/stream',{
    tags:['Tasks'],summary:'Follow streamed chat tokens and task state, with a reconnect cursor',
    params:object({id:uuid}),querystring:object({after:integer(0,maxTextChunks)},[]),
    produces:['text/event-stream'],
  },async (request,reply)=>{
    const last=request.headers['last-event-id'];
    if (last!==undefined && (typeof last!=='string' || !/^\d{1,4}$/.test(last) || Number(last)>maxTextChunks)) {
      throw invalid('Last-Event-ID is not a valid text cursor');
    }
    let cursor=request.query.after ?? Number(last ?? 0);
    if (active>=maxConnections) throw new ApiError(503,'TASK_STREAM_BUSY','Too many task streams are open');
    const db=await app.workspaceDatabaseRouter.forWorkspace(request.context.workspaceId);
    const columns=`id,state,attempts,error_code AS "errorCode",result,input->'parameters'->>'stream' AS streamed`;
    const lookup=()=>findTask(db,request.context,request.params.id,columns);
    let current=await lookup();
    if (current.streamed!=='true') throw notFound('Streamed task');
    if (active>=maxConnections) throw new ApiError(503,'TASK_STREAM_BUSY','Too many task streams are open');
    active++;
    const closed=new AbortController();
    reply.raw.once('close',()=>{closed.abort();active--;});
    const deadline=Date.now()+endAfterMs;
    async function* chunks() {
      let lastState;
      try {
        while (!closed.signal.aborted && Date.now()<deadline) {
          const state=stateOf(current);
          const serialized=JSON.stringify(state);
          if (lastState!==serialized) {
            yield event('state',state);
            lastState=serialized;
          }
          if (current.state==='running' || current.state==='succeeded') {
            const text=await rows(db,`SELECT sequence,content FROM task_text_chunks
              WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100`,[current.id,cursor]);
            for (const delta of text) {
              cursor=delta.sequence;
              yield event('delta',{text:delta.content},cursor);
            }
            if (text.length===100) continue;
          }
          if (terminal.has(current.state)) {
            yield event('done',{...state,result:current.result});
            return;
          }
          await delay(pollDelayMs,undefined,{signal:closed.signal});
          current=await lookup();
        }
        if (!closed.signal.aborted) yield event('reconnect',{after:cursor});
      } catch {
        if (!closed.signal.aborted) yield event('reconnect',{after:cursor});
      }
    }
    return reply.header('cache-control','no-store, no-transform').header('x-accel-buffering','no')
      .type('text/event-stream; charset=utf-8').send(Readable.from(chunks()));
  });
}
