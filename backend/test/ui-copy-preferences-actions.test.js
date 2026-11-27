import { registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('catalog favorites cover each capability; personal workspace plugin switches and a failed detail can recover', {
  skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 340000,
},async t=>{
  const {page,app,origin,open,act,api,read}=await createStudioFixture(t);
  await open('library','[data-live-favorites]');
  const sections=page.locator('#main details').filter({has:page.locator('[data-favorite]')});
  let count=0;
  for(const section of await sections.all()){
    await section.locator('summary').click();
    for(const favorite of await section.locator('[data-favorite]').all()){
      const id=await favorite.getAttribute('data-favorite');
      const add=await act('收藏 '+id,favorite,{method:'PATCH',path:'/v1/settings'});
      assert.ok((await add.json()).preferences.favoriteCapabilities.includes(id));
      await page.waitForFunction(id=>document.querySelector('[data-favorite="'+id+'"]').textContent==='取消收藏',id);
      const remove=await act('取消收藏 '+id,favorite,{method:'PATCH',path:'/v1/settings'});
      assert.ok(!(await remove.json()).preferences.favoriteCapabilities.includes(id));
      count++;
    }
  }
  const catalog=await read('/v1/plugins');
  assert.equal(count,[...catalog.items,catalog.models].reduce((total,plugin)=>total+plugin.capabilities.length,0));
  assert.deepEqual((await read('/v1/settings')).preferences.favoriteCapabilities,[]);

  const id=randomUUID(), url='/v1/copywriting/drafts/'+id;
  await open('copy-drafts/'+id,'[data-retry]');
  await api('PUT',url,{revision:0,title:'恢复后的合成草稿',content:'测试内容'});
  await act('重新读取先前缺失的草稿',page.locator('[data-retry]'),{method:'GET',path:url});
  await page.getByRole('heading',{name:'恢复后的合成草稿'}).waitFor();

  const member=await app.inject({method:'POST',url:'/v1/auth/register',payload:await registrationPayload(app, {
    email:randomUUID()+'@example.test',password:'catalog-personal-fixture',displayName:'个人目录验收',type:'personal',
  })});
  assert.equal(member.statusCode,201,member.body);
  const {token,workspaces}=member.json();
  await page.evaluate(({token,workspace})=>{
    sessionStorage.setItem('fai.live.session',token);
    sessionStorage.setItem('fai.live.workspace',workspace);
  },{token,workspace:workspaces[0].id});
  await page.goto('about:blank');
  await open('manager',page.locator('[data-plugin-state]').first());
  for(const plugin of [...catalog.items,catalog.models]){
    const toggle=page.locator('[data-plugin-state="'+plugin.id+'"]');
    for(const enabled of [false,true]){
      const target='/v1/plugins/'+plugin.id+'/state';
      await act('个人工作区插件 '+plugin.id+' '+enabled,toggle,{method:'PUT',path:target});
      const actual=await page.request.get(origin+'/v1/plugins',{headers:{authorization:'Bearer '+token,'x-workspace-id':workspaces[0].id}});
      assert.equal(actual.status(),200);
      const directory=await actual.json();
      assert.equal([...directory.items,directory.models].find(p=>p.id===plugin.id).enabled,enabled);
      await toggle.filter({hasText:enabled?'停用':'启用'}).waitFor();
    }
  }
});
