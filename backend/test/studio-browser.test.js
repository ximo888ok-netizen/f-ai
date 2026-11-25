import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { migrate, postgres } from '../src/db.js';
import { GeneratedFile } from '../src/model-file.js';
import { createProviders, ProviderError } from '../src/providers.js';
import { createVideoDelivery } from '../src/video-delivery.js';
import { provisionCredits } from '../src/wallet.js';
import { startWorker } from '../src/worker.js';

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

async function open(page, origin, route, target) {
  await page.goto(origin + '/#' + route);
  await target.waitFor();
}

const responseFor = (page, method, pathname) => page.waitForResponse(response =>
  response.request().method() === method && new URL(response.url()).pathname === pathname && response.ok());

test('the served glass workbench completes account, service, image, draft and export workflows in a browser',
  { skip: !playwrightPath, timeout: 120000 }, async t => {
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
        return { type: 'text', text: '保留陶瓷杯原色，使用自然侧光表现釉面。' };
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
    await form(page, 'auth').locator('[name=type]').selectOption('enterprise');
    const registered = responseFor(page, 'POST', '/v1/auth/register');
    await save(page, 'auth', { email: randomUUID() + '@example.test', password: 'browser-fixture-password',
      displayName: '联调人员', workspaceName: '玻璃联调企业' });
    const session = await (await registered).json();
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
    await page.getByRole('link', { name: '在商家后台管理成员' }).click();
    await save(page, 'invite', { email: inviteEmail });
    await page.locator('[data-ticket]').waitFor();
    const invitation = await page.locator('[data-ticket]').inputValue();
    const invitee = await browser.newPage({ reducedMotion: 'reduce' });
    await invitee.goto(invitation);
    await invitee.getByRole('button', { name: '创建账号', exact: true }).click();
    await save(invitee, 'auth', { email: inviteEmail, password: 'invitee-fixture-password', displayName: '邀请验收' });
    await form(invitee, 'accept').locator('button').click();
    await invitee.getByRole('heading', { name: '电商工作台', exact: true }).waitFor();
    await invitee.locator('#profile').click();
    assert.equal(await invitee.locator('#workspace-selector').inputValue(), workspace);
    await invitee.close();

    await open(page, origin, 'resources', form(page, 'new-base'));
    await save(page, 'new-base', { name: '陶瓷商品资料' });
    await form(page, 'add-doc').waitFor();
    await form(page, 'add-doc').locator('[name=customerScope]').selectOption('general');
    await save(page, 'add-doc', { name: '容量手册', category: '规格', content: '陶瓷杯容量为350毫升。' });
    await page.getByText('容量手册', { exact: true }).waitFor();
    const base = (await read('/v1/knowledge/bases')).items[0];
    await open(page, origin, 'customer', form(page, 'new-conversation'));
    await form(page, 'new-conversation').locator('[name=baseId]').selectOption(base.id);
    await save(page, 'new-conversation', { subject: '容量咨询' });
    await form(page, 'message').waitFor();
    await save(page, 'message', { content: '陶瓷杯的容量？', search: '容量' });
    await page.getByText('陶瓷杯容量为350毫升。', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: '接管会话' }).click();
    await page.getByText('人工接待', { exact: true }).waitFor();
    await save(page, 'message', { content: '人工客服已回复。' });
    await page.getByText('人工客服已回复。', { exact: true }).waitFor();

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
    await save(page, 'save-draft', { title: '陶瓷杯上新', specification: '350ml', sku: 'CUP-350', price: '49.9', stock: '10' });
    await page.getByRole('heading', { name: '陶瓷杯上新', exact: true }).waitFor();
    const draft = (await read('/v1/studio/pinduoduo-drafts')).items[0];

    await open(page, origin, 'desk/image', page.getByRole('link', { name: '商品组图方案', exact: true }));
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

    await open(page, origin, 'drafts/new/plan/' + planId, form(page, 'save-draft'));
    assert.equal(await form(page, 'save-draft').locator('[name=image-main]').inputValue(), plan.images[0].assetId);
    assert.equal(await form(page, 'save-draft').locator('[name=image-detail] option:checked').getAttribute('value'), plan.images[1].assetId);
    await open(page, origin, 'create/image/image.detail-page', page.locator('[data-brief-assist]'));
    const prompt = page.locator('[name="params.prompt"]');
    await prompt.fill('陶瓷杯，保留原色');
    await page.locator('[data-brief-assist]').click();
    await page.waitForFunction(() => document.querySelector('[name="params.prompt"]').value.includes('自然侧光'));

    await open(page, origin, 'commerce', form(page, 'book'));
    await save(page, 'book', { name: '商品运营台账' });
    await page.getByRole('heading', { name: '商品运营台账', exact: true }).waitFor();
    await open(page, origin, 'drafts/' + draft.id + '/inventory', form(page, 'inventory-preview'));
    await form(page, 'inventory-preview').locator('button').click();
    await page.getByRole('button', { name: '确认写入台账' }).click();
    await page.getByText('CUP-350', { exact: false }).first().waitFor();

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

    if (videoDelivery) {
      await open(page, origin, 'media/storyboards/new', form(page, 'storyboard-save'));
      await form(page, 'storyboard-save').locator('[name=assetId]').selectOption(asset.id);
      await save(page, 'storyboard-save', { title: '商品展示分镜' });
      const [video] = await Promise.all([page.waitForEvent('download'),
        page.getByRole('button', { name: '合成并下载 MP4' }).click()]);
      assert.equal((await readFile(await video.path())).subarray(4, 8).toString(), 'ftyp');
    }

    await open(page, origin, 'inbox', page.getByRole('button', { name: '全部标为已读' }));
    await page.getByRole('button', { name: '全部标为已读' }).click();
    await page.getByText('0 条未读', { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: '消息中心', exact: true }).waitFor();
    assert.equal((await read('/v1/notifications?limit=1')).unread, 0);
    assert.deepEqual(errors, []);
  });
