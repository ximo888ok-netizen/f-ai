import { h } from '../live-ui.js';

export const mainImageCapabilityId = 'image.main-image';
export const regions = ['中国', '美国', '英国', '德国', '日本', '加拿大', '澳大利亚', '其他'];
export const languages = ['简体中文', '繁体中文', '英语', '日语', '韩语', '德语', '法语', '西班牙语'];
export const platforms = ['淘宝/天猫', '拼多多', '京东', '抖音电商', '小红书', '亚马逊', '速卖通', '通用/其他'];
export const sizePresets = [['1024x1024', '1:1 · 1024×1024'], ['1024x1536', '2:3 · 1024×1536'],
  ['900x1200', '3:4 · 900×1200'], ['1536x1024', '3:2 · 1536×1024'], ['custom', '自定义']];
export const imageTypes = ['营销图', '白底图', '场景图', '细节图', '买家秀'];
export const imageStyles = ['智能风格', '简约白底', '轻奢暖调', '科技深色', '清新自然', '现代商务',
  '复古质感', '潮流撞色', '国风雅韵', '自定义'];
const ratioCandidates = ['1:1', '3:4', '4:3', '9:16', '16:9'];
const nativeQualities = ['low', 'medium', 'high'];
const qualityNotes = ['自然用光、主体清晰、画面干净', '保留材质和商品细节，均衡画面层次与光影',
  '精细处理材质、边缘、光影和构图，保留商品细小纹理'];
const typeNotes = [
  '突出商品卖点与活动氛围，为简短标题留出合适空间。',
  '使用纯白、干净的背景，画面只呈现商品及其自然阴影。',
  '呈现与商品真实用途相符的生活或商业场景，商品保持突出。',
  '用近景呈现材质、结构或关键功能细节，保留真实外观。',
  '以自然生活拍摄视角表现使用场景，不编造买家评价或使用效果。',
];

export function quickChoices(name, values) {
  return '<div class="quick-choices">' + values.map((entry, index) => {
    const [value, label] = Array.isArray(entry) ? entry : [entry, entry];
    return '<label><input type="radio" name="' + h(name) + '" value="' + h(value) + '"' +
      (index === 0 ? ' checked' : '') + '><span>' + h(label) + '</span></label>';
  }).join('') + '</div>';
}

function nearestRatio(width, height) {
  return ratioCandidates.reduce((nearest, value) => {
    const deviation = ratio => {
      const [w, h] = ratio.split(':').map(Number);
      return Math.abs(Math.log((w / h) / (width / height)));
    };
    return deviation(value) < deviation(nearest) ? value : nearest;
  });
}

export function quickPrompt(values, includeReference, imageType) {
  const style = values.style === '自定义' ? values.customStyle?.trim() || '按自定义风格要求' : values.style;
  const size = values.size === 'custom' ? values.width + '×' + values.height : values.size.replace('x', '×');
  const brief = [
    '根据提供的商品图片，生成一张适合「' + values.platform + '」平台、面向「' + values.region + '」市场的电商商品图。',
    '画面文字使用' + values.language + '，目标尺寸为 ' + size + ' 像素。主图类型为「' + imageType + '」，风格为「' + style + '」。',
    typeNotes[imageTypes.indexOf(imageType)],
    '画质要求：' + qualityNotes[Number(values.quality)] + '。保留商品的真实外形、颜色、包装和标识。',
    values.price === 'yes' ? '可预留价格区域，只有在追加要求明确提供价格时才显示具体金额。' : '画面不包含价格、货币符号或折扣金额。',
    includeReference ? '最后一张输入图仅供参考光线、构图和视觉风格，以其他输入中的商品为主体。' : '',
    '输出独立成图，避免拼图、多宫格、水印和与商品无关的文字。',
  ];
  return brief.filter(Boolean).join('\n');
}

function requestedSize(values) {
  const [width, height] = (values.size === 'custom' ? [values.width, values.height] : values.size.split('x')).map(Number);
  if (![width, height].every(value => Number.isInteger(value) && value >= 32 && value <= 1600)) {
    throw new Error('宽、高均需为 32–1600 像素。');
  }
  return { width, height, ratio: nearestRatio(width, height) };
}

function imageCount(values) {
  const count = Number(values.quantity);
  if (![1, 2, 3, 4].includes(count)) throw new Error('请选择生成数量。');
  return count;
}

export function quickRecipes(values, includeReference) {
  const { width, height, ratio } = requestedSize(values);
  if (values.style === '自定义' && !values.customStyle?.trim()) throw new Error('请输入自定义风格。');
  const kinds = values.quantity === 'suite' ? imageTypes : Array.from({ length: imageCount(values) }, () => values.imageType);
  return kinds.map((kind, index) => ({
    label: kinds.length === 1 ? kind : kind + ' ' + (index + 1),
    width, height, ...(values.modelId ? { modelId: values.modelId } : {}),
    parameters: {
      ratio,
      prompt: quickPrompt(values, includeReference, kind) + (values.notes?.trim() ? '\n追加要求：' + values.notes.trim() : ''),
    },
  }));
}

export function advancedRecipes(values, model) {
  const { prompt } = values;
  if (!prompt?.trim() || prompt.length > 1200) throw new Error('请输入 1–1200 字的完整提示词。');
  const { width, height, ratio } = requestedSize(values);
  const imageQuality = model?.imageQuality && nativeQualities[Number(values.quality)];
  return Array.from({ length: imageCount(values) }, (_, index) => ({
    label: '主图 ' + (index + 1), width, height,
    parameters: { prompt, ratio },
    ...(model ? { modelId: model.id } : {}), ...(imageQuality ? { imageQuality } : {}),
  }));
}
