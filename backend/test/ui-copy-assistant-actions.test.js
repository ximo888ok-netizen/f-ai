import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { createStudioFixture } from '../test-support/ui-actions.js';

const options={skip:!process.env.FAI_TEST_PLAYWRIGHT_PATH,timeout:160000};

test('assistant starter buttons, attachment picker, crop and explicit draft confirmation',options,async t=>{
  const {page,open,act,read}=await createStudioFixture(t);
  await open('chat/new','.agent-starters');
  const fresh=async()=>{await page.locator('.agent-new').click();await page.locator('.agent-starters').waitFor();};
  const prompt=value=>page.locator('[data-prompt="'+value+'"]:visible');
  await act('助手：查商品',prompt('查看我的商品'),{method:'GET',path:'/v1/studio/products'});
  await page.locator('.agent-log').getByText(/当前工作区有 0 个商品/).waitFor();
  await fresh();
  await act('助手：最近任务',prompt('查看最近任务'),{method:'GET',path:'/v1/tasks'});
  await page.locator('.agent-log').getByText(/没有符合条件的任务/).waitFor();
  await fresh();
  await page.getByRole('button',{name:'访问范围',exact:true}).click();
  await page.locator('#composer-access:popover-open').getByText(/当前角色/).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.composer-model').click();
  await page.locator('[data-model-choice=local]').click();
  await page.locator('.composer-add').click();
  await act('助手：从空素材库选择',page.locator('[data-context-pick]'),{method:'GET',path:'/v1/assets'});
  await page.locator('[data-upload-main]').waitFor();
  await act('助手：重新选择素材',prompt('选择主图'),{method:'GET',path:'/v1/assets'});
  const png=createCanvas(60,60).toBuffer('image/png');
  const upload=async button=>{
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),button.click()]);
    const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/v1/assets') && r.request().method()==='POST'),
      chooser.setFiles({name:'合成参考.png',mimeType:'image/png',buffer:png})]);
    assert.equal(response.status(),201);
    await page.locator('.agent-attach:visible').waitFor();
  };
  await upload(page.locator('[data-upload-main]'));
  await page.locator('.agent-attach').click();
  await page.locator('.composer-add').click();
  await upload(page.locator('[data-context-upload]'));
  await fresh();
  await act('助手：方形主图',prompt('做方形主图'),{method:'GET',path:'/v1/assets'});
  await prompt('第1张').click();
  await act('助手：更换主图',prompt('更换主图'),{method:'GET',path:'/v1/assets'});
  await prompt('第1张').click();
  const response=await act('助手：确认出图',prompt('开始出图'),{method:'POST',path:'/v1/media/images/batches'});
  assert.equal((await response.json()).items[0].state,'succeeded');
  await fresh();
  await prompt('新建商品草稿').click();
  await page.locator('.agent-home textarea').fill('合成工作台草稿');
  await act('助手：命名并读取草稿候选主图',page.locator('.agent-send'),{method:'GET',path:'/v1/assets'});
  await prompt('第1张').click();
  assert.equal((await read('/v1/studio/pinduoduo-drafts')).items.length,0);
  await act('助手：确认保存商品草稿',prompt('保存草稿'),{method:'PUT',path:/\/v1\/studio\/pinduoduo-drafts\/[\da-f-]+$/});
  assert.equal((await read('/v1/studio/pinduoduo-drafts')).items[0].title,'合成工作台草稿');
  await fresh();
  await prompt('新建商品草稿').click();
  await prompt('取消').click();
  await page.locator('.agent-log').getByText('已结束当前操作。').waitFor();
  assert.equal((await read('/v1/studio/pinduoduo-drafts')).items.length,1);
  await page.locator('.agent-history').selectOption('0');
  await page.locator('.agent-log').getByText(/草稿已保存到当前工作区/).waitFor();
});

test('six onboarding confirmations persist individually and reset; image and video workflow control pairs',options,async t=>{
  const {page,open,act,read}=await createStudioFixture(t);
  await open('desk/operations',page.getByText(/上新操作清单/).first());
  for (const next of [1,2,3,4,5,6,0]) {
    const control=page.locator('[data-onboarding="'+next+'"]');
    const summary=page.locator('details').filter({has:control}).locator('summary');
    await summary.click();
    await act('上新清单步骤 '+next,control,{method:'PATCH',path:'/v1/settings'});
    assert.equal((await read('/v1/settings')).preferences.onboardingStep,next);
  }
  for (const route of ['desk/image','desk/image/advanced','desk/image/agent','desk/video','desk/video/quick','desk/video/director','desk/image/skills','desk/video/skills']) {
    const panel=page.locator('[data-dual-workflow]');
    await open(route,panel);
    await panel.locator('[data-dual-mode=chat]').click();
    const text='合成要求 '+route;
    await panel.locator('[data-dual-prompt]').fill(text);
    for (const chip of await panel.locator('[data-dual-chip]').all()) {
      await chip.click();
      assert.ok((await panel.locator('[data-dual-prompt]').inputValue()).includes(await chip.getAttribute('data-dual-chip')));
    }
    await panel.locator('[data-dual-apply]').click();
    const target=page.locator('.quick-image-form textarea[name=prompt],.quick-image-form textarea[name=notes],.video-composer textarea[name=prompt],[data-skill-run] textarea[name=prompt]').first();
    if(await target.count()) assert.ok((await target.inputValue()).startsWith(text),route);
    else assert.equal(await panel.locator('[data-dual-status]').innerText(),'当前工具无需填写创作要求。');
    await panel.locator('[data-dual-mode=flow]').click();
    const steps=panel.locator('[data-dual-step]');
    for (const [i,item] of (await steps.all()).entries()) {
      await item.click();
      assert.match(await panel.locator('[data-dual-step-desc]').innerText(),new RegExp('步骤 '+(i+1)+'/'));
    }
    await panel.locator('[data-dual-prev]').click();
    await panel.locator('[data-dual-next]').click();
    await panel.locator('[data-dual-next]').click();
    assert.equal(await steps.last().getAttribute('aria-current'),'step');
  }
});
