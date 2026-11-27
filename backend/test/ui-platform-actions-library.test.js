import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const form = (page, id) => page.locator(`[data-form="${id}"]`);
const field = (scope, name) => scope.locator(`[name="${name}"]`);
const submit = scope => scope.locator('button:not([type]),button[type=submit]').last();
const route = (method, path) => ({ method, path });
const library = '/v1/library';

async function write(scope, values) {
  for (const [key, value] of Object.entries(values)) await field(scope, key).fill(value);
}

test('custom skills, experts and teams can be edited and applied in Chrome', options, async t => {
  const { page, open, act, read } = await createStudioFixture(t, { configureProviders(providers) {
    providers.set('model:library-qa-model', {
      info: { id: 'library-qa-model', model: 'Library QA text model', protocol: 'chat-completions', kind: 'text',
        capabilities: ['model.chat'], streamText: false },
      supports: entry => entry.id === 'model.chat',
      run: async (_task, payload) => {
        assert.equal(payload.parameters.messages.at(-1).content, '执行合成模型技能');
        return { type: 'text', text: '自定义模型技能执行成功。' };
      },
    });
  } });
  page.on('dialog', dialog => dialog.accept());
  await open('skills', page.getByRole('button', {name:'管理技能'}));
  await page.getByRole('button', {name:'管理技能'}).click();
  await act('打开自定义技能编辑器', page.getByRole('link', { name: '新增技能' }));
  const create = form(page, 'skill-create');
  await write(create, { name: '自动验收措辞技能', description: '本地验收技能', instructions: '查找需要人工复核的词语' });
  await field(create, 'skillAction').selectOption('copy-review');
  const created = await act('创建自定义技能', submit(create), route('POST', library));
  const skill = await created.json();
  const skillPath = library + '/' + skill.id;
  const update = form(page, 'skill-update');
  await write(update, { name: '自动验收措辞技能已更新' });
  await act('更新技能定义', submit(update), route('PUT', skillPath));
  await page.getByRole('heading', { name: '自动验收措辞技能已更新' }).waitFor();
  const run = form(page, 'skill-run');
  await write(run, { content: '待复核的合成文案' });
  const outcome = await act('运行本地措辞技能', submit(run), route('POST', skillPath + '/runs'));
  assert.equal((await outcome.json()).action, 'copy-review');
  await page.locator('[data-skill-result]').getByRole('heading', { name: '建议稿' }).waitFor();
  for (const [label, enabled] of [['停用技能', false], ['启用技能', true]]) {
    await act(label, page.getByRole('button', { name: label, exact: true }), route('PUT', skillPath + '/state'));
    assert.equal((await read(skillPath)).enabled, enabled);
  }
  await field(update, 'skillAction').selectOption('model-chat');
  await act('把技能切换为模型执行', submit(update), route('PUT', skillPath));
  await field(run, 'modelId').selectOption('library-qa-model');
  await write(run, { content: '执行合成模型技能' });
  const modelRun = await act('提交并运行自定义模型技能', submit(run), route('POST', skillPath + '/runs'));
  const { task } = await modelRun.json();
  await page.locator('pre.live-result').filter({ hasText: '自定义模型技能执行成功。' }).waitFor({ timeout: 20000 });
  assert.equal((await read('/v1/tasks/' + task.id)).state, 'succeeded');

  await open('library/experts', page.getByRole('button', {name:'管理专家'}));
  await page.getByRole('button', {name:'管理专家'}).click();
  await act('进入新建专家', page.getByRole('link', { name: '新建专家' }), route('GET', library));
  const editor = form(page, 'expert-edit');
  await write(editor, { name: '自动验收专家', description: '审核测试流程', instructions: '用中文核对验收条件' });
  await field(editor, 'relatedIds').selectOption(skill.id);
  const expertCreated = await act('新建专家并挂载技能', submit(editor), route('POST', library));
  const expert = await expertCreated.json();
  const expertPath = library + '/' + expert.id;
  assert.deepEqual(expert.relatedIds, [skill.id]);
  await page.getByRole('heading', { name: '自动验收专家', exact: true }).waitFor();
  await act('返回专家清单', page.getByRole('link', { name: '返回专家库' }), route('GET', library));
  await page.getByRole('searchbox', {name:'搜索专家'}).fill('自动验收专家');
  await page.locator('.lib-records').getByRole('heading', {name:'自动验收专家',exact:true}).waitFor();
  assert.equal(await page.locator('.lib-record').count(), 1);
  await page.getByRole('button', {name:'管理专家'}).click();
  await act('打开组建专家团编辑器', page.getByRole('link', { name: '组建专家团' }), route('GET', library));
  await write(editor, { name: '自动验收专家团', description: '本机测试', instructions: '汇总验收意见' });
  await field(editor, 'relatedIds').selectOption(expert.id);
  const teamCreated = await act('组建专家团', submit(editor), route('POST', library));
  const team = await teamCreated.json();
  const teamPath = library + '/' + team.id;
  assert.deepEqual(team.relatedIds, [expert.id]);
  await page.getByRole('heading', { name: '自动验收专家团', exact: true }).waitFor();
  await write(editor, { instructions: '汇总现有成员的验收意见' });
  await act('更新专家团要求', submit(editor), route('PUT', teamPath));
  assert.equal((await read(teamPath)).instructions, '汇总现有成员的验收意见');
  for (const [label, enabled] of [['停用', false], ['启用', true]]) {
    await act('专家团' + label, page.getByRole('button', { name: label, exact: true }), route('PUT', teamPath + '/state'));
    assert.equal((await read(teamPath)).enabled, enabled);
  }
  await act('将专家团带入模型对话', page.getByRole('link', { name: '带入模型对话' }), route('GET', '/v1/plugins'));
  await page.waitForURL('**/#models/expert/' + team.id);
  await open('library/experts/' + team.id, '[data-expert-delete]');
  await act('删除专家团', page.locator('[data-expert-delete]'), route('DELETE', teamPath));
  await open('library/experts/' + expert.id, '[data-expert-delete]');
  await act('删除自定义专家', page.locator('[data-expert-delete]'), route('DELETE', expertPath));
  await open('skills/' + skill.id, '[data-skill-delete]');
  await act('删除自定义技能', page.locator('[data-skill-delete]'), route('DELETE', skillPath));
  const remaining = (await read(library)).items;
  assert.ok(!remaining.some(item => [skill.id, expert.id, team.id].includes(item.id)));
});

test('directory tabs, catalog filters, sorting and detail return work across themes and screen sizes', options, async t => {
  const { page, open, api, read } = await createStudioFixture(t);
  const entries = (await read(library)).items;
  const expert = entries.find(item => item.name === '电商文案专家');
  const skill = entries.find(item => item.skillAction === 'copy-review');
  const team = entries.find(item => item.kind === 'team');
  const root = page.locator('.lib-directory');
  const grid = root.locator('.lib-records');
  const snap = async name => {
    if (process.env.FAI_LIBRARY_SCREENSHOTS) await page.screenshot({
      path: process.env.FAI_LIBRARY_SCREENSHOTS + '/' + name + '.png', animations:'disabled', timeout:60000,
    });
  };
  await open('capabilities',root.locator('.lib-record').first());
  assert.equal(await root.locator('.lib-banner').count(), 4);
  assert.equal(await grid.getByRole('link').count(), entries.filter(item=>item.kind==='expert').length);
  const asset = await page.request.get(new URL('/studio/assets/library-scenes.webp',page.url()).href);
  assert.ok(asset.ok());
  assert.match(asset.headers()['content-type'], /image\/webp/);
  await snap('experts-desktop');
  await root.getByRole('button',{name:'浏览内容创作'}).click();
  assert.equal(await grid.getByRole('link').count(),1);
  await grid.getByRole('link',{name:/电商文案专家/}).click();
  await page.getByRole('heading',{name:expert.name,exact:true}).waitFor();
  await page.goBack();
  await root.getByRole('button',{name:'内容创作',exact:true}).waitFor();
  assert.equal(await root.getByRole('button',{name:'内容创作',exact:true}).getAttribute('aria-pressed'),'true');
  await root.getByRole('button',{name:'专家团',exact:true}).click();
  await grid.getByRole('heading',{name:team.name,exact:true}).waitFor();
  await root.getByRole('searchbox').fill('没有这个专家团');
  await root.getByText('没有符合条件的条目。').waitFor();
  await root.getByRole('button',{name:'重置筛选'}).click();
  assert.equal(await grid.getByRole('link').count(),entries.filter(item=>item.kind==='expert').length);

  await root.locator('.lib-tabs').getByRole('link',{name:'技能',exact:true}).click();
  await grid.getByRole('heading',{name:skill.name,exact:true}).waitFor();
  await snap('skills-desktop');
  const custom = await api('POST',library,{kind:'skill',name:'详情页术语审核',description:'核对商品文案术语',
    instructions:'核对用户提交的内容',skillAction:'copy-review',relatedIds:[]});
  await page.reload();
  await root.getByRole('button',{name:'自建技能',exact:true}).click();
  assert.equal(await grid.getByRole('link').count(),1);
  await grid.getByRole('heading',{name:custom.name,exact:true}).waitFor();
  await root.getByRole('button',{name:'技能',exact:true}).click();
  await root.getByRole('button',{name:'最新',exact:true}).click();
  assert.equal(await grid.getByRole('heading').first().textContent(),custom.name);
  await root.getByRole('button',{name:'最多关联',exact:true}).click();
  assert.notEqual(await grid.getByRole('heading').first().textContent(),custom.name);
  await root.getByRole('searchbox').fill('详情页术语');
  assert.equal(await grid.getByRole('link').count(),1);
  await root.getByRole('searchbox').fill('');
  await root.locator('.lib-tabs').getByRole('link',{name:'连接器',exact:true}).click();
  await root.getByRole('heading',{name:'WebDAV 网盘'}).waitFor();

  await root.locator('.lib-tabs').getByRole('link',{name:'专家',exact:true}).click();
  await grid.getByRole('heading',{name:expert.name,exact:true}).waitFor();
  for(const width of [320,390,768,1024,1440]) {
    await page.setViewportSize({width,height:width<768?844:960});
    assert.ok(await root.evaluate(el=>el.getBoundingClientRect().right <= innerWidth + 1),'overflow at '+width);
    const controls=await root.locator('.lib-tools').boundingBox();
    assert.ok(controls.x + controls.width <= width+1,'toolbar overflow at '+width);
    if(width===390) await snap('experts-mobile');
  }
  const theme=page.locator('.head-themes .dm-track'), bounds=await theme.boundingBox();
  for(const [fraction,material] of [[0.17,'dark'],[0.5,'gray'],[0.83,'white']]) {
    await Promise.all([page.waitForResponse(r=>r.request().method()==='PATCH' && r.url().endsWith('/v1/settings')),
      theme.click({position:{x:Math.round(bounds.width*fraction), y:Math.round(bounds.height/2)}})]);
    assert.equal(await page.locator('html').getAttribute('data-material'), material);
    if(material==='dark') await snap('experts-dark');
  }
});
