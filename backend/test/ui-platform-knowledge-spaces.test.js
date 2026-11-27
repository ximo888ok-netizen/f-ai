import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('knowledge navigation switches authorized spaces, presents documents and attaches the selected library to a new task', {
  skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000,
}, async t => {
  const { page, app, open } = await createStudioFixture(t);
  async function call(method, url, expected, payload, session, workspace = session?.workspaces[0].id) {
    const headers = session ? { authorization: 'Bearer '+session.token, 'x-workspace-id': workspace } : {};
    const res = await app.inject({method,url,headers,payload});
    assert.equal(res.statusCode,expected,res.body);
    return res.body ? res.json() : null;
  }
  const sign = (type,email, displayName,workspaceName) => call('POST','/v1/auth/register',201,{
    type,email,displayName,password:'local-knowledge-fixture',...(workspaceName ? {workspaceName} : {}),
  });
  const owner = await sign('enterprise','team-knowledge@example.test','运营管理员','电商运营中心');
  const personal = await sign('personal','personal-knowledge@example.test','林知');
  const invite = await call('POST','/v1/invitations',201,{email:personal.account.email,role:'member'},owner);
  await call('POST','/v1/invitations/accept',200,{token:invite.token},personal);
  const root='/v1/knowledge/bases';
  const own=await call('POST',root,201,{name:'个人知识库'},personal);
  const shared=await call('POST',root,201,{name:'商品与售后手册'},owner);
  const restricted=await call('POST',root,201,{name:'财务资料'},owner);
  await call('PUT',root+'/'+shared.id+'/grants/'+personal.account.id,204,undefined,owner);
  for(const [base,title,category,content] of [
    [shared,'商品参数与规格','商品资料','陶瓷杯型号为 A17。'],[shared,'退换货处理细则','售后服务','申请售后须提供订单号。'],
    [restricted,'内部核算','财务','型号 A17 核算。'],
  ]) await call('POST',root+'/'+base.id+'/documents',201,{name:title,category,content},owner);

  await open('resources', '.kb-center');
  await page.evaluate(({token,workspace})=>{
    sessionStorage.setItem('fai.live.session',token);
    sessionStorage.setItem('fai.live.workspace',workspace);
  },{token:personal.token,workspace:personal.workspaces[0].id});
  await page.reload();
  await page.getByRole('heading',{name:own.name,exact:true}).waitFor();
  const center=page.locator('.kb-center');
  const widthOK=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  const snap=async name=>{
    if (process.env.FAI_KB_SCREENSHOTS) await page.screenshot({path:join(process.env.FAI_KB_SCREENSHOTS,name+'.png'),animations:'disabled',timeout:60000});
  };
  await center.getByText('暂无内容',{exact:true}).waitFor();
  await snap('personal-desktop');
  await center.getByRole('link',{name:'电商运营中心'}).click();
  await center.getByRole('heading',{name:shared.name,exact:true}).waitFor();
  assert.equal(await center.getByRole('button',{name:'添加文档'}).count(),0);
  assert.equal(await center.getByText('财务资料',{exact:true}).count(),0);
  await center.getByRole('link',{name:/商品参数与规格/}).waitFor();
  await snap('enterprise-desktop');
  await center.getByRole('button',{name:'网格视图'}).click();
  assert.equal(await center.locator('[data-kb-docs]').getAttribute('data-view'),'grid');
  await center.getByRole('button',{name:'列表视图'}).click();
  for(const width of [320,390,768,1024,1440]) {
    await page.setViewportSize({width,height:width<768?844:960});
    await widthOK();
    const actions = await center.locator('.kb-actions').boundingBox();
    const collection = await center.locator('.kb-collection').boundingBox();
    assert.ok(actions.y + actions.height <= collection.y + 1, 'Library controls overlap the document toolbar at ' + width);
    if(width===390) await snap('enterprise-mobile');
  }
  const theme = page.locator('.head-themes .dm-track');
  const bounds = await theme.boundingBox();
  for (const [fraction,material] of [[0.17,'dark'],[0.5,'gray'],[0.83,'white']]) {
    await Promise.all([page.waitForResponse(r=>r.request().method()==='PATCH' && r.url().endsWith('/v1/settings')),
      theme.click({position:{x:Math.round(bounds.width*fraction),y:Math.round(bounds.height/2)}})]);
    assert.equal(await page.locator('html').getAttribute('data-material'),material);
    assert.equal(await center.locator('.kb-summary').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
    if (material === 'dark') await snap('enterprise-dark');
  }
  await center.getByRole('link',{name:'添加到任务'}).click();
  const composer=page.locator('.agent-home form textarea').first();
  await composer.waitFor();
  assert.equal(await composer.inputValue(),'查知识库 ');
  const request=page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname==='/v1/knowledge/search');
  await composer.fill('查知识库 A17');
  await composer.press('Enter');
  assert.deepEqual((await request).postDataJSON(),{query:'A17',baseIds:[shared.id]});
  await page.locator('.agent-log').getByRole('link',{name:/商品参数与规格/}).waitFor();
  await open('resources',center);
  await center.getByRole('link',{name:'我的个人知识库'}).click();
  await center.getByRole('heading',{name:own.name,exact:true}).waitFor();
  assert.equal(await center.getByText('退换货处理细则').count(),0);
});
