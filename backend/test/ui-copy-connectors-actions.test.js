import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { dispatchFeishuReply } from '../src/feishu-channel.js';
import { createStudioFixture } from '../test-support/ui-actions.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 160000 };

test('copywriting platform switches, rule edits, review corrections and draft exports', options, async t => {
  const { page, open, act, read } = await createStudioFixture(t);
  const rulesFor = platform => '/v1/copywriting/rules/' + platform;
  const rules = page.locator('[data-form=copy-rules]');
  await open('copy-review/pinduoduo', rules);
  for (const platform of ['pinduoduo','taobao','douyin']) {
    if (platform !== 'pinduoduo') {
      await act('切换校验平台 ' + platform, page.locator('a[href="#copy-review/' + platform + '"]'), {
        method: 'GET', path: rulesFor(platform), status: 404 });
      await page.waitForFunction(() => document.querySelector('[data-form=copy-rules] [name=titleLimit]')?.value === '');
    }
    await rules.locator('[name=titleLimit]').fill('30');
    await rules.locator('[name=sellingPointLimit]').fill('45');
    await rules.locator('[name=forbiddenPhrases]').fill('禁用测试词');
    await act('保存规则 ' + platform, rules.getByRole('button'), { method:'PUT', path:rulesFor(platform) });
    assert.deepEqual((await read(rulesFor(platform))).forbiddenPhrases, ['禁用测试词']);
    const review = page.locator('[data-form=copy-review]');
    await review.locator('[name=title]').fill('第一批合成商品');
    await review.locator('[name=sellingPoints]').fill('包装完整');
    const reviewed = await act('校验文案 ' + platform, review.getByRole('button'), {method:'POST',path:'/v1/copywriting/review'});
    assert.ok((await reviewed.json()).issues.some(i => i.code === 'REVIEW_TERM' && i.term === '第一'));
    const corrected = await act('应用建议并复检 ' + platform, page.locator('[data-apply-copy]'), {method:'POST',path:'/v1/copywriting/review'});
    assert.equal((await corrected.json()).passed, true);
    await page.getByText('文案通过工作区规则校验。').waitFor();
    assert.equal(await review.locator('[name=title]').inputValue(), '表现突出批合成商品');
  }
  await page.locator('a[href="#copy-drafts"]:visible').last().click();
  await page.getByRole('link', {name:'新建文案'}).click();
  const editor = page.locator('[data-form=copy-draft-edit]');
  const title = '合成文案验收';
  await editor.locator('[name=title]').fill(title);
  await editor.locator('[name=content]').fill('合成初稿');
  const target = /^\/v1\/copywriting\/drafts\/[\da-f-]+$/;
  const creation = await act('新建文案草稿',editor.getByRole('button'),{method:'PUT',path:target});
  const draft = await creation.json();
  await page.getByRole('heading',{name:title,exact:true}).waitFor();
  await editor.locator('[name=content]').fill('合成修订稿');
  await act('更新文案草稿', editor.getByRole('button'), {method:'PUT',path:target});
  assert.equal((await read('/v1/copywriting/drafts/'+draft.id)).content,'合成修订稿');
  await page.getByRole('link',{name:'返回文案草稿'}).click();
  await page.getByRole('link',{name:'打开文案'}).click();
  assert.equal(await editor.locator('[name=content]').inputValue(),'合成修订稿');
  const [download] = await Promise.all([page.waitForEvent('download'),act('导出保存的文案',page.locator('[data-copy-draft-download]'),{
    method:'GET',path:'/v1/copywriting/drafts/'+draft.id+'/export'})]);
  assert.equal(await readFile(await download.path(),'utf8'),'合成修订稿');
});

test('cloud backup cancellation, confirmed upload, byte-exact download and restore; channel send and refresh',options,async t => {
  const cloudAssets = new Map(), feishu = new Map();
  const { page, open, act, api, read, workspace, db, app } = await createStudioFixture(t,{cloudAssets,feishu});
  const copies = new Map();
  const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
  const image = createCanvas(8,8).toBuffer('image/png');
  cloudAssets.set(workspace,{fingerprint:checksum('store'),write:async (name,bytes) => copies.set(name,Buffer.from(bytes)),
    read:async (name,length,hash) => {
      const bytes = copies.get(name);
      assert.equal(bytes.length,length);
      assert.equal(checksum(bytes),hash);
      return bytes;
    }});
  const asset = await api('POST','/v1/assets',{name:'synthetic.png',mediaType:'image/png',source:'合成',purpose:'验收',dataBase64:image.toString('base64')});
  const backup = '/v1/cloud-assets/'+asset.id;
  const button = page.locator('[data-cloud-backup="'+asset.id+'"]');
  await open('assets',button);
  page.once('dialog',d=>d.dismiss());
  await button.click();
  assert.equal((await read('/v1/cloud-assets')).items.length,0);
  page.once('dialog',d=>d.accept());
  await act('备份到网盘',button,{method:'PUT',path:backup});
  const [file] = await Promise.all([page.waitForEvent('download'),act('下载备份',page.locator('[data-cloud-download]'),{method:'GET',path:backup+'/content'})]);
  assert.deepEqual(await readFile(await file.path()),image);
  await api('DELETE','/v1/assets/'+asset.id);
  await act('恢复到素材库',page.locator('[data-cloud-restore]'),{method:'POST',path:backup+'/restore'});
  await button.waitFor();
  assert.equal((await read('/v1/assets/'+asset.id)).name,asset.name);
  const root = '/v1/channels/feishu';
  const thread = root+'/fixture/inbox/synthetic-event';
  const sent = [];
  feishu.set('fixture',{id:'fixture',workspaceId:workspace,fingerprint:checksum('channel'),
    verify:()=>({eventId:'synthetic-event',remoteMessageId:'test-message',content:'库存查询',chatId:'test-chat'}),
    send:async (chat,content) => { sent.push({chat,content});return 'test-reply'; }});
  const inbound = await app.inject({method:'POST',url:root+'/fixture/events',headers:{'content-type':'application/json'},payload:'{}'});
  assert.equal(inbound.statusCode,200,inbound.body);
  await open('feishu',page.getByRole('link',{name:'查看与回复'}));
  await act('查看飞书消息',page.getByRole('link',{name:'查看与回复'}),{method:'GET',path:thread});
  await page.locator('[data-form=feishu-send] textarea').fill('合成回复');
  await act('确认发送回复',page.locator('[data-form=feishu-send] button'),{method:'PUT',path:/\/replies\/[\da-f-]+$/});
  const refresh = page.locator('[data-feishu-refresh]');
  await refresh.waitFor();
  assert.equal((await read(thread)).items[0].state,'queued');
  assert.equal(await dispatchFeishuReply({db,feishu}),true);
  await act('刷新投递状态',refresh,{method:'GET',path:thread});
  await page.getByText(/已发送 ·/).waitFor();
  assert.deepEqual(sent,[{chat:'test-chat',content:'合成回复'}]);
});
