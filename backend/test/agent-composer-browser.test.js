import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('composer attaches workspace records to the chosen model and keeps prompt enhancement editable',
  {skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 120000}, async t => {
    const calls = [];
    let answer = '请按工作区资料撰写春季推广方案。';
    const { page, origin, api } = await createStudioFixture(t, { configureProviders(providers) {
      for (const id of ['writer-a', 'writer-b']) providers.set('model:' + id, {
        info: { id, model:'text-model-' + id, protocol:'chat-completions', kind:'text', capabilities:['model.chat'], streamText:false },
        signature:id, supports: capability => capability.id === 'model.chat',
        async run(task, payload) { calls.push({id, messages:payload.parameters.messages}); return {type:'text', text:answer}; },
      });
    } });
    const base = await api('POST','/v1/knowledge/bases',{name:'春季资料'});
    const doc = await api('POST','/v1/knowledge/bases/'+base.id+'/documents',{name:'上新简报',content:'本季主打亚麻和苔绿色。'});
    const project = await api('POST','/v1/projects',{name:'春季推广'});
    const {items:skills} = await api('GET','/v1/library?kind=skill&enabled=true');
    await page.goto(origin + '/#chat/new', {waitUntil:'domcontentloaded',timeout:60000});
    await page.locator('.composer-add').waitFor({timeout:30000});
    const input = page.locator('.agent-home textarea');
    const panel = page.locator('#composer-context');
    const openCategory = async name => {
      await page.locator('.composer-add').click();
      await panel.getByRole('button',{name,exact:true}).click();
    };
    assert.equal(await page.getByRole('button',{name:'访问范围'}).count(), 0);
    await openCategory('@引用文件');
    await panel.getByRole('button',{name:base.name,exact:true}).click();
    await panel.getByRole('button',{name:doc.name,exact:true}).click();
    await openCategory('技能');
    await panel.getByRole('button',{name:skills[0].name,exact:true}).click();
    await openCategory('上下文');
    await panel.getByRole('button',{name:project.name,exact:true}).click();
    await openCategory('连接器');
    await panel.getByText('暂无已接入的连接器。').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.composer-model').click();
    await page.locator('[data-model-id=writer-b]').click();
    assert.equal(await page.locator('.composer-model').innerText(),'text-model-writer-b');
    await input.fill('做个推广方案');
    const enhance = page.getByRole('button',{name:'强化提示词',exact:true});
    const [request] = await Promise.all([page.waitForRequest(r => r.method()==='POST' && r.url().endsWith('/v1/tasks')),enhance.click()]);
    const task = request.postDataJSON();
    assert.deepEqual(task.parameters.guidanceIds,[skills[0].id]);
    assert.equal(task.projectId,project.id);
    assert.equal(task.modelId,'writer-b');
    await page.waitForFunction(value=>document.querySelector('.agent-home textarea').value===value,answer);
    assert.match(JSON.stringify(calls.at(-1).messages),/本季主打亚麻和苔绿色/);
    assert.equal(calls.at(-1).id,'writer-b');
    assert.equal(await page.locator('.agent-log article').count(),0);
    await api('DELETE','/v1/knowledge/bases/'+base.id+'/documents/'+doc.id);
    await enhance.click();
    await page.locator('.agent-status').getByText(/强化未完成/).waitFor();
    assert.equal(await input.inputValue(),answer);
    assert.equal(calls.length,1);
    await page.getByRole('button',{name:'移除引用 '+doc.name,exact:true}).click();
    answer = '建议本周先发布上新短文。';
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.locator('.agent-log').getByText(answer,{exact:true}).waitFor();
    assert.equal(calls.length,2);
    assert.equal(calls[1].id,'writer-b');
  });

test('a gateway-only workspace can enhance a draft with the server-selected chat provider',
  {skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout:120000}, async t => {
    const {page,open} = await createStudioFixture(t, {configureProviders(providers) {
      providers.set('gateway',{supports: c => c.id === 'model.chat', run:async () => ({type:'text',text:'网关返回的强化稿'})});
    }});
    await open('chat/new','.composer-add');
    await page.getByRole('button',{name:'工作区网关',exact:true}).waitFor();
    await page.locator('.agent-home textarea').fill('草稿');
    const [request] = await Promise.all([page.waitForRequest(r => r.method()==='POST' && r.url().endsWith('/v1/tasks')),
      page.getByRole('button',{name:'强化提示词'}).click()]);
    assert.equal(Object.hasOwn(request.postDataJSON(),'modelId'),false);
    await page.waitForFunction(()=>document.querySelector('.agent-home textarea').value==='网关返回的强化稿');
  });
