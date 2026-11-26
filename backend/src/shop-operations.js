import { createHash, randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';
import { operationForms } from './operation-forms.js';
import { readDraft } from './listing-drafts.js';
import { registerLedgerReport } from './ledger-report.js';
import { lockPlugin } from './plugin-policy.js';

const root = '/v1/studio/pinduoduo';
const options = { tags: ['Studio Operations'], manager: true };
const params = object({ book: uuid });
const day = { type: 'string', format: 'date' };
const stamp = { type: 'string', format: 'date-time' };
const revision = integer(0, 2147483646);
const bookFields = object({ id: uuid, name: text(120) });
const collection = schema => object({ items: array(schema, 100) });
const fields = 'reference, details, revision, updated_at AS "updatedAt"';
const conflict = message => new ApiError(409, 'OPERATION_CONFLICT', message);

function fieldSchema(field) {
  if (field.type === 'choice') return choice(...field.choices);
  if (field.type === 'date') return day;
  if (field.type === 'text') return text(field.max);
  return integer(field.min, field.max);
}

async function requireBook(db, request, lock = false) {
  const book = await row(db, 'SELECT id,name FROM operation_books WHERE workspace_id=$1 AND id=$2' + (lock ? ' FOR UPDATE' : ''),
    [request.context.workspaceId, request.params.book]);
  if (!book) throw notFound('Operations book');
  return book.id;
}

function clean(input, kind) {
  const reference = input.reference.trim();
  if (!reference) throw invalid('业务编号不能为空');
  const details = Object.fromEntries(Object.entries(input.details).map(([key,value]) => {
    if (typeof value !== 'string') return [key,value];
    if (!value.trim()) throw invalid('请填写有效文字，选填项可留空');
    return [key,value.trim()];
  }));
  if (kind === 'campaigns' && details.end < details.start) throw invalid('活动结束日期早于开始日期');
  if (kind === 'orders' && details.shipBy && details.shipBy < details.day) throw invalid('应发货日期早于下单日期');
  if (kind === 'shipments' && details.status === '已交运' && (!details.carrier || !details.tracking)) {
    throw invalid('登记已交运时需填写承运商和物流单号');
  }
  if (kind === 'reviews' && details.status === '已拟回复' && !details.reply) throw invalid('请填写回复草稿');
  if (kind === 'performance' && (details.buyers > details.visitors || details.visitors > details.views)) {
    throw invalid('买家数、访客数和浏览次数应依次递增或相等');
  }
  return { reference, details };
}

// The primary key serializes concurrent creates. Replays of an identical snapshot never create another row.
async function saveRecord(db, book, kind, input, expected) {
  const key = [book, kind, input.reference];
  const values = [...key, JSON.stringify(input.details)];
  try {
    if (!expected) {
      const inserted = await row(db, `INSERT INTO operation_records(book_id,kind,reference,details) VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT (book_id,kind,reference) DO NOTHING RETURNING ${fields}`, values);
      if (inserted) return { record: inserted, inserted: true };
    }
    const current = await row(db, `SELECT ${fields}, details=$4::jsonb AS same FROM operation_records
      WHERE book_id=$1 AND kind=$2 AND reference=$3 FOR UPDATE`, values);
    if (!current) throw notFound('Record');
    const { same, ...record } = current;
    if (same && (expected === undefined || expected === record.revision || expected + 1 === record.revision)) return { record, inserted: false };
    if (expected !== record.revision) throw conflict('编号已存在或记录已更新，请重新打开该记录核对');
    const updated = await row(db, `UPDATE operation_records SET details=$4, revision=revision+1, updated_at=now()
      WHERE book_id=$1 AND kind=$2 AND reference=$3 RETURNING ${fields}`, values);
    return { record: updated, inserted: false };
  } catch (error) {
    if (error.code === '23505') throw conflict('该商品或渠道在同一天已有统计记录，请编辑原记录');
    throw error;
  }
}

function registerRecords(app, db, kind, form) {
  const url = root + '/books/:book/records/' + kind;
  const entries = Object.entries(form.fields);
  const detailSchema = object(Object.fromEntries(entries.map(([key,f]) => [key,fieldSchema(f)])), entries.filter(([,f]) => !f.optional).map(([key]) => key));
  const values = { reference: text(100), details: detailSchema };
  const record = object({ ...values, revision, updatedAt: stamp });
  const filters = { ...page.properties, q: text(160), ...(form.fields.status ? { status: fieldSchema(form.fields.status) } : {}) };
  if (kind === 'orders' || kind === 'tickets') filters.overdueOn = day;
  if (kind === 'inventory') filters.low = { type: 'boolean' };
  if (form.fields.day) Object.assign(filters, { from: day, to: day });
  route(app, 'GET', url, { ...options, params, summary: 'Search local ' + kind, querystring: object(filters, []),
    response: { 200: collection(record) } }, async request => {
    const book = await requireBook(db, request);
    const {q, status, low, from, to, overdueOn} = request.query;
    if (from && to && from > to) throw invalid('日期范围无效');
    const args = [book,kind];
    const where = ['book_id=$1','kind=$2'];
    if (q) {
      args.push(q.trim());
      where.push(`strpos(lower(concat_ws(' ',reference,details->>'title',details->>'orderRef',details->>'sku',details->>'productRef',details->>'tracking')),lower($${args.length}))>0`);
    }
    if (status) where.push("details->>'status'=$" + args.push(status));
    if (from) where.push("(details->>'day') >= $" + args.push(from));
    if (to) where.push("(details->>'day') <= $" + args.push(to));
    if (overdueOn) {
      const cutoff = '$' + args.push(overdueOn);
      where.push(kind === 'orders' ? "details->>'status'='待发货' AND details->>'shipBy'<" + cutoff :
        "details->>'status'<>'已结案' AND details->>'due'<" + cutoff);
    }
    if (low) where.push("(details->>'stock')::integer <= (details->>'threshold')::integer");
    const limit = args.push(paginate(request.query)[0]);
    const offset = args.push(paginate(request.query)[1]);
    return { items: await rows(db, `SELECT ${fields} FROM operation_records WHERE ${where.join(' AND ')}
      ORDER BY reference LIMIT $${limit} OFFSET $${offset}`, args) };
  });
  route(app, 'GET', url + '/lookup', { ...options, params, summary: 'Open a local ' + kind + ' record',
    querystring: object({ reference: text(100) }), response: {200: record} }, async request => {
    const book = await requireBook(db, request);
    const result = await row(db, `SELECT ${fields} FROM operation_records WHERE book_id=$1 AND kind=$2 AND reference=$3`, [book,kind,request.query.reference]);
    if (!result) throw notFound('Record');
    return result;
  });
  route(app, 'PUT', url, { ...options, feature: 'operations', params, summary: 'Create or edit local ' + kind,
    body: object({ ...values, revision }), response: { 200: record } }, async request => {
    const book = await requireBook(db, request);
    const input = clean(request.body, kind);
    return db.transaction(async tx => {
      await lockPlugin(tx,request.context.workspaceId,'operations');
      if (kind === 'inventory') await requireBook(tx, request, true);
      return (await saveRecord(tx, book, kind, input, request.body.revision)).record;
    });
  });
  route(app, 'POST', url + '/import', { ...options, feature: 'operations', params, summary: 'Atomically import local ' + kind,
    body: object({ items: array(object(values), 500, 1) }), response: { 200: object({ inserted: integer(0,500), unchanged: integer(0,500) }) } }, async request => {
    const book = await requireBook(db, request);
    const inputs = request.body.items.map(i => clean(i, kind));
    if (new Set(inputs.map(i => i.reference)).size !== inputs.length) throw invalid('文件内存在重复编号');
    inputs.sort((a,b) => a.reference < b.reference ? -1 : 1);
    return db.transaction(async tx => {
      await lockPlugin(tx,request.context.workspaceId,'operations');
      if (kind === 'inventory') await requireBook(tx, request, true);
      let inserted = 0;
      for (const input of inputs) if ((await saveRecord(tx, book, kind, input)).inserted) inserted++;
      return { inserted, unchanged: inputs.length - inserted };
    });
  });
}

const draftImportFields = { draftId: uuid, day, threshold: integer(0,1000000000) };
const previewId = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const draftImportRow = object({
  sku: text(100,0), specification: text(200,0),
  priceMinor: {type:['integer','null']}, stock: {type:['integer','null']},
  missing: array(text(40),4), conflicts: array(object({ sku: text(100), title: text(200) }),100),
});

async function draftImportPreview(db, context, book, payload, lock = false) {
  const key = [context.workspaceId, context.accountId, payload.draftId];
  if (lock) {
    const found = await row(db, 'SELECT id FROM listing_drafts WHERE workspace_id=$1 AND account_id=$2 AND id=$3 FOR SHARE', key);
    if (!found) throw notFound('Draft');
  }
  const draft = await readDraft(db, key);
  const specs = [draft, ...draft.variants];
  const existing = await rows(db, `
    SELECT lookup.position::int AS position, r.reference AS sku, r.details->>'title' AS title
    FROM unnest($2::text[]) WITH ORDINALITY AS lookup(sku,position)
    JOIN operation_records r ON r.book_id=$1 AND r.kind='inventory'
      AND lower(btrim(r.reference))=lower(btrim(lookup.sku))
    ORDER BY lookup.position,r.reference`, [book, specs.map(v => v.sku)]);
  const items = specs.map((v,i) => {
    const missing = [];
    if (!v.specification) missing.push('规格');
    if (!v.sku) missing.push('商家 SKU');
    if (v.priceMinor === null) missing.push('售价');
    if (v.stock === null) missing.push('库存');
    return { sku: v.sku, specification: v.specification, priceMinor: v.priceMinor, stock: v.stock, missing,
      conflicts: existing.filter(x => x.position === i+1).slice(0,100).map(({sku,title}) => ({sku,title})) };
  });
  const { day, threshold } = payload;
  const digest = createHash('sha256').update(JSON.stringify([
    context.accountId, book, draft.id, draft.revision, day, threshold, items,
  ])).digest('hex');
  return { previewId: digest, title: draft.title, category: draft.category, day, threshold, items,
    ready: items.every(x => !x.missing.length && !x.conflicts.length) };
}

function registerInventoryDraftImport(app, db) {
  const url = root + '/books/:book/records/inventory/draft-import';
  route(app, 'POST', url + '/preview', { ...options, feature: 'operations', params, summary: 'Preview saved draft variants without writing inventory',
    body: object(draftImportFields), response: { 200: object({ previewId, title: text(200), category: text(200,0),
      day, threshold: draftImportFields.threshold, items: array(draftImportRow,50,1), ready: {type:'boolean'} }) } },
  async request => draftImportPreview(db, request.context, await requireBook(db, request), request.body));
  route(app, 'POST', url + '/confirm', { ...options, feature: 'operations', params, summary: 'Confirm unchanged draft preview and insert the whole batch',
    body: object({ ...draftImportFields, previewId }), response: { 200: object({ inserted: integer(1,50) }) } },
  request => db.transaction(async tx => {
    await lockPlugin(tx,request.context.workspaceId,'operations');
    const book = await requireBook(tx, request, true);
    const { accountId } = request.context;
    const { draftId, previewId: digest, day, threshold } = request.body;
    const receiptKey = [book, accountId, digest, draftId, day, threshold];
    const receipt = await row(tx, `SELECT inserted FROM inventory_draft_imports WHERE book_id=$1 AND account_id=$2
      AND preview_id=$3 AND draft_id=$4 AND counted_on=$5 AND threshold=$6`, receiptKey);
    if (receipt) return receipt;

    const preview = await draftImportPreview(tx, request.context, book, request.body, true);
    if (!preview.ready || digest !== preview.previewId) {
      throw new ApiError(409, 'INVENTORY_PREVIEW_CHANGED', '草稿或台账状态已变化，或当前仍有缺项和重复 SKU，请重新预览后确认');
    }
    for (const item of preview.items) {
      const details = { title: preview.title, productRef: draftId.toLowerCase(), specification: item.specification,
        priceMinor: item.priceMinor, stock: item.stock, day, threshold };
      if (preview.category) details.category = preview.category;
      await saveRecord(tx, book, 'inventory', { reference: item.sku, details });
    }
    const inserted = preview.items.length;
    await tx.query(`INSERT INTO inventory_draft_imports (book_id,account_id,preview_id,draft_id,counted_on,threshold,inserted)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [...receiptKey, inserted]);
    return { inserted };
  }));
}

export function registerShopOperations(app, db) {
  route(app, 'GET', root + '/modules', { ...options, summary: 'Fields for manual records and business exports' }, async () => operationForms);
  route(app, 'GET', root + '/books', { ...options, summary: 'List local shop ledgers', querystring: page, response: {200: collection(bookFields)} }, async request => ({
    items: await rows(db, 'SELECT id,name FROM operation_books WHERE workspace_id=$1 ORDER BY name,id LIMIT $2 OFFSET $3',
      [request.context.workspaceId,...paginate(request.query)]),
  }));
  route(app, 'POST', root + '/books', { ...options, feature: 'operations', summary: 'Open a named workspace ledger', body: object({ name: text(120) }), response: {200: bookFields} }, async request => {
    const name = request.body.name.trim();
    if (!name) throw invalid('请填写台账名称');
    return db.transaction(async tx=>{
      await lockPlugin(tx,request.context.workspaceId,'operations');
      return row(tx, `INSERT INTO operation_books(id,workspace_id,name) VALUES($1,$2,$3)
      ON CONFLICT (workspace_id,name) DO UPDATE SET name=excluded.name RETURNING id,name`, [randomUUID(),request.context.workspaceId,name]);
    });
  });
  for (const [kind, form] of Object.entries(operationForms)) registerRecords(app, db, kind, form);
  registerInventoryDraftImport(app, db);
  registerLedgerReport(app,db,requireBook);
  route(app, 'GET', root + '/books/:book/summary', { ...options, params, summary: 'Aggregate this book’s recorded shop activity' }, async request => {
    const book = await requireBook(db, request);
    const counts = await rows(db, `SELECT kind, count(*)::int AS total,
      count(*) FILTER (WHERE details->>'status' IN ('待发货','待处理','待拟回复','物流异常'))::int AS pending,
      count(*) FILTER (WHERE kind='inventory' AND (details->>'stock')::integer <= (details->>'threshold')::integer)::int AS low
      FROM operation_records WHERE book_id=$1 GROUP BY kind ORDER BY kind`, [book]);
    return { items: counts };
  });
  route(app, 'GET', root + '/books/:book/insights', { ...options, params, summary: 'Status counts, overdue work and review tags from recorded data',
    querystring: object({ asOf: day }) }, async request => {
    const book = await requireBook(db, request);
    const states = await rows(db, `SELECT kind, details->>'status' AS status, count(*)::int AS count FROM operation_records
      WHERE book_id=$1 AND details ? 'status' GROUP BY kind,details->>'status' ORDER BY kind,status`, [book]);
    const overdue = await row(db, `SELECT
      count(*) FILTER (WHERE kind='orders' AND details->>'status'='待发货' AND details->>'shipBy'<$2)::int AS orders,
      count(*) FILTER (WHERE kind='tickets' AND details->>'status'<>'已结案' AND details->>'due'<$2)::int AS tickets
      FROM operation_records WHERE book_id=$1`, [book,request.query.asOf]);
    const reviewTags = await rows(db, `SELECT tag,count(*)::int AS count FROM (
      SELECT DISTINCT reference,trim(t) AS tag FROM operation_records
      CROSS JOIN LATERAL regexp_split_to_table(details->>'tags','[,，]') AS t
      WHERE book_id=$1 AND kind='reviews') tags WHERE tag<>'' GROUP BY tag ORDER BY count DESC,tag LIMIT 20`, [book]);
    return {states,overdue,reviewTags};
  });
  route(app, 'GET', root + '/books/:book/analytics', { ...options, params, summary: 'Daily order totals from the local ledger',
    querystring: object({ ...page.properties, from: day, to: day }, []) }, async request => {
    const book = await requireBook(db, request);
    const {from,to} = request.query;
    if (from && to && from > to) throw invalid('日期范围无效');
    return {items: await rows(db, `SELECT details->>'day' AS day, count(*)::int AS orders,
      count(details->>'paidMinor')::int AS "withAmount", sum((details->>'paidMinor')::bigint)::text AS "paidMinor",
      sum((details->>'units')::integer)::text AS units FROM operation_records WHERE book_id=$1 AND kind='orders'
      AND details->>'status'<>'已取消' AND ($2::text IS NULL OR details->>'day'>=$2) AND ($3::text IS NULL OR details->>'day'<=$3)
      GROUP BY details->>'day' ORDER BY day DESC LIMIT $4 OFFSET $5`, [book,from ?? null,to ?? null,...paginate(request.query)])};
  });
}
