import { downloadFile } from './live-files.js';
import { action, date, field, form, h, heading, input, item, link, list, panel, path, textarea, uid } from './live-ui.js';

const endpoint = '/v1/copywriting/drafts';
const route = 'copy-drafts';

export async function copyDrafts(ctx) {
  const [id, sourceTaskId] = ctx.args;
  if (!id) {
    const drafts = await ctx.all(endpoint);
    ctx.html(heading('电商文案草稿') + '<div class="live-row">' + link('新建文案', route + '/new') +
      link('返回文案校验', 'copy-review') + '</div>' +
      panel('已保存的文案', list(drafts, draft => item(draft.title, date(draft.updatedAt),
        link('打开文案', route + '/' + path(draft.id))))));
    return;
  }
  const fresh = id === 'new';
  const source = fresh && sourceTaskId ? await ctx.api('/v1/tasks/' + path(sourceTaskId)) : null;
  if (source && (source.pluginId !== 'copywriting' || source.state !== 'succeeded' || typeof source.result?.text !== 'string')) {
    throw new Error('请选择已完成的文案任务。');
  }
  const key = fresh ? uid() : id;
  const url = endpoint + '/' + path(key);
  const draft = fresh ? { revision: 0, title: '', content: source?.result.text ?? '', sourceTaskId: source?.id } : await ctx.api(url);
  ctx.html(heading(fresh ? '新建文案草稿' : draft.title) +
    '<div class="live-row">' + link('返回文案草稿', route) +
    (draft.sourceTaskId ? link('查看原任务', 'tasks/' + path(draft.sourceTaskId)) : '') +
    (fresh ? '' : action('导出已保存版本', 'copy-draft-download')) + '</div>' +
    panel('编辑内容', form('copy-draft-edit', field('文案标题', input('title',
      'required maxlength="300" value="' + h(draft.title) + '"')) +
      field('文案正文', textarea('content', 'required maxlength="100000" rows="12"', draft.content)), '保存文案')));
  ctx.submit('copy-draft-edit', async data => {
    const saved = await ctx.api(url, { method: 'PUT', body: { revision: draft.revision,
      title: data.get('title').trim(), content: data.get('content'), ...(source ? { sourceTaskId: source.id } : {}) } });
    ctx.go(route + '/' + path(saved.id));
  });
  ctx.click('copy-draft-download', () => downloadFile(ctx, url + '/export?revision=' + draft.revision, '文案-r' + draft.revision + '.txt'));
}
