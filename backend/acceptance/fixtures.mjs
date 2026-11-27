import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { catalog as releaseCatalog } from '../src/catalog.js';

export function identityPayload(node, application, databaseEnv, action, details) {
  // The candidate's native CAPTCHA renderer must unload before cleanup on Windows.
  const result = spawnSync(node, [fileURLToPath(import.meta.url), action], {
    cwd: application, env: databaseEnv, input: JSON.stringify(details), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Identity fixture failed: ' + result.stderr.slice(-1200));
  return JSON.parse(result.stdout);
}

if (import.meta.main) {
  const action = process.argv[2];
  assert.ok(['register', 'login'].includes(action));
  const details = JSON.parse(readFileSync(0, 'utf8'));
  const { buildAuthTestApp, registrationPayload, loginPayload } = await import('../test-support/identity-fixture.js');
  const candidateModule = name => import(pathToFileURL(join(process.cwd(), 'src', name)));
  const [{ buildApp }, { postgres }] = await Promise.all([candidateModule('app.js'), candidateModule('db.js')]);
  const db = postgres(process.env.DATABASE_URL);
  let app;
  try {
    app = await buildAuthTestApp({ db }, buildApp);
    const version = await app.inject({ method: 'GET', url: '/version' });
    assert.deepEqual(version.json(), { revision: process.env.FAI_RELEASE_REVISION });
    const prepare = action === 'register' ? registrationPayload : loginPayload;
    process.stdout.write(JSON.stringify(await prepare(app, details)));
  } finally {
    try { await app?.close(); } finally { await db.close(); }
  }
}

export function client(origin, session, workspace = session?.workspaces[0].id) {
  return async (method, path, expected, body) => {
    const response = await fetch(origin + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(session && { authorization: 'Bearer ' + session.token, 'x-workspace-id': workspace }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, expected, method + ' ' + path + ' returned ' + response.status);
    if (response.headers.get('content-type')?.includes('json')) return response.json();
    return Buffer.from(await response.arrayBuffer());
  };
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function boundaryPng() {
  const header = Buffer.from('00000001000000010806000000', 'hex');
  const prefix = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 128, 255, 255])))]);
  const end = pngChunk('IEND', Buffer.alloc(0));
  // A private ancillary chunk adds valid padding without changing the pixel.
  const padding = pngChunk('qaSa', Buffer.alloc(10 * 1024 * 1024 - prefix.length - end.length - 12));
  return Buffer.concat([prefix, padding, end]);
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function exerciseWorkspace(origin, owner, proofs) {
  const api = client(origin, owner);
  for (const enabled of [false, true]) {
    await api('PATCH', '/v1/settings', 200, { rightsNotifications: enabled });
    assert.equal((await api('GET', '/v1/settings', 200)).preferences.rightsNotifications, enabled);
  }
  const other = await client(origin)('POST', '/v1/auth/register', 201, proofs('register', {
    type: 'personal', displayName: 'QA member', email: 'member@example.test', password: randomUUID(),
  }));
  const invitation = await api('POST', '/v1/invitations', 201, { email: other.account.email, role: 'member' });
  await client(origin, other)('POST', '/v1/invitations/accept', 200, { token: invitation.token });
  const member = client(origin, other, owner.workspaces[0].id);
  const project = await api('POST', '/v1/projects', 201, { name: 'Synthetic project' });
  const path = '/v1/projects/' + project.id;
  await member('GET', path, 404);
  await api('PUT', path + '/members/' + other.account.id, 204);
  assert.equal((await member('GET', path, 200)).id, project.id);
  await member('PATCH', path, 403, { state: 'archived' });
  await api('PATCH', path, 200, { state: 'archived' });
  assert.deepEqual((await api('GET', '/v1/projects', 200)).items, []);
  assert.deepEqual((await api('GET', '/v1/projects?state=archived', 200)).items.map(item => item.id), [project.id]);

  const plugins = (await api('GET', '/v1/plugins', 200)).items;
  assert.equal(plugins.length, 5);
  const expected = [...releaseCatalog.values()].filter(capability => capability.pluginId !== 'models');
  const registered = plugins.flatMap(plugin => plugin.capabilities.map(capability => plugin.id + '/' + capability.id));
  assert.deepEqual(registered.sort(), expected.map(capability => capability.pluginId + '/' + capability.id).sort());
  for (const plugin of plugins) {
    const state = '/v1/plugins/' + plugin.id + '/state';
    await api('PUT', state, 200, { enabled: false });
    const catalog = (await api('GET', '/v1/plugins', 200)).items;
    assert.deepEqual(catalog.filter(item => !item.enabled).map(item => item.id), [plugin.id]);
    assert.ok(catalog.find(item => item.id === plugin.id).capabilities.every(item => !item.available));
    await api('PUT', state, 200, { enabled: true });
  }
  assert.deepEqual((await api('GET', '/v1/plugins', 200)).items, plugins);
}

export async function exercisePsd(api, asset, readPsd) {
  const path = '/v1/studio/psd-documents/' + randomUUID();
  const layout = { width: 160, height: 120, backgroundColor: '#ffffff',
    placement: { x: 10, y: 45, width: 96, height: 64 },
    caption: { text: 'Editable QA', font: 'sans', x: 5, y: 24, size: 18, color: '#111111' } };
  await api('PUT', path, 200, { revision: 0, title: 'QA layers', layout, subjectAssetId: asset.id, backgroundAssetId: null });
  const preview = await api('GET', path + '/preview', 200);
  assert.equal(preview.toString('hex', 0, 8), '89504e470d0a1a0a');
  const psd = readPsd(await api('GET', path + '/export', 200), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  assert.deepEqual(psd.children.map(layer => layer.name), ['Background', 'Subject', 'Caption']);
  assert.equal(psd.children[2].text.text, layout.caption.text);
}

export async function verifyAsset(api, asset) {
  assert.equal((await api('GET', '/v1/assets/' + asset.id, 200)).sha256, asset.sha256);
  const download = await api('GET', '/v1/assets/' + asset.id + '/content', 200);
  assert.equal(download.length, 10 * 1024 * 1024);
  assert.equal(digest(download), asset.sha256);
}

export async function exerciseFilesAndWorker(api) {
  const bytes = boundaryPng();
  const uploaded = await api('POST', '/v1/assets', 201, {
    name: 'fixture.png', mediaType: 'image/png', source: 'synthetic', purpose: 'deployment verification',
    dataBase64: bytes.toString('base64'),
  });
  const asset = { id: uploaded.id, sha256: digest(bytes) };
  await verifyAsset(api, asset);

  const input = { capabilityId: 'copywriting.detect-terms', mode: 'workflow', idempotencyKey: randomUUID(),
    parameters: { content: '😀第一，100%最好' } };
  const task = await api('POST', '/v1/tasks', 202, input);
  assert.equal((await api('POST', '/v1/tasks', 200, input)).id, task.id);
  let result;
  const deadline = Date.now() + 30000;
  do {
    result = await api('GET', '/v1/tasks/' + task.id, 200);
    if (!['queued', 'running'].includes(result.state)) break;
    await delay(200);
  } while (Date.now() < deadline);
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(result.result.matches.map(match => match.start), [2, 5, 9]);
  assert.deepEqual(await api('GET', '/v1/credits/wallet', 200), { balance: 4, reserved: 0, available: 4 });
  return { asset, taskId: task.id };
}

// Each shirt occupies 100 x 100 pixels, so one covered pixel is 0.01 percent.
export function reviewPicture(width,people,covered=0) {
  const height=1080;
  const stride=width+1; // One filter byte followed by grayscale pixels.
  const pixels=Buffer.alloc(stride*height);
  function rectangle(x,y,w,h,gray) {
    for (let line=y;line<y+h;line++) {
      const start=stride*line+1+x;
      pixels.fill(gray,start,start+w);
    }
  }
  rectangle(10,50,100,100,180);
  for (let i=0;i<people;i++) {
    const x=200+i*200;
    rectangle(x+25,180,50,50,220);
    rectangle(x,230,100,100,160);
    rectangle(x,230,100,Math.floor(covered/100),80);
    rectangle(x,230+Math.floor(covered/100),covered%100,1,80);
  }
  const header=Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height,4);
  header[8]=8;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),
    pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
}

export async function exerciseImagePreflight(api) {
  const counts=async()=>({
    tasks:(await api('GET','/v1/tasks',200)).items.map(task=>task.id),
    ledger:(await api('GET','/v1/credits/ledger',200)).items,
    wallet:await api('GET','/v1/credits/wallet',200),
  });
  const before=await counts();
  async function review(width,people,pixels) {
    const asset=await api('POST','/v1/assets',201,{name:'synthetic.png',mediaType:'image/png',source:'synthetic',
      purpose:'source acceptance',consentReference:'qa-drawing',consentExpiresAt:new Date(Date.now()+86400000).toISOString(),
      dataBase64:reviewPicture(width,people,pixels).toString('base64')});
    const result=await api('PUT','/v1/media/images/'+asset.id+'/preflight',200,
      {revision:0,personCount:people,occlusionPercent:pixels/100});
    assert.equal(result.width,width);
    return {asset,result};
  }
  const product=await review(1024,0,0);
  assert.ok(product.result.eligible);
  assert.ok((await review(1024,1,500)).result.eligible);
  for (const [width,people,pixels,reason] of [[1023,1,500,'SHORT_SIDE'],[1024,1,501,'OCCLUSION'],[1024,2,0,'PERSON_COUNT']]) {
    const {asset,result}=await review(width,people,pixels);
    assert.deepEqual(result.reasons,[reason]);
    for (const capabilityId of ['image.try-on','image.replace-product']) {
      const reply=await api('POST','/v1/tasks',422,{capabilityId,mode:'workflow',idempotencyKey:randomUUID(),
        parameters:{assetIds:[asset.id,product.asset.id]}});
      assert.equal(reply.error.code,'IMAGE_PREFLIGHT_FAILED');
      assert.ok(reply.error.message.includes(reason));
    }
  }
  assert.deepEqual(await counts(),before);
}

export async function exerciseCustomer(api) {
  const base = await api('POST', '/v1/knowledge/bases', 201, { name: 'Synthetic product and FAQ collection' });
  const products = [];
  for (const volume of [350,750]) {
    const product=await api('POST','/v1/studio/products',201,{sku:'QA-CUP-'+volume,name:'测试保温杯',description:volume+'毫升'});
    products.push(product);
  }
  const documents = [];
  for (const kind of ['商品', '问答']) {
    for (let i = 0; i < 20; i++) {
      const keyword = 'QA' + (kind === '商品' ? 'P' : 'F') + String(i).padStart(3, '0');
      const productIndex=i%2;
      let content = kind === '商品' ? keyword + ' 的包装数量为 ' + (i + 2) + ' 件。'
        : keyword + ' 的保养周期为 ' + (i + 1) + ' 天。';
      if (kind==='商品' && i<2) content+=' 杯身净容量为'+products[productIndex].description+'。';
      const customerScope = kind==='商品' ? {productId:products[productIndex].id} : {general:true};
      const document = await api('POST', '/v1/knowledge/bases/' + base.id + '/documents', 201, { name: keyword, content, customerScope });
      documents.push({ keyword, content, id: document.id, productIndex });
    }
  }
  const root = '/v1/customer-service/conversations';
  const create = productId => api('POST', root, 201, { subject: '测试咨询', knowledgeBaseIds: [base.id], productId });
  const conversations=[];
  for (const [index,product] of products.entries()) {
    const conversation=await create(product.id);
    const messages=root+'/'+conversation.id+'/messages';
    const capacity=await api('POST',messages,201,{content:'杯身净容量'});
    assert.equal(capacity.assistant.content,documents[index].content);
    assert.deepEqual(capacity.assistant.sources.map(source=>source.documentId),[documents[index].id]);
    conversations.push({conversation,messages});
  }
  const sample = [];
  let active;
  for (let i = 0; i < 10; i++) {
    const [doc] = documents.splice(randomInt(documents.length), 1);
    active=conversations[doc.productIndex];
    const turn = await api('POST', active.messages, 201, { content: '请查一下 ' + doc.keyword + ' 的资料。' });
    assert.equal(turn.assistant?.sources[0].documentId, doc.id, doc.keyword);
    assert.equal(turn.assistant.content, doc.content);
    sample.push(doc);
  }
  const {conversation,messages}=active;
  for (let i = 0; i < 5; i++) {
    const turn = await api('POST', messages, 201, { content: '请再说一遍？' });
    assert.equal(turn.assistant?.sources[0].documentId, sample.at(-1).id);
  }
  const other = await create();
  assert.equal((await api('POST', root + '/' + other.id + '/messages', 201, { content: '请再说一遍？' })).assistant, null);
  assert.equal((await api('POST', root + '/' + conversation.id + '/handoff', 200)).state, 'human');
  assert.equal((await api('POST', messages, 201, { content: '请求人工帮助。' })).assistant, null);
  return sample.map(doc => doc.keyword);
}
