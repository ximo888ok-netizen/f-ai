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
  const { page, open, act, read } = await createStudioFixture(t);
  page.on('dialog', dialog => dialog.accept());
  await open('skills', page.getByRole('link', { name: '新增技能' }));
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

  await open('library/experts', page.getByRole('link', { name: '新建专家' }));
  await act('进入新建专家', page.getByRole('link', { name: '新建专家' }), route('GET', library));
  const editor = form(page, 'expert-edit');
  await write(editor, { name: '自动验收专家', description: '审核测试流程', instructions: '用中文核对验收条件' });
  await field(editor, 'relatedIds').selectOption(skill.id);
  const expertCreated = await act('新建专家并挂载技能', submit(editor), route('POST', library));
  const expert = await expertCreated.json();
  const expertPath = library + '/' + expert.id;
  assert.deepEqual(expert.relatedIds, [skill.id]);
  await page.getByRole('heading', { name: '自动验收专家', exact: true }).waitFor();
  const search = form(page, 'expert-search');
  await act('返回专家清单', page.getByRole('link', { name: '返回专家库' }), route('GET', library));
  await write(search, { q: '自动验收专家' });
  await act('查找专家', submit(search), route('GET', library));
  await page.getByText('自动验收专家', { exact: true }).waitFor();
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
