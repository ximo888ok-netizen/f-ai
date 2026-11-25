import { row, rows } from './db.js';
import { lockPlugin } from './plugin-policy.js';
import { ApiError, array, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const root = '/v1/studio/pinduoduo-drafts';
const tags = ['Studio Products'];
const params = object({ id: uuid });
const summary = 'id, title, revision, updated_at AS "updatedAt"';
const fields = summary + ', category, description, specification, sku, price_minor AS "priceMinor", stock';
const numeric = { type: ['integer','null'], minimum: 0, maximum: 1000000000 };
const variant = object({
  specification: text(200), sku: text(100, 0), priceMinor: numeric, stock: numeric,
  assetId: { anyOf: [uuid, { type: 'null' }] },
}, ['specification']);
const variantsJson = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object('specification',v.specification,'sku',v.sku,'priceMinor',v.price_minor,
    'stock',v.stock,'assetId',v.asset_id) ORDER BY v.position)
  FROM listing_draft_variants v WHERE v.draft_id=listing_drafts.id
), '[]'::jsonb)`;
const body = object({
  revision: integer(0, 2147483646), title: text(200), category: text(200, 0), description: text(8000, 0),
  specification: text(200, 0), sku: text(100, 0), priceMinor: numeric, stock: numeric,
  variants: array(variant, 49),
  images: array(object({ role: choice('main','sku','detail'), assetId: uuid }), 22, 1),
}, ['revision','title','images']);

export async function readDraft(db, key) {
  const draft = await row(db, `SELECT ${fields}, (
    SELECT jsonb_agg(jsonb_build_object('role',role,'assetId',asset_id) ORDER BY position)
    FROM listing_draft_images WHERE draft_id=listing_drafts.id
  ) AS images, ${variantsJson} AS variants FROM listing_drafts WHERE workspace_id=$1 AND account_id=$2 AND id=$3`, key);
  if (!draft) throw notFound('Draft');
  return draft;
}

function normalized(input) {
  const title = input.title.trim();
  if (!title) throw invalid('Enter a product title');
  const images = normalizeDraftImages(input.images);
  return { title, category: input.category?.trim() ?? '', description: input.description?.trim() ?? '',
    specification: input.specification?.trim() ?? '', sku: input.sku?.trim() ?? '',
    priceMinor: input.priceMinor ?? null, stock: input.stock ?? null, images };
}

function normalizeDraftImages(entries) {
  const images = entries.map(({ role, assetId }) => ({ role, assetId: assetId.toLowerCase() }));
  if (images[0].role !== 'main' || images.filter(i => i.role === 'main').length !== 1 ||
      images.filter(i => i.role === 'sku').length > 1 || images.filter(i => i.role === 'detail').length > 20 ||
      new Set(images.map(i => i.role + i.assetId)).size !== images.length) {
    throw invalid('Choose one main image first, at most one SKU image and up to 20 distinct detail images');
  }
  return images;
}

async function verifyImageAssets(db, key, entries) {
  const ids = [...new Set(entries.map(image => image.assetId).filter(Boolean))];
  const assets = await rows(db, `SELECT id, media_type FROM assets WHERE workspace_id=$1 AND account_id=$2
    AND id=ANY($3::uuid[]) AND NOT rights_restricted ORDER BY id FOR SHARE`, [key[0], key[1], ids]);
  if (assets.length !== ids.length) throw notFound('Asset');
  if (assets.some(asset => !['image/png','image/jpeg'].includes(asset.media_type))) throw invalid('Use JPEG or PNG images');
}

async function writeImages(db, draftId, images) {
  for (const [position, image] of images.entries()) {
    await db.query('INSERT INTO listing_draft_images (draft_id,position,role,asset_id) VALUES ($1,$2,$3,$4)',
      [draftId, position, image.role, image.assetId]);
  }
}

async function lockDraft(db, key) {
  const lock = await row(db, 'SELECT id FROM listing_drafts WHERE workspace_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE', key);
  if (!lock) throw notFound('Draft');
  return readDraft(db, key);
}

export async function applyDraftImages(db, key, revision, {main, details}) {
  await lockPlugin(db, key[0], 'operations');
  const draft = await lockDraft(db, key);
  const images = normalizeDraftImages([main, ...draft.images.filter(image => image.role === 'sku'), ...details]);
  if (draft.revision !== revision) {
    if (draft.revision === revision + 1 && matches(draft, {images})) return draft;
    throw new ApiError(409, 'DRAFT_CHANGED', 'The draft was edited in another session');
  }
  await verifyImageAssets(db, key, images);
  if (matches(draft, {images})) return draft;
  await db.query(`UPDATE listing_drafts SET revision=revision+1,updated_at=now()
    WHERE workspace_id=$1 AND account_id=$2 AND id=$3`, key);
  await db.query('DELETE FROM listing_draft_images WHERE draft_id=$1', [key[2]]);
  await writeImages(db, key[2], images);
  return readDraft(db, key);
}

function normalizeVariants(variants) {
  return variants.map(v => ({
    specification: v.specification.trim(), sku: v.sku?.trim() ?? '',
    priceMinor: v.priceMinor ?? null, stock: v.stock ?? null, assetId: v.assetId?.toLowerCase() ?? null,
  }));
}

function validateVariants(primary, variants) {
  if (variants.some(v => !v.specification)) throw invalid('每个附加规格都需要填写规格名称');
  const all = [primary, ...variants];
  for (const [key, label] of [['specification', '规格名称'], ['sku', '商家 SKU']]) {
    const keys = all.map(v => v[key].toLowerCase()).filter(Boolean);
    if (new Set(keys).size !== keys.length) throw invalid(label + '在同一商品草稿内不能重复');
  }
}

function matches(draft, values) {
  return Object.entries(values).every(([field, value]) => {
    if (!Array.isArray(value)) return draft[field] === value;
    const saved = draft[field];
    return saved.length === value.length && value.every((entry, i) =>
      Object.entries(entry).every(([key, expected]) => saved[i][key] === expected));
  });
}

export function variantCheck(v) {
  const missing = [];
  if (!v.sku) missing.push('商家 SKU');
  if (v.priceMinor === null) missing.push('售价');
  if (v.stock === null) missing.push('库存');
  return { specification: v.specification, missing };
}

export function registerListingDrafts(app, db) {
  route(app, 'GET', root, { tags, summary: 'List own Pinduoduo drafts saved in Studio', querystring: page }, async request => ({
    items: await rows(db, `SELECT ${summary} FROM listing_drafts WHERE workspace_id=$1 AND account_id=$2
      ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`, [request.context.workspaceId, request.context.accountId, ...paginate(request.query)]),
  }));
  route(app, 'GET', root + '/quality', { tags, summary: 'Check own Studio drafts for missing product information', querystring: page }, async request => ({
    items: (await rows(db, `SELECT id,title,${variantsJson} AS variants,array_remove(ARRAY[
      CASE WHEN category='' THEN '类目' END, CASE WHEN specification='' THEN '规格' END,
      CASE WHEN sku='' THEN '商家 SKU' END, CASE WHEN price_minor IS NULL THEN '售价' END,
      CASE WHEN stock IS NULL THEN '库存' END, CASE WHEN description='' THEN '商品描述' END,
      CASE WHEN NOT EXISTS (SELECT 1 FROM listing_draft_images i WHERE i.draft_id=listing_drafts.id AND i.role='detail') THEN '详情图' END
    ],NULL) AS missing FROM listing_drafts WHERE workspace_id=$1 AND account_id=$2
    ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`, [request.context.workspaceId,request.context.accountId,...paginate(request.query)]))
      .map(({ variants, ...draft }) => ({ ...draft, variantChecks: variants.map(variantCheck) })),
  }));
  route(app, 'GET', root + '/:id', { tags, summary: 'Open a Studio draft with its ordered images', params }, request =>
    readDraft(db, [request.context.workspaceId, request.context.accountId, request.params.id]));
  route(app, 'PUT', root + '/:id', { tags, summary: 'Save a Studio draft at its expected revision (zero for new)', params, body }, async request => {
    const values = normalized(request.body);
    const submittedVariants = request.body.variants === undefined ? undefined : normalizeVariants(request.body.variants);
    const key = [request.context.workspaceId, request.context.accountId, request.params.id];
    const args = [...key, values.title, values.category, values.description, values.specification, values.sku, values.priceMinor, values.stock];
    const expected = request.body.revision;
    return db.transaction(async tx => {
      await lockPlugin(tx,key[0],'operations');
      const inserted = expected === 0 && await row(tx, `INSERT INTO listing_drafts
        (workspace_id,account_id,id,title,category,description,specification,sku,price_minor,stock)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING id`, args);
      let current;
      if (!inserted) {
        current = await lockDraft(tx, key);
      }
      const variants = submittedVariants ?? current?.variants ?? [];
      if (current && current.revision !== expected) {
        if (current.revision === expected + 1 && matches(current, { ...values, variants })) return current;
        throw new ApiError(409, 'DRAFT_CHANGED', 'The draft was edited in another session');
      }
      validateVariants(values, variants);
      await verifyImageAssets(tx, key, [...values.images, ...(submittedVariants ?? [])]);
      if (!inserted) {
        await tx.query(`UPDATE listing_drafts SET title=$4,category=$5,description=$6,specification=$7,sku=$8,price_minor=$9,
          stock=$10,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND account_id=$2 AND id=$3`, args);
        await tx.query('DELETE FROM listing_draft_images WHERE draft_id=$1', [key[2]]);
      }
      await writeImages(tx, key[2], values.images);
      if (submittedVariants !== undefined) {
        if (current) await tx.query('DELETE FROM listing_draft_variants WHERE draft_id=$1', [key[2]]);
        for (const [i, v] of submittedVariants.entries()) {
          await tx.query(`INSERT INTO listing_draft_variants (draft_id,position,specification,sku,price_minor,stock,asset_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [key[2], i, v.specification, v.sku, v.priceMinor, v.stock, v.assetId]);
        }
      }
      return readDraft(tx, key);
    });
  });
}
