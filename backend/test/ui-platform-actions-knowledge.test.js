import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

const options = { skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 240000 };
const form = (page, name) => page.locator(`[data-form="${name}"]`);
const fields = (scope, name) => scope.locator(`[name="${name}"]`);
const submit = scope => scope.locator('button:not([type]), button[type=submit]').last();
const route = (method, path) => ({ method, path });

async function fill(scope, values) {
  for (const [name, value] of Object.entries(values)) await fields(scope, name).fill(value);
}

test('knowledge owners edit and grant libraries, manage memories and search through Chrome', options, async t => {
  const searches = [];
  const { page, app, api, read, open, act } = await createStudioFixture(t, {
    webSearch: async (query, limit) => {
      searches.push({ query, limit });
      return [{ title: '合成检索结果', url: 'https://example.test/reference', excerpt: '本机测试摘要' }];
    },
  });
  page.on('dialog', dialog => dialog.accept());
  const email = randomUUID() + '@example.test';
  const registration = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: {
    email, password: 'knowledge-member-fixture', displayName: '知识库验收成员', type: 'personal',
  } });
  assert.equal(registration.statusCode, 201, registration.body);
  const member = registration.json();
  const invite = await api('POST', '/v1/invitations', { email, role: 'member' });
  const accept = await app.inject({ method: 'POST', url: '/v1/invitations/accept',
    headers: { authorization: 'Bearer ' + member.token }, payload: { token: invite.token },
  });
  assert.equal(accept.statusCode, 200, accept.body);

  const basePath = '/v1/knowledge/bases';
  const baseForm = form(page, 'new-base');
  await open('resources', baseForm);
  await fill(baseForm, { name: '回归验收资料库' });
  const created = await act('创建知识库', submit(baseForm), route('POST', basePath));
  const base = await created.json();
  const endpoint = basePath + '/' + base.id;
  const rename = form(page, 'rename-base');
  await fill(rename, { name: '回归验收资料库改名' });
  await act('重命名知识库', submit(rename), route('PATCH', endpoint));
  await page.getByRole('heading', { name: '回归验收资料库改名' }).waitFor();

  const grant = form(page, 'grant');
  await fields(grant, 'memberId').selectOption(member.account.id);
  const grantPath = endpoint + '/grants/' + member.account.id;
  await act('授予知识库访问', submit(grant), route('PUT', grantPath));
  assert.ok((await read(endpoint + '/grants')).items.some(item => item.accountId === member.account.id));
  await act('撤销知识库访问', page.locator(`[data-remove-grant="${member.account.id}"]`), route('DELETE', grantPath));
  assert.equal((await read(endpoint + '/grants')).items.length, 0);

  await page.getByRole('link', { name: '文档分类' }).click();
  const categories = endpoint + '/categories';
  const newCategory = form(page, 'add-category');
  await fill(newCategory, { name: '验收资料分类' });
  await act('新增知识库分类', submit(newCategory), route('POST', categories));
  const category = (await read(categories)).items.find(item => item.name === '验收资料分类');
  const renameCategory = form(page, 'rename-category');
  await fields(renameCategory, 'id').selectOption(category.id);
  await fill(renameCategory, { name: '验收分类改名' });
  await act('重命名分类', submit(renameCategory), route('PATCH', categories + '/' + category.id));
  await act('打开分类资料', page.locator(`a[href="#resources/${base.id}/category/${category.id}"]`),
    route('GET', endpoint + '/documents'));
  await page.getByText('此分类暂无文档。', { exact: true }).waitFor();
  await page.getByRole('link', { name: '返回分类' }).click();
  await act('删除空知识库分类', page.locator(`[data-remove-category="${category.id}"]`),
    route('DELETE', categories + '/' + category.id));
  assert.equal((await read(categories)).items.length, 0);

  await page.getByRole('link', { name: '返回知识库', exact: true }).click();
  const documents = endpoint + '/documents';
  const addDocument = form(page, 'add-doc');
  await fill(addDocument, { name: '工作室测试手册', category: '内部文档' });
  await fields(addDocument, 'file').setInputFiles({ name: 'qa-manual.txt', mimeType: 'text/plain', buffer: Buffer.from('手册含有湖泊验收说明。') });
  await act('上传知识库文本文件', submit(addDocument), route('POST', documents));
  const document = (await read(documents)).items.find(item => item.name === '工作室测试手册');
  const documentPath = documents + '/' + document.id;
  await act('阅读已上传文档', page.getByRole('link', { name: '阅读', exact: true }), route('GET', documentPath));
  await page.getByText('手册含有湖泊验收说明。', { exact: true }).waitFor();
  await page.getByText('编辑文档', { exact: true }).click();
  const edit = form(page, 'edit-document');
  await fill(edit, { content: '训练文档含有北极星验收说明。' });
  await act('编辑文档并更新检索', submit(edit), route('PATCH', documentPath));
  await page.getByText('训练文档含有北极星验收说明。', { exact: true }).waitFor();
  const search = form(page, 'search');
  await open('resources', search);
  await fields(search, 'baseId').selectOption(base.id);
  await fill(search, { query: '北极星' });
  const hits = await act('检索已更新的文档', submit(search), route('POST', '/v1/knowledge/search'));
  assert.ok((await hits.json()).items.some(item => item.documentId === document.id));
  await page.locator('#search-results').getByRole('link', { name: '查看文档' }).waitFor();
  await open('resources/' + base.id, page.locator('[data-delete-document]'));
  await act('删除知识库文档', page.locator(`[data-delete-document="${document.id}"]`), route('DELETE', documentPath));
  assert.equal((await read(documents)).items.length, 0);
  await act('删除临时知识库', page.locator('[data-delete-base]'), route('DELETE', endpoint));
  assert.ok(!(await read(basePath)).items.some(item => item.id === base.id));

  for (const scope of ['personal', 'enterprise']) {
    const memory = form(page, 'memory');
    const content = `测试记忆 ${scope}`;
    await open('resources/memory/' + scope, memory);
    await fill(memory, { content });
    await act('保存' + scope + '记忆', submit(memory), route('POST', '/v1/memory'));
    const entry = (await read('/v1/memory?scope=' + scope)).items.find(item => item.content === content);
    await page.getByText(content, { exact: true }).waitFor();
    await act('删除' + scope + '记忆', page.locator(`[data-delete-memory="${entry.id}"]`), route('DELETE', '/v1/memory/' + entry.id));
    assert.ok(!(await read('/v1/memory?scope=' + scope)).items.some(item => item.id === entry.id));
  }

  const web = form(page, 'web-search');
  await open('resources/web', web);
  await fill(web, { query: '搜索夹具关键词' });
  await act('提交联网检索给本机夹具', submit(web), route('POST', '/v1/search/web'));
  assert.deepEqual(searches, [{ query: '搜索夹具关键词', limit: 8 }]);
  await page.locator('[data-web-results]').getByText('合成检索结果', { exact: true }).waitFor();
});
