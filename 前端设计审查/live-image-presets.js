import { action, field, form, input, item, list, panel, path, retryKey, select } from './live-ui.js';
import { assetField, editRows, numeric, rowControls } from './live-media-controls.js';

const platformEndpoint = '/v1/media/images/platform-templates';
const seriesEndpoint = '/v1/media/images/series-presets';
const platforms = [['taobao', '淘宝'], ['pinduoduo', '拼多多'], ['douyin', '抖音']];
const fits = [['contain', '保留完整图片'], ['cover', '裁切填满']];
const formats = [['png', 'PNG'], ['jpeg', 'JPG']];
const fonts = [['sans', '无衬线'], ['chinese', '中文字体']];
const platformLabel = id => platforms.find(([platform]) => platform === id)?.[1] ?? id;

export async function loadImagePresets(ctx) {
  const [{ items }, series] = await Promise.all([ctx.api(platformEndpoint), ctx.all(seriesEndpoint)]);
  return { templates: items.map(template => ({ ...template, label: platformLabel(template.platform) })), series };
}

function templatePanel(templates, manager) {
  const controls = manager ? form('image-template-save',
    field('平台', select('platform', platforms, platforms[0][0])) +
    numeric('宽度', 'width', 800, 32, 1920) + numeric('高度', 'height', 800, 32, 6144) +
    field('适配方式', select('fit', fits, 'contain')) + field('格式', select('format', formats, 'png')),
    '发布导出规范') : '';
  return '<details class="live-fold"><summary>平台导出规范</summary>' +
    list(templates, template => item(template.label, template.width + ' × ' + template.height +
      ' · ' + template.format.toUpperCase() + ' · 版本 ' + template.revision), '工作区尚未发布平台导出规范。') + controls + '</details>';
}

function seriesEditor(files) {
  const consented = files.filter(asset => asset.consentReference && Date.parse(asset.consentExpiresAt) > Date.now());
  const fields = field('预设名称', input('name', 'required maxlength="100"')) +
    assetField('商品图', 'productAssetId', files, '', true, '选择商品图') +
    assetField('模特图（需有效授权）', 'modelAssetId', consented) +
    field('背景色', input('background', 'type="color" value="#ffffff"')) +
    field('字幕字体', select('font', fonts, 'chinese')) +
    numeric('字幕字号（画布短边百分比）', 'fontSizePercent', 7, 2, 20) +
    field('字幕颜色', input('textColor', 'type="color" value="#000000"')) +
    '<fieldset><legend>主体位置和大小（百分比）</legend>' +
    numeric('左边距', 'x', 10, 0, 99) + numeric('上边距', 'y', 10, 0, 99) +
    numeric('宽度', 'width', 80, 1, 100) + numeric('高度', 'height', 70, 1, 100) + '</fieldset>';
  return '<details class="live-fold"><summary>新建或编辑系列预设</summary>' +
    '<p data-series-edit-title>新建预设</p>' + form('image-series-save', fields, '保存预设') +
    action('新建预设', 'image-series-reset') + '</details>';
}

function seriesRow(templates) {
  const specs = [['square', '800 × 800 方形'], ['portrait', '900 × 1200 竖图'], ['detail', '800 × 4800 详情长图'],
    ...templates.map(template => [template.platform, template.label + ' · ' + template.width + ' × ' + template.height])];
  return '<fieldset data-edit-row><legend>系列图片</legend>' +
    field('处理名称', input('key', 'required maxlength="100"')) + field('画布尺寸', select('size', specs, 'square')) +
    field('画面字幕（选填）', input('caption', 'maxlength="140"')) + rowControls('移除系列图片') + '</fieldset>';
}

export function imagePresetPanels(ctx, { templates, series }, files) {
  const seriesForm = series.length ? form('image-series-render',
    field('系列预设', select('presetId', series.map(preset => [preset.id, preset.name + ' · 版本 ' + preset.revision]), series[0].id)) +
    '<div data-edit-rows>' + seriesRow(templates) + '</div>' +
    '<button type="button" class="plain" data-row-command="add">添加系列图片</button>', '按预设处理图片') : '';
  return panel('导出规范与系列预设', templatePanel(templates, ctx.manager) + seriesForm +
    (files.length ? list(series, preset => item(preset.name, '版本 ' + preset.revision,
      action('编辑预设', 'image-series-edit', preset.id)), '还没有保存的系列预设。') + seriesEditor(files) : ''));
}

export function bindImagePresets(ctx, { templates, series }, batchEndpoint) {
  const templateForm = document.querySelector('[data-form=image-template-save]');
  const getTemplate = id => templates.find(template => template.platform === id);
  if (templateForm) {
    const sync = () => {
      const options = getTemplate(templateForm.elements.platform.value) ?? { width: 800, height: 800, fit: 'contain', format: 'png' };
      for (const key of ['width', 'height', 'fit', 'format']) templateForm.elements[key].value = options[key];
    };
    templateForm.elements.platform.addEventListener('change', sync);
    sync();
    ctx.submit('image-template-save', async data => {
      const platform = data.get('platform');
      await ctx.api(platformEndpoint + '/' + path(platform), { method: 'PUT', body: {
        revision: getTemplate(platform)?.revision ?? 0, width: Number(data.get('width')), height: Number(data.get('height')),
        format: data.get('format'), fit: data.get('fit'),
      } });
      ctx.reload();
    });
  }

  const editor = document.querySelector('[data-form=image-series-save]');
  let editing;
  if (editor) {
    const title = document.querySelector('[data-series-edit-title]');
    ctx.click('image-series-edit', id => {
      editing = series.find(preset => preset.id === id);
      title.textContent = '编辑 ' + editing.name;
      editor.closest('details').open = true;
      const { subjectBox, ...values } = editing.configuration;
      for (const [key, value] of Object.entries({ name: editing.name, ...values, ...subjectBox })) editor.elements[key].value = value ?? '';
      editor.elements.name.focus();
    });
    ctx.click('image-series-reset', () => {
      editing = undefined;
      editor.reset();
      title.textContent = '新建预设';
      editor.elements.name.focus();
    });
    const key = retryKey();
    ctx.submit('image-series-save', async data => {
      const subjectBox = Object.fromEntries(['x', 'y', 'width', 'height'].map(name => [name, Number(data.get(name))]));
      const configuration = { subjectBox, productAssetId: data.get('productAssetId'), modelAssetId: data.get('modelAssetId') || null,
        background: data.get('background'), font: data.get('font'), fontSizePercent: Number(data.get('fontSizePercent')), textColor: data.get('textColor') };
      const body = { name: data.get('name').trim(), revision: editing?.revision ?? 0, configuration };
      await ctx.api(seriesEndpoint + '/' + path(editing?.id ?? key(body)), { method: 'PUT', body });
      ctx.reload();
    });
  }

  const renderer = document.querySelector('[data-form=image-series-render]');
  if (!renderer) return;
  editRows(renderer, () => seriesRow(templates), 8);
  const key = retryKey();
  ctx.submit('image-series-render', async (data, node) => {
    const { id, revision } = series.find(preset => preset.id === data.get('presetId'));
    const items = [...node.querySelectorAll('[data-edit-row]')].map(row => {
      const { key, size, caption } = row.elements;
      const template = getTemplate(size.value);
      return { key: key.value.trim(), ...(caption.value.trim() ? { caption: caption.value.trim() } : {}),
        ...(template ? { platformTemplate: { platform: template.platform, revision: template.revision } } : { profile: size.value }) };
    });
    const payload = { seriesPreset: { id, revision }, items };
    const saved = await ctx.api(batchEndpoint, { method: 'POST', body: { id: key(payload), ...payload } });
    ctx.go('media/images/' + path(saved.id));
  });
}
