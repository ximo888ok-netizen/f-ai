import { randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, array, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const root = '/v1/knowledge/bases/:id/categories';
const options = { tags: ['Knowledge'], params:object({id:uuid}) };
const categoryParams = object({id:uuid,categoryId:uuid});
const category = object({id:uuid,name:text(100)});
const nameSchema = object({name:text(100)});
const conflict = message => new ApiError(409,'KNOWLEDGE_CATEGORY_CONFLICT',message);

export async function lockKnowledgeBase(db, workspace, base) {
  const item = await row(db,'SELECT id FROM knowledge_bases WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspace,base]);
  if (!item) throw notFound('Knowledge base');
}

export async function ensureKnowledgeCategory(db, workspace, base, name) {
  if (name) await db.query(`INSERT INTO knowledge_categories(workspace_id,base_id,id,name) VALUES($1,$2,$3,$4)
    ON CONFLICT(base_id,name) DO NOTHING`,[workspace,base,randomUUID(),name]);
}

export function registerKnowledgeCategories(app, db, accessibleBase) {
  route(app,'GET',root,{...options,summary:'List categories within an authorized knowledge base',querystring:page,
    response:{200:object({items:array(category,100)})} },async request => {
    const {workspaceId}=request.context;
    const {id}=request.params;
    await accessibleBase(db,request.context,id);
    return {items:await rows(db,`SELECT id,name FROM knowledge_categories WHERE workspace_id=$1 AND base_id=$2
      ORDER BY name,id LIMIT $3 OFFSET $4`,[workspaceId,id,...paginate(request.query)])};
  });

  route(app,'POST',root,{...options,manager:true,summary:'Create or look up a named category in a knowledge base',
    body:nameSchema,response:{200:category} },request => db.transaction(async tx => {
    const {workspaceId}=request.context;
    const {id}=request.params;
    const name=request.body.name.trim();
    if (!name) throw invalid('Category name cannot be blank');
    await lockKnowledgeBase(tx,workspaceId,id);
    await ensureKnowledgeCategory(tx,workspaceId,id,name);
    return row(tx,'SELECT id,name FROM knowledge_categories WHERE workspace_id=$1 AND base_id=$2 AND name=$3',[workspaceId,id,name]);
  }));

  for (const method of ['PATCH','DELETE']) {
    const patch = method === 'PATCH';
    route(app,method,root+'/:categoryId',{
      ...options,manager:true,params:categoryParams,summary:patch?'Rename a category and its document labels':'Remove an unused category',
      ...(patch ? {body:nameSchema,response:{200:category}} : {response:{204:{type:'null'}}}),
    },async (request,reply) => {
      const value = await db.transaction(async tx => {
        const {workspaceId}=request.context;
        const {id,categoryId}=request.params;
        const key=[workspaceId,id,categoryId];
        await lockKnowledgeBase(tx,workspaceId,id);
        const current=await row(tx,'SELECT id,name FROM knowledge_categories WHERE workspace_id=$1 AND base_id=$2 AND id=$3',key);
        if (!current) throw notFound('Category');
        const categoryKey=[workspaceId,id,current.name];
        if (!patch) {
          if (await row(tx,'SELECT id FROM documents WHERE workspace_id=$1 AND base_id=$2 AND category=$3 LIMIT 1',categoryKey)) {
            throw conflict('Move the category documents before deleting this category');
          }
          await tx.query('DELETE FROM knowledge_categories WHERE workspace_id=$1 AND base_id=$2 AND id=$3',key);
          return null;
        }
        const name=request.body.name.trim();
        if (!name) throw invalid('Category name cannot be blank');
        if (name===current.name) return current;
        if (await row(tx,'SELECT id FROM knowledge_categories WHERE workspace_id=$1 AND base_id=$2 AND name=$3',[workspaceId,id,name])) {
          throw conflict('A category with that name already exists in this base');
        }
        await tx.query('UPDATE knowledge_categories SET name=$4 WHERE workspace_id=$1 AND base_id=$2 AND id=$3',[...key,name]);
        await tx.query('UPDATE documents SET category=$4 WHERE workspace_id=$1 AND base_id=$2 AND category=$3',[...categoryKey,name]);
        return {id:current.id,name};
      });
      if (patch) return value;
      reply.code(204).send();
    });
  }
}
