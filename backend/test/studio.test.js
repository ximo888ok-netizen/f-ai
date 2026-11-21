
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';
import { createProviders } from '../src/providers.js';
import { provisionCredits } from '../src/wallet.js';
import { workOnce } from '../src/worker.js';

const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
const providers = createProviders();
const shops = new Map();
let app, owner, other;
const send = (method, url, session, payload) => app.inject({ method, url, payload, headers: session
  ? { authorization: 'Bearer ' + session.token, 'x-workspace-id': session.workspaces[0].id }
  : {} });
function data(response, code) {
  assert.equal(response.statusCode, code, response.body);
  return code === 204 ? undefined : response.json();
}

before(async () => {
  await migrate(db);
  app = await buildApp({ db, providers, shops });
  await app.ready();
  const register = async email => data(await send('POST', '/v1/auth/register', null, {
    email, password: 'studio-test-password', type: 'enterprise', workspaceName: 'Studio QA', displayName: email,
  }), 201);
  owner = await register('studio-owner@example.test');
  other = await register('studio-other@example.test');
});
after(async () => {
  await app?.close();
  await db.close();
});

test('Studio entry only serves real app code and current theme components', async () => {
  const entry = await send('GET', '/');
  assert.equal(entry.statusCode, 200);
  assert.match(entry.body, /\/studio\/live\.js/);
  assert.match(entry.body, /\/studio\/components\.css/);
  assert.doesNotMatch(entry.body, /src="studio\.js"/);
  assert.match(entry.headers['content-security-policy'], /connect-src 'self'/);
  for (const file of ['live.js', 'live-tasks.js', 'live-workspace.js', 'live-products.js', 'live-drafts.js',
    'live-operations.js', 'operations-file.js', 'live-customer.js', 'live-skills.js', 'live-copy-review.js',
    'live-rights.js', 'live-files.js', 'live-media.js', 'live-media-controls.js', 'live-image-studio.js',
    'live-storyboards.js', 'components.css', 'assets/aurora.webp']) {
    assert.equal((await send('GET', '/studio/' + file)).statusCode, 200, file);
  }
  assert.equal((await send('GET', '/studio/studio.js')).statusCode, 404);
});

test('product records, category assignment, import rollback, export and tenant isolation', async () => {
  const categories = '/v1/studio/categories';
  const products = '/v1/studio/products';
  const category = data(await send('POST', categories, owner, { name: 'Home' }), 201);
  data(await send('POST', products, other, { sku: 'FOREIGN', name: 'Other', categoryId: category.id }), 409);
  const original = data(await send('POST', products, owner, { sku: 'MUG-001', name: 'Mug', categoryId: category.id }), 201);
  data(await send('DELETE', categories + '/' + category.id, owner), 409);
  assert.deepEqual(data(await send('GET', products, other), 200).items, []);
  data(await send('PUT', products + '/' + original.id, other, { sku: 'MUG-001', name: 'Different' }), 404);
  data(await send('POST', products + '/import', owner, { reference: 'failed-import', items: [
    { sku: 'NEW', name: 'Test', category: 'Will Roll Back' }, { sku: original.sku, name: 'Duplicate' },
  ] }), 409);
  assert.deepEqual(data(await send('GET', categories, owner), 200).items.map(item => item.name), ['Home']);
  assert.deepEqual(data(await send('GET', products, owner), 200).items.map(item => item.sku), [original.sku]);
  const response = data(await send('POST', products + '/import', owner, { reference: 'successful-import', items: [
    { sku: 'MUG-002', name: 'Cup', category: 'Home' },
  ] }), 201);
  assert.equal(response.count, 1);
  data(await send('POST', products + '/export', other, { reference: 'forbidden-export', ids: [original.id] }), 404);
  const result = data(await send('POST', products + '/export', owner, { reference: 'actual-export', ids: [original.id] }), 200);
  assert.deepEqual(result.items, [{ sku: 'MUG-001', name: 'Mug', description: '', category: 'Home' }]);
  assert.deepEqual(data(await send('GET', '/v1/studio/transfers', owner), 200).items.map(item => item.direction).sort(), ['export', 'import']);
  assert.deepEqual(data(await send('GET', '/v1/studio/transfers', other), 200).items, []);
  assert.deepEqual(data(await send('POST', '/v1/studio/roi', owner, {
    priceMinor: 1000, unitCostMinor: 250, units: 10, feesMinor: 500, adSpendMinor: 1000,
  }), 200), { revenueMinor: 10000, productCostMinor: 2500, contributionMinor: 6000, roas: 10 });
});

test('Studio drafts keep ordered owned images, reject publication, and handle edits and replay', async () => {
  const root = '/v1/studio/pinduoduo-drafts';
  const url = root + '/' + randomUUID();
  async function image(session, name, mediaType = 'image/png', bytes = '89504e470d0a1a0a') {
    return data(await send('POST', '/v1/assets', session, { name, mediaType, source: 'fixture', purpose: 'draft',
      dataBase64: Buffer.from(bytes, 'hex').toString('base64') }), 201).id;
  }
  const main = await image(owner, 'front.png');
  const detail = await image(owner, 'side.png');
  const foreign = await image(other, 'private.png');
  const video = await image(owner, 'clip.mp4', 'video/mp4', '0000000066747970');
  const input = { revision: 0, title: 'Sample', priceMinor: null, stock: null, images: [
    { role: 'main', assetId: main }, { role: 'sku', assetId: main }, { role: 'detail', assetId: detail },
  ] };
  const put = async (payload, status, session = owner) => data(await send('PUT', url, session, payload), status);
  await put({ ...input, publish: true }, 400);
  await put({ ...input, images: [{ role: 'main', assetId: video }] }, 400);
  await put({ ...input, images: [input.images[0], input.images[0]] }, 400);
  await put({ ...input, images: [{ role: 'main', assetId: foreign }] }, 404);
  assert.deepEqual(data(await send('GET', root, owner), 200).items, []);
  const saved = await put(input, 200);
  assert.equal(saved.revision, 1);
  assert.equal(saved.priceMinor, null);
  assert.equal(saved.stock, null);
  const check = data(await send('GET', root + '/quality', owner), 200).items.find(r => r.id === saved.id);
  assert.ok(check.missing.includes('售价') && check.missing.includes('库存'));
  assert.ok(!check.missing.includes('详情图'));
  assert.deepEqual(data(await send('GET', root + '/quality', other), 200).items, []);
  assert.deepEqual(saved.images, input.images);
  assert.deepEqual(await put(input, 200), saved);
  assert.deepEqual(data(await send('GET', url, owner), 200), saved);
  assert.deepEqual(data(await send('GET', root, other), 200).items, []);
  data(await send('GET', url, other), 404);
  await put({ ...input, revision: 1 }, 404, other);
  data(await send('DELETE', '/v1/assets/' + detail, owner), 409);
  await put({ ...input, revision: 1, images: [input.images[0], { role: 'detail', assetId: foreign }] }, 404);
  assert.deepEqual(data(await send('GET', url, owner), 200), saved);
  const edited = { ...input, revision: 1, stock: 0, priceMinor: 321, images: [input.images[0]] };
  const updated = await put(edited, 200);
  assert.equal(updated.revision, 2);
  assert.equal(updated.stock, 0);
  assert.equal(updated.priceMinor, 321);
  assert.deepEqual(await put(edited, 200), updated);
  await put({ ...edited, title: 'Stale edit' }, 409);
  data(await send('DELETE', '/v1/assets/' + detail, owner), 204);
  assert.equal(data(await send('GET', root, owner), 200).items.length, 1);
  assert.deepEqual(data(await send('GET', '/v1/tasks', owner), 200).items, []);
});

test('Studio draft variants remain ordered, private and compatible with single-SKU edits', async () => {
  const root = '/v1/studio/pinduoduo-drafts';
  const url = root + '/' + randomUUID();
  async function picture(session, name) {
    return data(await send('POST', '/v1/assets', session, {
      name, mediaType: 'image/png', source: 'fixture', purpose: 'draft',
      dataBase64: Buffer.from('89504e470d0a1a0a','hex').toString('base64'),
    }), 201).id;
  }
  const main = await picture(owner, 'main.png');
  const variantImage = await picture(owner, 'variant.png');
  const foreign = await picture(other, 'foreign.png');
  const input = { revision: 0, title: 'Sample variants', specification: 'Single', sku: 'sample-one',
    priceMinor: 540, stock: 0, images: [{ role: 'main', assetId: main }] };
  const save = async (payload, status) => data(await send('PUT', url, owner, payload), status);
  const original = await save(input, 200);
  assert.deepEqual(original.variants, []);
  const variants = [
    { specification: 'Two pack', sku: 'sample-two', priceMinor: 1015, stock: 0, assetId: variantImage },
    { specification: 'Four pack', sku: '', priceMinor: null, stock: null, assetId: null },
  ];
  const edit = { ...input, revision: original.revision, variants };
  await save({ ...edit, variants: [{ ...variants[0], sku: ' SAMPLE-ONE ' }] }, 400);
  await save({ ...edit, variants: [{ ...variants[0], specification: ' single ' }] }, 400);
  await save({ ...edit, variants: [{ ...variants[0], assetId: foreign }] }, 404);
  assert.deepEqual(data(await send('GET', url, owner), 200), original);
  const saved = await save(edit, 200);
  assert.deepEqual(saved.variants, variants);
  assert.deepEqual(await save(edit, 200), saved);
  await save({ ...edit, variants: [...variants].reverse() }, 409);
  data(await send('GET', url, other), 404);
  data(await send('DELETE', '/v1/assets/' + variantImage, owner), 409);
  const checks = data(await send('GET', root + '/quality', owner), 200).items;
  assert.deepEqual(checks.find(check => check.id === saved.id).variantChecks, [
    { specification: 'Two pack', missing: [] },
    { specification: 'Four pack', missing: ['商家 SKU', '售价', '库存'] },
  ]);
  assert.deepEqual(data(await send('GET', root + '/quality', other), 200).items, []);
  const legacyEdit = { ...input, title: 'Updated by legacy client', revision: saved.revision };
  const updated = await save(legacyEdit, 200);
  assert.deepEqual(updated.variants, variants);
  assert.deepEqual(await save(legacyEdit, 200), updated);
  const cleared = await save({ ...legacyEdit, revision: updated.revision, variants: [] }, 200);
  assert.deepEqual(cleared.variants, []);
  data(await send('DELETE', '/v1/assets/' + variantImage, owner), 204);
});

test('shop ledgers isolate business records and compute local backlog and sales from committed data', async () => {
  const root = '/v1/studio/pinduoduo';
  const book = data(await send('POST', root+'/books', owner, {name:'QA Ledger'}),200);
  assert.deepEqual(data(await send('POST', root+'/books', owner, {name:'QA Ledger'}),200),book);
  const base = root + '/books/' + book.id;
  const url = base + '/records/orders';
  const details = {title:'Sample basket',day:'2026-02-01',shipBy:'2026-02-04',units:2,status:'待发货',paidMinor:1250};
  const entry = {reference:'Q/01',details};
  const write = (payload, code) => send('PUT',url,owner,payload).then(r => data(r,code));
  const original = await write({...entry,revision:0},200);
  assert.equal(original.revision,1);
  assert.deepEqual(await write({...entry,revision:0},200),original);
  data(await send('GET',url,other),404);
  data(await send('GET',base+'/insights?asOf=2026-02-05',other),404);
  data(await send('PUT',url,other,{...entry,revision:1}),404);
  const memberId = other.account.id;
  await db.query("INSERT INTO memberships(workspace_id,account_id,role) VALUES($1,$2,'member')",[owner.workspaces[0].id,memberId]);
  const member = {...other,workspaces:[owner.workspaces[0]]};
  data(await send('GET',root+'/books',member),403);
  data(await send('PUT',url,member,{...entry,revision:1}),403);
  assert.deepEqual(data(await send('GET',url+'/lookup?reference=Q%2F01',owner),200),original);
  const batch = (items,code) => send('POST',url+'/import',owner,{items}).then(r=>data(r,code));
  await batch([{reference:'A',details},{...entry,details:{...details,units:7}}],409);
  assert.deepEqual(data(await send('GET',url,owner),200).items,[original]);
  await batch([{reference:'A',details},{reference:' A ',details}],400);
  const {paidMinor,...unpriced} = details;
  const more = [{reference:'B',details:unpriced},{reference:'C',details:{...details,status:'已取消'}}];
  assert.deepEqual(await batch(more,200),{inserted:2,unchanged:0});
  assert.deepEqual(await batch(more,200),{inserted:0,unchanged:2});
  const updated = await write({...entry,revision:1,details:{...details,paidMinor:0}},200);
  assert.equal(updated.revision,2);
  await write({...entry,revision:1},409);
  assert.equal(data(await send('GET',url+'?status='+encodeURIComponent('已取消'),owner),200).items.length,1);
  assert.equal(data(await send('GET',url+'?overdueOn=2026-02-04',owner),200).items.length,0);
  assert.equal(data(await send('GET',url+'?overdueOn=2026-02-05',owner),200).items.length,2);
  const analytic = data(await send('GET',base+'/analytics?from=2026-02-01&to=2026-02-01',owner),200);
  assert.deepEqual(analytic.items,[{day:'2026-02-01',orders:2,withAmount:1,paidMinor:'0',units:'4'}]);
  const save = (kind,reference,details,code=200) => send('PUT',base+'/records/'+kind,owner,{reference,details,revision:0}).then(r=>data(r,code));
  await save('reviews','R',{title:'Item',day:'2026-02-02',content:'Good',status:'已拟回复'},400);
  await save('reviews','R',{title:'Item',day:'2026-02-02',content:'Good',tags:'service, service，delivery',status:'已拟回复',reply:'Thank you'});
  await save('shipments','S',{title:'Box',orderRef:'Q/01',status:'已交运'},400);
  await save('shipments','S',{title:'Box',orderRef:'Q/01',status:'已交运',carrier:'Carrier',tracking:'T1'});
  await save('inventory','SKU1',{title:'Item',stock:0,threshold:0,day:'2026-02-01'});
  await save('inventory','SKU2',{title:'Item',stock:3,threshold:2,day:'2026-02-01'});
  await save('tickets','T1',{title:'Check',status:'跟进中',due:'2026-02-02'});
  await save('returns','A1',{title:'Review request',status:'待处理',kind:'仅退款',orderRef:'Q/01'});
  await save('campaigns','C1',{title:'Plan',status:'筹备中',start:'2026-03-01',end:'2026-02-01'},400);
  await save('campaigns','C1',{title:'Plan',status:'筹备中',start:'2026-02-01',end:'2026-03-01'});
  await save('shippingTemplates','F',{title:'Standard',regions:'Local',firstFeeMinor:400,nextFeeMinor:50});
  await save('attributes','P',{title:'Sizes',category:'Home',properties:'Material'});
  await save('qualifications','DOC',{title:'Documentation',productRef:'SKU1',status:'待收集'});
  await save('returnRules','RR',{title:'Returns',scope:'Local',instructions:'Contact team'});
  const metrics={title:'Item',sku:'SKU1',day:'2026-02-01',views:20,visitors:5,buyers:2,salesMinor:3500};
  await save('performance','M',metrics);
  await save('performance','M2',metrics,409);
  const totals=data(await send('GET',base+'/summary',owner),200).items;
  assert.equal(totals.find(i=>i.kind==='inventory').low,1);
  const insights=data(await send('GET',base+'/insights?asOf=2026-02-05',owner),200);
  assert.deepEqual(insights.overdue,{orders:2,tickets:1});
  assert.deepEqual(insights.reviewTags,[{tag:'delivery',count:1},{tag:'service',count:1}]);
  assert.equal(data(await send('GET',base+'/records/inventory?low=true',owner),200).items[0].reference,'SKU1');
  data(await send('POST',base+'/publish',owner,{}),404);
  assert.deepEqual(data(await send('GET','/v1/tasks',owner),200).items,[]);
});

test('confirmed draft import rejects duplicate SKUs and stale previews and writes the exact batch once', async () => {
  const bookRoot = '/v1/studio/pinduoduo/books';
  const book = data(await send('POST',bookRoot,owner,{name:'Draft transfer QA'}),200);
  const foreign = data(await send('POST',bookRoot,other,{name:'Foreign draft transfer QA'}),200);
  const inventory = bookRoot + '/' + book.id + '/records/inventory';
  const transfer = inventory + '/draft-import';
  const draftId = randomUUID();
  const draftPath = '/v1/studio/pinduoduo-drafts/' + draftId;
  const assetId = data(await send('POST','/v1/assets',owner,{
    name:'cover.png',mediaType:'image/png',source:'fixture',purpose:'draft',dataBase64:'iVBORw0KGgo=',
  }),201).id;
  const details = {title:'Local item',specification:'Single',category:'Sample',sku:'QA-ONE',stock:0,priceMinor:1234,
    images:[{role:'main',assetId}], variants:[{specification:'Bundle',sku:'QA-TWO',priceMinor:2534}]};
  const save = async revision => data(await send('PUT',draftPath,owner,{...details,revision}),200);
  const initial = await save(0);
  const body = {draftId, day:'2026-02-04',threshold:2};
  const preview = async (dataBody=body) => data(await send('POST',transfer+'/preview',owner,dataBody),200);
  const confirm = (pending, status, overrides={}) =>
    send('POST',transfer+'/confirm',owner,{...body,previewId:pending.previewId,...overrides}).then(r=>data(r,status));
  data(await send('POST',transfer+'/preview',other,body),404);
  data(await send('POST',bookRoot+'/'+foreign.id+'/records/inventory/draft-import/preview',other,body),404);
  data(await send('POST',transfer+'/confirm',owner,body),400);
  const incomplete = await preview();
  assert.equal(incomplete.ready,false);
  assert.deepEqual(incomplete.items[1].missing,['库存']);
  await confirm(incomplete,409);
  assert.deepEqual(data(await send('GET',inventory,owner),200).items,[]);
  details.variants[0].stock = 7;
  const fixed = await save(initial.revision);
  const stale = await preview();
  details.variants[0].priceMinor = 2834;
  await save(fixed.revision);
  await confirm(stale,409);
  assert.deepEqual(data(await send('GET',inventory,owner),200).items,[]);
  const beforeCollision = await preview();
  await confirm(beforeCollision,409,{threshold:3});
  data(await send('PUT',inventory,owner,{reference:'qa-two',revision:0,details:{
    title:'Existing inventory',stock:10,threshold:1,day:body.day,
  }}),200);
  await confirm(beforeCollision,409);
  const collision = await preview();
  assert.equal(collision.ready,false);
  assert.deepEqual(collision.items[1].conflicts,[{sku:'qa-two',title:'Existing inventory'}]);
  await confirm(collision,409);
  const [existing] = data(await send('GET',inventory,owner),200).items;
  assert.equal(existing.reference,'qa-two');
  assert.equal(existing.details.stock,10);
  const newBook = data(await send('POST',bookRoot,owner,{name:'Clean draft transfer QA'}),200);
  const cleanInventory = bookRoot+'/'+newBook.id+'/records/inventory';
  const cleanTransfer = cleanInventory+'/draft-import';
  const final = data(await send('POST',cleanTransfer+'/preview',owner,body),200);
  assert.equal(final.ready,true);
  assert.deepEqual(data(await send('GET',cleanInventory,owner),200).items,[]);
  const committed = await Promise.all([1,2].map(() =>
    send('POST',cleanTransfer+'/confirm',owner,{...body,previewId:final.previewId}).then(r=>data(r,200))));
  assert.deepEqual(committed,[{inserted:2},{inserted:2}]);
  const rows = data(await send('GET',cleanInventory,owner),200).items;
  assert.deepEqual(rows.map(r=>[r.reference,r.details.specification,r.details.priceMinor,r.details.stock,r.details.threshold,r.details.day]),[
    ['QA-ONE','Single',1234,0,2,body.day], ['QA-TWO','Bundle',2834,7,2,body.day],
  ]);
  assert.ok(rows.every(r=>r.details.productRef===draftId));
});

test('server settings save favorites and theme and suppress task notifications when disabled', async () => {
  const directory = data(await send('GET', '/v1/plugins', owner), 200);
  assert.equal(directory.items.length, 5);
  assert.deepEqual(directory.models.capabilities.map(entry => entry.id), [
    'model.chat', 'model.embed', 'model.rerank', 'model.speech', 'model.transcribe', 'model.voice-turn',
  ]);
  const preferences = { studioTheme: 'jade', studioMotion: 'off', favoriteCapabilities: ['copywriting.detect-terms'], taskNotifications: false };
  assert.deepEqual(data(await send('PATCH', '/v1/settings', owner, preferences), 200).preferences, preferences);
  assert.deepEqual(data(await send('GET', '/v1/settings', other), 200).preferences, {});
  await provisionCredits(db, owner.workspaces[0].id, owner.account.id, 4, 'studio-prefs-test');
  const task = data(await send('POST', '/v1/tasks', owner, {
    capabilityId: 'copywriting.detect-terms', mode: 'workflow', parameters: { content: '100%' }, idempotencyKey: 'studio-prefs-test',
  }), 202);
  assert.equal(await workOnce({ db, providers, shops }), true);
  assert.equal(data(await send('GET', '/v1/tasks/' + task.id, owner), 200).state, 'succeeded');
  const notifications = data(await send('GET', '/v1/notifications', owner), 200);
  assert.deepEqual(notifications, { items: [], unread: 0 });
});
