import { field, form, input, textarea } from './live-ui.js';
import { customerScopeField, readCustomerScope } from './live-knowledge-tools.js';

export const createBaseForm = () => form('new-base', field('知识库名称', input('name', 'required maxlength="120"')), '创建知识库');

export function uploadDocumentForm(products) {
  return form('add-doc', field('名称', input('name', 'required maxlength="200"')) +
    field('分类', input('category', 'maxlength="100"')) + customerScopeField(products) +
    field('正文', textarea('content', 'maxlength="200000"')) +
    field('或读取 UTF-8 文本文件', input('file', 'type="file" accept=".txt,text/plain"')), '保存文档');
}

export async function saveKnowledgeDocument(ctx, endpoint, data) {
  const file = data.get('file');
  const content = file.size ? await file.text() : data.get('content');
  return ctx.api(endpoint, { method: 'POST', body: { name: data.get('name'), category: data.get('category') || undefined,
    content, customerScope: readCustomerScope(data.get('customerScope')) } });
}
