import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const root = '/v1/studio/pinduoduo-drafts';
const tags = ['Studio Products'];
const params = object({ id: uuid });
const summary = 'id, title, revision, updated_at AS "updatedAt"';
const fields = summary + ', category, description, specification, sku, price_minor AS "priceMinor", stock';
const numeric = { type: ['integer','null'], minimum: 0, maximum: 1000000000 };
const body = object({
  revision: integer(0, 2147483646), title: text(200), category: text(200, 0), description: text(8000, 0),
  specification: text(200, 0), sku: text(100, 0), priceMinor: numeric, stock: numeric,
  images: array(object({ role: choice('main','sku','detail'), assetId: uuid }), 22, 1),
}, ['revision','title','images']);

async function readDraft(db, key) {
  const draft = await row(db, `SELECT ${fields}, (
    SELECT jsonb_agg(jsonb_build_object('role',role,'assetId',asset_id) ORDER BY position)
    FROM listing_draft_images WHERE draft_id=listing_drafts.id
  ) AS images FROM listing_drafts WHERE workspace_id=$1 AND account_id=$2 AND id=$3`, key);
  if (!draft) throw notFound('Draft');
  return draft;
}

function normalized(input) {
  const title = input.title.trim();
  if (!title) throw invalid('Enter a product title');
  const images = input.images.map(({ role, assetId }) => ({ role, assetId: assetId.toLowerCase() }));
  if (images[0].role !== 'main' || images.filter(i => i.role === 'main').length !== 1 ||
      images.filter(i => i.role === 'sku').length > 1 || images.filter(i => i.role === 'detail').length > 20 ||
      new Set(images.map(i => i.role + i.assetId)).size !== images.length) {
    throw invalid('Choose one main image first, at most one SKU image and up to 20 distinct detail images');
  }
  return { title, category: input.category?.trim() ?? '', description: input.description?.trim() ?? '',
    specification: input.specification?.trim() ?? '', sku: input.sku?.trim() ?? '',
    priceMinor: input.priceMinor ?? null, stock: input.stock ?? null, images };
}

function matches(draft, values) {
  return Object.entries(values).every(([field, value]) => field === 'images'
    ? draft.images?.length === value.length && value.every((img, i) =>
      img.role === draft.images[i].role && img.assetId === draft.images[i].assetId)
    : draft[field] === value);
}

export function registerListingDrafts(app, db) {
  route(app, 'GET', root, { tags, summary: 'List own Pinduoduo drafts saved in Studio', querystring: page }, async request => ({
    items: await rows(db, `SELECT ${summary} FROM listing_drafts WHERE workspace_id=$1 AND account_id=$2
      ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`, [request.context.workspaceId, request.context.accountId, ...paginate(request.query)]),
  }));
  route(app, 'GET', root + '/:id', { tags, summary: 'Open a Studio draft with its ordered images', params }, request =>
    readDraft(db, [request.context.workspaceId, request.context.accountId, request.params.id]));
  route(app, 'PUT', root + '/:id', { tags, summary: 'Save a Studio draft at its expected revision (zero for new)', params, body }, async request => {
    const values = normalized(request.body);
    const key = [request.context.workspaceId, request.context.accountId, request.params.id];
    const args = [...key, values.title, values.category, values.description, values.specification, values.sku, values.priceMinor, values.stock];
    const expected = request.body.revision;
    return db.transaction(async tx => {
      const inserted = expected === 0 && await row(tx, `INSERT INTO listing_drafts
        (workspace_id,account_id,id,title,category,description,specification,sku,price_minor,stock)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING id`, args);
      if (!inserted) {
        const existing = await row(tx, 'SELECT revision FROM listing_drafts WHERE workspace_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE', key);
        if (!existing) throw notFound('Draft');
        if (existing.revision !== expected) {
          const current = await readDraft(tx, key);
          if (current.revision === expected + 1 && matches(current, values)) return current;
          throw new ApiError(409, 'DRAFT_CHANGED', 'The draft was edited in another session');
        }
      }
      const ids = [...new Set(values.images.map(img => img.assetId))];
      const assets = await rows(tx, `SELECT id, media_type FROM assets WHERE workspace_id=$1 AND account_id=$2
        AND id=ANY($3::uuid[]) ORDER BY id FOR KEY SHARE`, [key[0], key[1], ids]);
      if (assets.length !== ids.length) throw notFound('Asset');
      if (assets.some(asset => !['image/png','image/jpeg'].includes(asset.media_type))) throw invalid('Use JPEG or PNG images');
      if (!inserted) {
        await tx.query(`UPDATE listing_drafts SET title=$4,category=$5,description=$6,specification=$7,sku=$8,price_minor=$9,
          stock=$10,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND account_id=$2 AND id=$3`, args);
        await tx.query('DELETE FROM listing_draft_images WHERE draft_id=$1', [key[2]]);
      }
      for (const [i, image] of values.images.entries()) {
        await tx.query('INSERT INTO listing_draft_images (draft_id,position,role,asset_id) VALUES ($1,$2,$3,$4)',
          [key[2], i, image.role, image.assetId]);
      }
      return readDraft(tx, key);
    });
  });
}
