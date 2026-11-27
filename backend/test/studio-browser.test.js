import { buildAuthTestApp as buildApp, deliveredCode, fixtureIdentity } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { PGlite } from '@electric-sql/pglite';

import { migrate, postgres } from '../src/db.js';
import { GeneratedFile } from '../src/model-file.js';
import { createProviders, ProviderError } from '../src/providers.js';
import { createVideoDelivery } from '../src/video-delivery.js';
import { provisionCredits } from '../src/wallet.js';
import { startWorker } from '../src/worker.js';
import { watchControls } from '../test-support/ui-control-report.js';

const playwrightPath = process.env.FAI_TEST_PLAYWRIGHT_PATH;
const ffmpeg = process.env.FAI_TEST_FFMPEG_PATH;
const ffprobe = process.env.FAI_TEST_FFPROBE_PATH;
const imagePlanPath = '/v1/media/images/product-plans';

function image(color) {
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 64, 64);
  return canvas.toBuffer('image/png');
}

function form(page, name) {
  return page.locator('[data-form="' + name + '"]');
}

async function save(page, name, values) {
  const editor = form(page, name);
  for (const [field, value] of Object.entries(values)) {
    await editor.locator('[name="' + field + '"]').fill(value);
  }
  await editor.locator('button[type=submit], button:not([type])').last().click();
}

async function registerFromPage(page, app, email, password, workspaceName) {
  const editor = form(page, 'auth');
  const identity = fixtureIdentity(email);
  for (const [key,value] of Object.entries({...identity,email,password})) await editor.locator('[name='+key+']').fill(value);
  if(workspaceName) {
    await editor.locator('[name=type]').selectOption('enterprise');
    await editor.locator('[name=workspaceName]').fill(workspaceName);
  }
  await editor.getByRole('button',{name:'下一步'}).click();
  for(const [channel,target,field] of [['sms',identity.phone,'phoneCode'],['email',email,'emailCode']]) {
    const sent=responseFor(page,'POST','/v1/auth/verification-codes');
    await editor.locator('[data-send-code='+channel+']').click();
    assert.equal((await sent).status(),200);
    await editor.locator('[name='+field+']').fill(deliveredCode(app,channel,target));
  }
  const registered=responseFor(page,'POST','/v1/auth/register');
  await editor.getByRole('button',{name:'注册并登录'}).click();
  const res=await registered;
  assert.equal(res.status(),201);
  return res.json();
}

async function open(page, origin, route, target) {
  await page.goto(origin + '/#' + route);
  await target.waitFor();
}

const responseFor = (page, method, pathname) => page.waitForResponse(response =>
  response.request().method() === method && new URL(response.url()).pathname === pathname && response.ok());

test('the served workbench completes tasks, merchant settings, drafts, ledger, service and media workflows in a browser',
  { skip: !playwrightPath, timeout: 240000 }, async t => {
    const covered = description => t.diagnostic('Browser check passed: ' + description);
    const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
    const providers = createProviders();
    const shops = new Map();
    const sourceBytes = image('#406ab0');
    const renderedBytes = image('#cc8a21');
    let detailAttempts = 0;
    providers.set('model:browser-image', {
      info: { id: 'browser-image', model: 'Browser image fixture', protocol: 'openai-images', kind: 'image',
        streamText: false, capabilities: ['image.main-image'] },
      supports: capability => capability.id === 'image.main-image',
      run: async (_task, payload) => {
        assert.deepEqual(Buffer.from(payload.assets[0].dataBase64, 'base64'), sourceBytes);
        if (payload.parameters.prompt.includes('图片标题：陶瓷杯细节') && ++detailAttempts === 1) {
          throw new ProviderError('INVALID_PROVIDER_IMAGE');
        }
        return new GeneratedFile(renderedBytes, 'image/png', {});
      },
    });
    providers.set('model:browser-text', {
      info: { id: 'browser-text', model: 'Browser text fixture', protocol: 'openai-chat', kind: 'text',
        streamText: false, capabilities: ['model.chat'] },
      supports: capability => capability.id === 'model.chat',
      run: async (_task, payload) => {
        assert.match(payload.parameters.messages[1].content, /陶瓷杯/);
        const answer = '保留陶瓷杯原色，使用自然侧光表现釉面。';
        const isAssistant = payload.parameters.messages[0].content.includes('意图解析器');
        return { type: 'text', text: isAssistant ? JSON.stringify({ action: 'answer', value: answer }) : answer };
      },
    });
    const videoDelivery = ffmpeg && ffprobe ? createVideoDelivery({ ffmpeg, ffprobe, encoder: 'libx264' }) : null;
    let app, browser, stopWorker;
    t.after(async () => {
      try { await browser?.close(); }
      finally {
        await Promise.all([stopWorker?.(), app?.close()]);
        await db.close();
      }
    });
    await migrate(db);
    app = await buildApp({ db, providers, shops, videoDelivery });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    stopWorker = startWorker({ db, providers, shops }, app.log);
    browser = await createRequire(import.meta.url)(playwrightPath).chromium.launch({
      channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'],
    });
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await watchControls(t, page.context());
    const errors = [];
    page.on('response', response => {
      if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/v1/')) {
        t.diagnostic(response.status() + ' ' + response.request().method() + ' ' + new URL(response.url()).pathname);
      }
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (!response.ok() && new URL(response.url()).pathname.startsWith('/studio/')) {
        errors.push(response.status() + ' ' + response.url());
      }
    });
    page.setDefaultTimeout(15000);
    await page.goto(origin);
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    const session = await registerFromPage(page, app, randomUUID()+'@example.test','browser-fixture-password','玻璃联调企业');
    const workspace = session.workspaces[0].id;
    await provisionCredits(db, workspace, session.account.id, 100, 'studio-browser-integration');
    const headers = { authorization: 'Bearer ' + session.token, 'x-workspace-id': workspace };
    const read = async path => {
      const response = await page.request.get(origin + path, { headers });
      assert.equal(response.status(), 200, path);
      return response.json();
    };
    await page.getByRole('heading', { name: '电商工作台', exact: true }).waitFor();
    await page.locator('#profile').click();
    await page.getByRole('link', { name: 'AI 加油站', exact: true }).click();
    await page.getByText('100 可用积分', { exact: true }).waitFor();
    await page.locator('#profile').click();
    await page.getByRole('link', { name: '去邀约', exact: true }).click();
    await page.getByRole('heading', { name: '接受企业邀请' }).waitFor();

    const inviteEmail = randomUUID() + '@example.test';
    assert.equal(await page.locator('a[href^="/merchant"]').count(), 0);
    await page.goto(origin + '/merchant#members');
    const invitationCreated = responseFor(page, 'POST', '/v1/invitations');
    await save(page, 'invite', { email: inviteEmail });
    await invitationCreated;
    await page.locator('[data-ticket]').waitFor();
    const invitation = await page.locator('[data-ticket]').inputValue();
    const invitee = await browser.newPage({ reducedMotion: 'reduce' });
    await watchControls(t, invitee.context());
    await invitee.goto(invitation);
    await invitee.getByRole('button', { name: '创建账号', exact: true }).click();
    await registerFromPage(invitee, app, inviteEmail, 'invitee-fixture-password');
    await form(invitee, 'accept').locator('button').click();
    await invitee.getByRole('heading', { name: '电商工作台', exact: true }).waitFor();
    await invitee.locator('#profile').click();
    assert.equal(await invitee.locator('#workspace-selector').inputValue(), workspace);
    await invitee.close();

    const auditRead = responseFor(page, 'GET', '/v1/merchant/audit-events');
    await page.getByRole('link', { name: '操作记录', exact: true }).click();
    await auditRead;
    await form(page, 'audit-filter').waitFor();
    covered('商家后台创建与接受邀请，读取操作记录');

    await open(page, origin, 'resources/manage', form(page, 'new-base'));
    await save(page, 'new-base', { name: '陶瓷商品资料' });
    await form(page, 'add-doc').waitFor();
    await form(page, 'add-doc').locator('[name=customerScope]').selectOption('general');
    await save(page, 'add-doc', { name: '容量手册', category: '规格', content: '陶瓷杯容量为350毫升。' });
    await page.getByText('容量手册', { exact: true }).waitFor();
    const base = (await read('/v1/knowledge/bases')).items[0];
    const newConversation = page.locator('[data-inbox-new]').first();
    await open(page, origin, 'customer', newConversation);
    await newConversation.click();
    await form(page, 'new-conversation').locator('[name=baseId]').selectOption(base.id);
    await save(page, 'new-conversation', { subject: '容量咨询' });
    await page.getByText('检索选项', { exact: true }).click();
    await page.getByLabel('知识检索关键词').fill('容量');
    await page.getByLabel('客户消息').fill('陶瓷杯的容量？');
    await page.getByRole('button', { name: '发送客户消息', exact: true }).click();
    await page.getByText('陶瓷杯容量为350毫升。', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: '人工接管', exact: true }).click();
    await page.getByLabel('客服回复').fill('人工客服已回复。');
    await page.getByRole('button', { name: '发送人工回复', exact: true }).click();
    await page.getByText('人工客服已回复。', { exact: true }).waitFor();
    covered('知识库上传、客服应答与人工接管');

    await open(page, origin, 'assets', form(page, 'upload'));
    await form(page, 'upload').locator('[name=file]').setInputFiles({ name: 'product.png', mimeType: 'image/png', buffer: sourceBytes });
    const uploaded = responseFor(page, 'POST', '/v1/assets');
    await save(page, 'upload', { source: '自有测试素材', purpose: '商品图联调' });
    const asset = await (await uploaded).json();

    await open(page, origin, 'assets/' + asset.id, form(page, 'source-review'));
    await save(page, 'source-review', { personCount: '0', occlusionPercent: '0' });
    await page.getByText('图片短边不足 1024 像素', { exact: false }).waitFor();

    await open(page, origin, 'drafts/new', form(page, 'save-draft'));
    await form(page, 'save-draft').locator('[name=image-main]').selectOption(asset.id);
    const draftCreated = page.waitForResponse(response => response.ok() && response.request().method() === 'PUT' &&
      /^\/v1\/studio\/pinduoduo-drafts\/[^/]+$/.test(new URL(response.url()).pathname));
    await save(page, 'save-draft', { title: '陶瓷杯上新', specification: '350ml', sku: 'CUP-350', price: '49.9', stock: '10' });
    await page.getByRole('heading', { name: '陶瓷杯上新', exact: true }).waitFor();
    const draft = await (await draftCreated).json();
    covered('素材上传与源图检查，创建商品草稿');

    const stages = page.getByRole('navigation', { name: '核心工作区切换' });
    const homeRead = responseFor(page, 'GET', '/v1/plugins');
    await stages.getByRole('link', { name: '电商工作台', exact: true }).click();
    await homeRead;
    await page.getByRole('heading', { name: '电商工作台', exact: true }).waitFor();
    covered('从顶部导航进入电商工作台并读取插件目录');
    const workbenchRead = responseFor(page, 'GET', '/v1/tasks');
    await stages.getByRole('link', { name: '图片生成', exact: true }).click();
    await workbenchRead;
    await page.getByRole('link', { name: '商品组图方案', exact: true }).click();
    await form(page, 'image-plan-create').locator('[name=assetId]').selectOption(asset.id);
    await save(page, 'image-plan-create', { productName: '陶瓷杯组图', requirements: '保留浅色陶瓷杯外观。', detailCount: '1' });
    await form(page, 'image-plan-edit').waitFor();
    const planId = new URL(page.url()).hash.split('/').at(-1);
    await form(page, 'image-plan-edit').locator('[name=imageTitle]').nth(1).fill('陶瓷杯细节');
    assert.equal(await form(page, 'image-plan-confirm').locator('button').isDisabled(), true);
    await save(page, 'image-plan-edit', { designNotes: '统一使用自然侧光。' });
    await form(page, 'image-plan-confirm').locator('[name=modelId]').selectOption('browser-image');
    await form(page, 'image-plan-confirm').locator('button').click();
    await page.getByRole('button', { name: '重试此图' }).click();
    await page.getByText('全部完成', { exact: true }).waitFor();
    const plan = await read(imagePlanPath + '/' + planId);
    assert.deepEqual(plan.images.map(entry => entry.state), ['succeeded', 'succeeded']);
    assert.equal(plan.images[1].attempt, 2);
    const [download] = await Promise.all([page.waitForEvent('download'),
      page.getByRole('button', { name: '下载带标识图片' }).first().click()]);
    const delivered = await readFile(await download.path());
    assert.equal(delivered.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.notDeepEqual(delivered, renderedBytes);
    await form(page, 'image-plan-apply').locator('[name=detailPosition]').selectOption('1');
    await form(page, 'image-plan-apply').locator('button').click();
    await page.getByRole('heading', { name: '陶瓷杯上新', exact: true }).waitFor();
    const adjusted = await read('/v1/studio/pinduoduo-drafts/' + draft.id);
    assert.deepEqual(adjusted.images, plan.images.map(entry => ({ role: entry.role, assetId: entry.assetId })));
    const wallet = await read('/v1/credits/wallet');
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.available, 100 - plan.estimatedCredits);
    covered('商品组图创建、确认、失败重试、下载并应用到草稿（本地模型替身）');

    await open(page, origin, 'drafts/new/plan/' + planId, form(page, 'save-draft'));
    assert.equal(await form(page, 'save-draft').locator('[name=image-main]').inputValue(), plan.images[0].assetId);
    assert.equal(await form(page, 'save-draft').locator('[name=image-detail] option:checked').getAttribute('value'), plan.images[1].assetId);
    await open(page, origin, 'create/image/image.detail-page', page.locator('[data-brief-assist]'));
    const prompt = page.locator('[name="params.prompt"]');
    await prompt.fill('陶瓷杯，保留原色');
    await page.locator('[data-brief-assist]').click();
    await page.waitForFunction(() => document.querySelector('[name="params.prompt"]').value.includes('自然侧光'));

    const ledgerTab = page.getByRole('tab', { name: /运营台账/ });
    await open(page, origin, 'commerce', ledgerTab);
    await ledgerTab.click();
    const bookCreated = responseFor(page, 'POST', '/v1/studio/pinduoduo/books');
    await save(page, 'book', { name: '商品运营台账' });
    const book = await (await bookCreated).json();
    await page.getByRole('heading', { name: '商品运营台账', exact: true }).waitFor();
    await open(page, origin, 'drafts/' + draft.id + '/inventory', form(page, 'inventory-preview'));
    const inventoryImport = '/v1/studio/pinduoduo/books/' + book.id + '/records/inventory/draft-import';
    const inventoryPreviewed = responseFor(page, 'POST', inventoryImport + '/preview');
    await form(page, 'inventory-preview').locator('button').click();
    assert.equal((await (await inventoryPreviewed).json()).ready, true);
    const inventoryWritten = responseFor(page, 'POST', inventoryImport + '/confirm');
    await page.getByRole('button', { name: '确认写入台账' }).click();
    assert.equal((await (await inventoryWritten).json()).inserted, 1);
    await page.waitForURL(origin + '/#desk/operations/' + book.id + '/inventory');
    await page.getByText('CUP-350', { exact: false }).first().waitFor();
    covered('创建运营台账、预览并确认库存写入');

    await stages.getByRole('link', { name: '新建任务', exact: true }).click();
    await page.locator('.composer-model').click();
    await page.locator('[data-model-id="browser-text"]').click();
    await page.locator('.agent-home textarea').fill('为陶瓷杯建议布光方式。');
    const taskCreated = responseFor(page, 'POST', '/v1/tasks');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const modelTask = await (await taskCreated).json();
    await page.locator('.agent-log').getByText('模型建议：保留陶瓷杯原色，使用自然侧光表现釉面。', { exact: true }).waitFor();
    assert.equal((await read('/v1/tasks/' + modelTask.id)).state, 'succeeded');
    covered('新建任务提交、后台执行、浏览器显示结果（本地模型替身）');

    await page.locator('#profile').click();
    await page.getByRole('link', { name: '设置与诊断', exact: true }).click();
    const preferences = form(page, 'settings').locator('[name=taskNotifications]');
    await preferences.uncheck();
    const preferencesSaved = responseFor(page, 'PATCH', '/v1/settings');
    const preferencesReloaded = responseFor(page, 'GET', '/v1/settings');
    await save(page, 'settings', {});
    assert.equal((await (await preferencesSaved).json()).preferences.taskNotifications, false);
    await preferencesReloaded;
    const health = responseFor(page, 'GET', '/health');
    const ready = responseFor(page, 'GET', '/ready');
    await page.getByRole('button', { name: '检查服务和数据库', exact: true }).click();
    await Promise.all([health, ready]);
    await page.locator('#checks').getByText('数据库与迁移', { exact: true }).waitFor();
    await page.reload();
    await preferences.waitFor();
    assert.equal(await preferences.isChecked(), false);
    covered('保存工作区偏好、检查服务与数据库、刷新后确认设置');

    await open(page, origin, 'copy-drafts/new', form(page, 'copy-draft-edit'));
    await save(page, 'copy-draft-edit', { title: '上新文案', content: '350 毫升陶瓷杯，规格清晰。' });
    await page.getByRole('heading', { name: '上新文案', exact: true }).waitFor();
    const [text] = await Promise.all([page.waitForEvent('download'),
      page.getByRole('button', { name: '导出已保存版本' }).click()]);
    assert.equal(await readFile(await text.path(), 'utf8'), '350 毫升陶瓷杯，规格清晰。');

    await open(page, origin, 'psd/new', form(page, 'psd-save'));
    await form(page, 'psd-save').locator('[name=subjectAssetId]').selectOption(asset.id);
    await save(page, 'psd-save', { title: '三层商品设计', caption: '陶瓷杯' });
    const [psd] = await Promise.all([page.waitForEvent('download'),
      page.getByRole('button', { name: '下载分层 PSD' }).click()]);
    assert.equal((await readFile(await psd.path())).subarray(0, 4).toString(), '8BPS');
    covered('导出已保存文案与分层 PSD');

    if (videoDelivery) {
      await open(page, origin, 'media/storyboards/new', form(page, 'storyboard-save'));
      await form(page, 'storyboard-save').locator('[name=assetId]').selectOption(asset.id);
      await save(page, 'storyboard-save', { title: '商品展示分镜' });
      const [video] = await Promise.all([page.waitForEvent('download'),
        page.getByRole('button', { name: '合成并下载 MP4' }).click()]);
      assert.equal((await readFile(await video.path())).subarray(4, 8).toString(), 'ftyp');
      covered('通过真实 ffmpeg 合成与下载 MP4');
    }

    await open(page, origin, 'inbox', page.getByRole('button', { name: '全部标为已读' }));
    await page.getByRole('button', { name: '全部标为已读' }).click();
    await page.getByText('0 条未读', { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: '消息中心', exact: true }).waitFor();
    assert.equal((await read('/v1/notifications?limit=1')).unread, 0);
    assert.deepEqual(errors, []);
    covered('消息标记已读并确认刷新后的状态');
  });
