import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { createStudioFixture } from '../test-support/ui-actions.js';
import { studioRoutes, merchantRoutes, categories } from '../test-support/studio-routes.js';

const enabled = Boolean(process.env.FAI_TEST_PLAYWRIGHT_PATH);

function ready() {
  const main = document.querySelector(location.pathname === '/merchant' ? '#merchantContent' : '#main');
  return (document.querySelector('#commerce-directory')?.getBoundingClientRect().height > 0 ||
    (main?.firstElementChild && main.getBoundingClientRect().height > 0 && main.innerText.trim() &&
      !/正在读取(工作区|工作台|后台数据)…/.test(main.innerText)));
}

test('follow every distinct local navigation destination and switch each scene tab in the served directory', {
  skip: !enabled, timeout: 480000,
}, async t => {
  const { page, origin, api } = await createStudioFixture(t);
  for (const platform of ['taobao','pinduoduo','douyin']) {
    await api('PUT','/v1/copywriting/rules/'+platform,{revision:0,titleLimit:30,sellingPointLimit:50,forbiddenPhrases:[]});
  }
  const views = new Set([...studioRoutes,...categories].map(v => '/#'+v).concat(merchantRoutes.map(v=>'/merchant#'+v)));
  const checked = new Set(), tabsChecked = new Set();
  async function mount(route, tab) {
    await page.goto(origin+route);
    await page.waitForFunction(ready);
    if (tab) {
      const control = page.locator('[role=tab][aria-controls="'+tab+'"]');
      await control.click();
      assert.equal(await control.getAttribute('aria-selected'),'true');
      await page.locator('[id="'+tab+'"]').waitFor();
    }
  }
  for (const view of views) {
    await mount(view);
    const area = page.locator('#main:visible, #commerce-directory:visible, #merchantContent:visible').last();
    const tabs = await area.locator('[role=tab][aria-controls]:visible').evaluateAll(els=>els.map(e=>e.getAttribute('aria-controls')));
    for (const tab of tabs.length ? tabs : [null]) {
      if (tab) { await mount(view,tab); tabsChecked.add(view+' '+tab); }
      const links = await area.locator('a[href]:visible').evaluateAll(els => [...new Set(els.map(e=>e.getAttribute('href')))]);
      for (const href of links) {
        if (!href || !/^(?:#|\/(?:merchant)?#)/.test(href) || /^#(?:main|merchantContent)$/.test(href)) continue;
        const dest = new URL(href, page.url());
        const key = dest.pathname + dest.hash;
        if (checked.has(key)) continue;
        await mount(view, tab);
        const anchor = area.locator('a[href="'+href+'"]:visible').first();
        const visits = [page.url()];
        const record = frame => { if (frame === page.mainFrame()) visits.push(frame.url()); };
        page.on('framenavigated',record);
        try {
          await anchor.click();
          await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
        } finally { page.off('framenavigated',record); }
        assert.ok(visits.includes(dest.href) || page.url()===dest.href,'Wrong link destination '+view+' → '+href+' ('+visits.join(', ')+')');
        await page.waitForFunction(ready);
        assert.equal(new URL(page.url()).origin,origin);
        assert.equal(await page.locator('.live-error:visible,[data-retry]:visible,[data-form=auth]:visible').count(),0,'Broken link '+view+' → '+key);
        checked.add(key);
        const url = new URL(page.url());
        views.add(url.pathname+url.hash);
        assert.ok(views.size <= 600, 'Unbounded navigation from '+view);
      }
    }
  }
  assert.ok(checked.size >= studioRoutes.length, 'Only '+checked.size+' local entry destinations exercised');
  assert.ok(tabsChecked.size >= 6, 'Missing scene tabs');
  t.diagnostic('Navigation clicks verified: '+checked.size+' destinations, '+tabsChecked.size+' scene tabs');
});

test('directory feature switches, cancellation, shell search, theme, motion, about and mobile navigation', {
  skip: !enabled, timeout: 150000,
}, async t => {
  const {page,open,read,act} = await createStudioFixture(t);
  const first = page.locator('[data-switch-scene]').first();
  await open('home',first);
  const plugins = await page.locator('[data-switch-scene]').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>n.dataset.switchScene));
  assert.equal(plugins.length,5);
  for (const id of plugins) {
    const toggle = page.locator('[data-switch-scene="'+id+'"]:visible');
    const dialog = page.locator('dialog[open]');
    await toggle.click();
    await dialog.locator('button[value=cancel]').last().click();
    assert.equal(await toggle.getAttribute('aria-checked'),'true');
    const path = '/v1/merchant/features/'+id;
    await toggle.click();
    await act('确认停用首页插件 '+id,dialog.locator('button[value=confirm]'),{method:'PUT',path});
    await page.locator('[data-switch-scene="'+id+'"][aria-checked=false]:visible').waitFor();
    assert.equal((await read('/v1/merchant/features')).items.find(f=>f.id===id).enabled,false);
    await act('重新启用首页插件 '+id,toggle,{method:'PUT',path});
    await page.locator('[data-switch-scene="'+id+'"][aria-checked=true]:visible').waitFor();
    assert.equal((await read('/v1/merchant/features')).items.find(f=>f.id===id).enabled,true);
  }
  await page.locator('#workbenchSearch:visible').fill('zz-fixture-no-plugin');
  await page.getByText('没有匹配的插件或能力。').waitFor();
  await page.locator('#workbenchSearch:visible').fill('');
  await page.locator('[data-about]:visible').click();
  await page.locator('#studio-about[open] button').click();
  assert.equal(await page.locator('#studio-about').isVisible(),false);
  await page.locator('[data-find-navigation]:visible').first().click();
  const finder = page.locator('#navigationSearch[open]');
  await finder.locator('input').fill('素材库');
  await act('搜索并进入素材库',finder.locator('a[href="#assets"]'),{method:'GET',path:'/v1/assets'});
  await page.locator('[data-form=upload]').waitFor();
  const trigger = page.locator('.material-trigger');
  await trigger.click();
  const inspector = page.locator('#material-overlay:popover-open');
  await inspector.waitFor();
  await inspector.locator('#mat-blur').fill('15');
  assert.equal(await page.locator('html').evaluate(el=>el.style.getPropertyValue('--blur')),'15px');
  await inspector.locator('[data-native-reset]').click();
  assert.equal(await inspector.locator('#mat-blur').inputValue(),'24');
  const motion = await act('暂停或恢复动效',inspector.locator('[data-motion-toggle]'),{method:'PATCH',path:'/v1/settings'});
  assert.equal((await read('/v1/settings')).preferences.studioMotion,(await motion.json()).preferences.studioMotion);
  await inspector.locator('[data-more-appearance]').click();
  const settings = page.locator('#themeDialog[open]');
  const sound = settings.locator('.dm-sound-btn');
  const previousSound = await sound.innerText();
  await sound.click();
  assert.notEqual(await sound.innerText(),previousSound);
  await sound.click();
  const picker = settings.locator('[data-wallpaper-choose]');
  const [choose] = await Promise.all([page.waitForEvent('filechooser'),picker.click()]);
  await choose.setFiles({name:'synthetic-wallpaper.png',mimeType:'image/png',buffer:createCanvas(8,8).toBuffer('image/png')});
  await settings.getByText(/已保存到本机/).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-custom-wallpaper'),'');
  await settings.locator('[data-wallpaper-reset]').click();
  await settings.getByText('正在使用默认壁纸').waitFor();
  for (const mode of ['dark','system','light','dark']) {
    const radio = settings.locator('input[name=faiColorMode][value='+mode+']');
    if (await radio.isChecked()) continue;
    const changed = await act('切换显示模式 '+mode,settings.locator('label:has(input[name=faiColorMode][value='+mode+']) span'),{
      method:'PATCH',path:'/v1/settings'});
    assert.equal((await changed.json()).preferences.theme,mode);
  }
  await settings.locator('[data-reset-material]').click();
  await settings.getByRole('button',{name:'完成'}).click();
  assert.equal((await read('/v1/settings')).preferences.theme,'dark');
  await page.locator('#profile').click();
  await page.locator('[data-account-appearance]').click();
  await inspector.waitFor();
  await inspector.locator('[data-more-appearance]').click();
  await settings.locator('.themeClose').click();
  const track=page.locator('.head-themes .dm-track');
  const rect=await track.boundingBox();
  for(const [fraction,material] of [[0.17,'dark'],[0.5,'gray'],[0.83,'white']]){
    const [saved]=await Promise.all([page.waitForResponse(r=>r.request().method()==='PATCH' && r.url().endsWith('/v1/settings')),
      track.click({position:{x:Math.round(rect.width*fraction),y:Math.round(rect.height/2)}})]);
    assert.equal(saved.status(),200);
    assert.equal(await page.locator('html').getAttribute('data-material'),material);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#studioMenu').click();
  await page.locator('#appSidebar.mobile-open').waitFor();
  await page.locator('#sidebarBackdrop').click({position:{x:375,y:300}});
  assert.equal(await page.locator('#studioMenu').getAttribute('aria-expanded'),'false');
});
