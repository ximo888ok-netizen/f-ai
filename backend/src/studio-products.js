
import { randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, array, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const tags = ['Studio Products'];
const idParams = object({ id: uuid });
const root = '/v1/studio';
const productFields = 'id, sku, name, description, category_id AS "categoryId", updated_at AS "updatedAt"';
const transferFields = 'id, direction, count, created_at AS "createdAt"';
const productInput = { sku: text(100), name: text(200), description: text(8000, 0) };
const portableProduct = { ...productInput, category: text(100, 0) };
const editProduct = object({ ...productInput, categoryId: { anyOf: [uuid, { type: 'null' }] } }, ['sku','name']);
const transfer = { reference: text(100, 8) };

function required(value) {
  const cleaned = value.trim();
  if (!cleaned) throw invalid('Name and SKU cannot be blank');
  return cleaned;
}

function cleanProduct(product) {
  return [required(product.sku), required(product.name), product.description?.trim() ?? ''];
}

function dbError(error) {
  if (error.code === '23505') throw new ApiError(409, 'IDENTIFIER_IN_USE', 'The SKU or category name is already in use');
  if (error.code === '23503') throw new ApiError(409, 'CATEGORY_CONFLICT', 'The category is missing or is still assigned');
  throw error;
}

async function writeProduct(db, workspace, input, id) {
  const args = [workspace, id ?? randomUUID(), ...cleanProduct(input), input.categoryId ?? null];
  try {
    const query = id
      ? 'UPDATE studio_products SET sku=$3, name=$4, description=$5, category_id=$6, updated_at=now() WHERE workspace_id=$1 AND id=$2'
      : 'INSERT INTO studio_products (workspace_id,id,sku,name,description,category_id) VALUES ($1,$2,$3,$4,$5,$6)';
    const item = await row(db, query + ' RETURNING ' + productFields, args);
    if (!item) throw notFound('Product');
    return item;
  } catch (error) { dbError(error); }
}

export function registerStudioProducts(app, db) {
  route(app, 'GET', root + '/categories', { tags, summary:'List workspace product categories', querystring:page }, async request => ({
    items: await rows(db, 'SELECT id,name FROM studio_categories WHERE workspace_id=$1 ORDER BY name,id LIMIT $2 OFFSET $3',
      [request.context.workspaceId, ...paginate(request.query)]),
  }));
  route(app, 'POST', root + '/categories', { tags, summary:'Create a workspace product category', manager:true, body:object({ name:text(100) }) }, async (request, reply) => {
    try {
      const item = await row(db, 'INSERT INTO studio_categories (id,workspace_id,name) VALUES ($1,$2,$3) RETURNING id,name',
        [randomUUID(), request.context.workspaceId, required(request.body.name)]);
      reply.code(201);
      return item;
    } catch (error) { dbError(error); }
  });
  route(app, 'PATCH', root + '/categories/:id', { tags, summary:'Rename a workspace product category', manager:true, params:idParams, body:object({ name:text(100) }) }, async request => {
    try {
      const item = await row(db, 'UPDATE studio_categories SET name=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id,name',
        [request.context.workspaceId, request.params.id, required(request.body.name)]);
      if (!item) throw notFound('Category');
      return item;
    } catch (error) { dbError(error); }
  });
  route(app, 'DELETE', root + '/categories/:id', { tags, summary:'Remove an unassigned product category', manager:true, params:idParams }, async (request, reply) => {
    try {
      const item = await row(db, 'DELETE FROM studio_categories WHERE workspace_id=$1 AND id=$2 RETURNING id',
        [request.context.workspaceId, request.params.id]);
      if (!item) throw notFound('Category');
      reply.code(204).send();
    } catch (error) { dbError(error); }
  });

  route(app, 'GET', root + '/products', { tags, summary:'List workspace product records', querystring:page }, async request => ({
    items: await rows(db, 'SELECT ' + productFields + ' FROM studio_products WHERE workspace_id=$1 ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3',
      [request.context.workspaceId, ...paginate(request.query)]),
  }));
  route(app, 'POST', root + '/products', { tags, summary:'Create a product with a distinct workspace SKU', manager:true, body:editProduct }, async (request, reply) => {
    const item = await writeProduct(db, request.context.workspaceId, request.body);
    reply.code(201);
    return item;
  });
  route(app, 'PUT', root + '/products/:id', { tags, summary:'Update a workspace product', manager:true, params:idParams, body:editProduct }, request =>
    writeProduct(db, request.context.workspaceId, request.body, request.params.id));
  route(app, 'DELETE', root + '/products/:id', { tags, summary:'Remove a workspace product', manager:true, params:idParams }, async (request, reply) => {
    const item = await row(db, 'DELETE FROM studio_products WHERE workspace_id=$1 AND id=$2 RETURNING id',
      [request.context.workspaceId, request.params.id]);
    if (!item) throw notFound('Product');
    reply.code(204).send();
  });

  route(app, 'GET', root + '/transfers', { tags, summary:'Read own import and export history', querystring:page }, async request => ({
    items: await rows(db, 'SELECT ' + transferFields + ' FROM studio_transfers WHERE workspace_id=$1 AND account_id=$2 ORDER BY created_at DESC,id LIMIT $3 OFFSET $4',
      [request.context.workspaceId, request.context.accountId, ...paginate(request.query)]),
  }));
  route(app, 'POST', root + '/products/import', {
    tags, summary:'Import a workspace catalog as one transaction', manager:true,
    body:object({ ...transfer, items:array(object(portableProduct, ['sku','name']), 100, 1) }),
  }, async (request, reply) => {
    const { workspaceId, accountId } = request.context;
    const { reference, items } = request.body;
    try {
      const imported = await db.transaction(async connection => {
        const record = await row(connection,
          "INSERT INTO studio_transfers (id,workspace_id,account_id,direction,count,reference) VALUES ($1,$2,$3,'import',$4,$5) ON CONFLICT DO NOTHING RETURNING " + transferFields,
          [randomUUID(), workspaceId, accountId, items.length, reference]);
        if (!record) throw new ApiError(409, 'IMPORT_ALREADY_SUBMITTED', 'This import reference has already been submitted');
        for (const product of items) {
          const name = product.category?.trim();
          const category = name && await row(connection,
            'INSERT INTO studio_categories (id,workspace_id,name) VALUES ($1,$2,$3) ON CONFLICT (workspace_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id',
            [randomUUID(), workspaceId, name]);
          await writeProduct(connection, workspaceId, { ...product, categoryId:category?.id });
        }
        return record;
      });
      reply.code(201);
      return imported;
    } catch (error) { dbError(error); }
  });
  route(app, 'POST', root + '/products/export', {
    tags, summary:'Export selected workspace products and log the download', body:object({ ...transfer, ids:array(uuid, 100, 1) }),
  }, request => db.transaction(async connection => {
    const { workspaceId, accountId } = request.context;
    const ids = [...new Set(request.body.ids)];
    const items = await rows(connection,
      "SELECT p.sku,p.name,p.description,COALESCE(c.name,'') AS category FROM studio_products p LEFT JOIN studio_categories c ON c.id=p.category_id AND c.workspace_id=p.workspace_id WHERE p.workspace_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY p.sku",
      [workspaceId, ids]);
    if (items.length !== ids.length) throw notFound('Product');
    await connection.query("INSERT INTO studio_transfers (id,workspace_id,account_id,direction,count,reference) VALUES ($1,$2,$3,'export',$4,$5) ON CONFLICT DO NOTHING",
      [randomUUID(), workspaceId, accountId, items.length, request.body.reference]);
    return { items };
  }));

  route(app, 'POST', root + '/roi', {
    tags, summary:'Calculate ad return and contribution from user-provided costs',
    body:object({ priceMinor:integer(0,100000000), unitCostMinor:integer(0,100000000), units:integer(1,1000000),
      feesMinor:integer(0,100000000), adSpendMinor:integer(1,100000000) }),
  }, async request => {
    const { priceMinor, unitCostMinor, units, feesMinor, adSpendMinor } = request.body;
    const revenueMinor = priceMinor * units;
    const productCostMinor = unitCostMinor * units;
    const contributionMinor = revenueMinor - productCostMinor - feesMinor - adSpendMinor;
    return { revenueMinor, productCostMinor, contributionMinor, roas: revenueMinor / adSpendMinor };
  });
}
