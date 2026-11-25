
import { array, choice, freeObject, integer, object, text, uuid } from './http.js';

export const plugins = [
  { id: 'image', name: '商品图片' },
  { id: 'video', name: '商品视频' },
  { id: 'customer-service', name: 'AI 客服' },
  { id: 'operations', name: '店铺运营' },
  { id: 'copywriting', name: '电商文案' },
];

const platforms = choice('taobao', 'pinduoduo', 'douyin');
const ratio = choice('1:1', '3:4', '4:3', '9:16', '16:9');
const assetIds = array(uuid, 12, 1);
const mediaParameters = object({
  prompt: text(4000), assetIds, ratio, templateId: text(100),
  format: choice('png', 'jpg', 'psd', 'mp4', 'mp3'),
  options: object({
    skuCodes: array(text(100), 12, 1),
    productColor: text(40), scale: integer(2, 4), durationSeconds: integer(1, 10),
    keepAudio: { type: 'boolean' }, editInstructions: text(2000),
  }, []),
}, []);
const copyParameters = object({
  product: text(4000), platform: platforms, language: choice('zh', 'en'),
  format: choice('main-image', 'detail-page', 'sku'), instructions: text(2000),
}, ['product']);
const shopParameters = object({
  shopId: uuid, platform: platforms, startDate: { type: 'string', format: 'date' },
  endDate: { type: 'string', format: 'date' }, productIds: array(text(120), 30, 1),
  instructions: text(2000),
}, ['shopId', 'platform']);
const publishParameters = object({
  shopId: uuid, platform: platforms,
  listing: object({
    title: text(300), categoryId: text(120), description: text(10000), assetIds,
    variants: array(object({ sku: text(100), priceMinor: integer(1, 100000000), stock: integer(0, 10000000) }), 50, 1),
  }),
});
const maintenanceParameters = object({
  shopId: uuid, platform: platforms,
  changes: array(object({
    productId: text(120), title: text(300), priceMinor: integer(1, 100000000),
    stock: integer(0, 10000000), status: choice('unlisted'),
  }, ['productId']), 50, 1),
});

const definitions = [
  ['image', 'gateway', mediaParameters, [
    ['main-image', '商品主图'], ['detail-page', '详情页长图'], ['replace-background', '场景与背景替换', 1],
    ['try-on', '模特换装', 2, true], ['replace-product', '产品替换', 2, true], ['recolor', '商品换色', 1],
    ['inpaint', '局部重绘', 1], ['remove-background', 'AI 抠图', 1], ['upscale', '超清放大', 1],
    ['batch-sku', '多 SKU 批量'], ['outpaint', '智能延展', 1], ['platform-template', '多平台规格模板'],
    ['edit', '在线编辑', 1], ['consistent-set', '整套视觉一致性'], ['preserve-product', '商品主体保真', 1],
  ]],
  ['video', 'gateway', mediaParameters, [
    ['compose', '智能成片'], ['reference', '参考视频复刻', 1, true], ['replace-person', '人物替换', 2, true],
    ['try-on', '模特换装', 2, true], ['replace-product', '产品替换', 2, true], ['from-image', '图片转视频', 1],
    ['continuous-shot', '多图一镜到底', 4], ['three-views', '三视图生成', 1], ['template', '预设模板'],
    ['storyboard', '脚本分镜编辑与提示词提取'], ['reframe', '多比例', 1], ['export', '音轨与多格式导出', 1],
  ]],
  ['customer-service', 'endpoint', freeObject, [
    ['answer', '知识问答'], ['conversation', '多轮上下文'],
    ['handoff', '转人工'], ['quick-replies', '快捷话术'],
  ]],
  ['operations', 'gateway', shopParameters, [
    ['analysis', '运营分析与建议'], ['dashboard', '数据看板'], ['optimize-listing', '标题与卖点优化'],
  ]],
  ['operations', 'gateway', publishParameters, [['publish', '自动上架发布']]],
  ['operations', 'gateway', maintenanceParameters, [['bulk-maintenance', '批量维护']]],
  ['operations', 'unavailable', freeObject, [['authorization', '授权与店铺管理']]],
  ['copywriting', 'gateway', copyParameters, [
    ['generate', '三类商品文案'], ['platform-adaptation', '多平台适配'],
    ['translate', '多语言'], ['selling-points', '卖点与竞品对比'],
  ]],
  ['copywriting', 'local', object({ content: text(20000) }), [['detect-terms', '词语检测']]],
  ['customer-service', 'model:customer-agent', object({
    question: text(2000), facts: text(5000),
  }, ['question']), [['reply-draft', 'Customer-Agent 回复草稿']]],
  ['copywriting', 'model:ecommerce-content-agent', object({
    title: text(240), category: text(120), facts: text(4000), platform: choice('taobao','douyin','xiaohongshu'),
    tone: choice('professional','casual','trendy','luxury','cute'), audience: text(300), sellingPoints: array(text(300), 10),
  }, ['title','category','facts','platform']), [['content-package', '商品文案内容包']]],
];

const serviceEndpoints = {
  answer: '/v1/customer-service/conversations/{id}/messages',
  conversation: '/v1/customer-service/conversations',
  handoff: '/v1/customer-service/conversations/{id}/handoff',
  'quick-replies': '/v1/customer-service/quick-replies',
};
const confirmations = new Set(['operations.publish', 'operations.bulk-maintenance']);
export const catalog = new Map();

for (const [pluginId, execution, parameters, entries] of definitions) {
  for (const [slug, name, minAssets = 0, requiresConsent = false] of entries) {
    const id = pluginId + '.' + slug;
    catalog.set(id, {
      id, name, pluginId, execution, parameters, minAssets, requiresConsent,
      requiresConfirmation: confirmations.has(id),
      modes: ['chat', 'workflow'],
      cost: execution === 'endpoint' ? 0 : execution === 'local' ? 1 : ({ video: 5, image: 3 }[pluginId] ?? 2),
      ...(execution === 'endpoint' ? { endpoint: serviceEndpoints[slug] } : {}),
    });
  }
}

// Platform model utilities share task ownership, quotas, and billing with plugin tasks.
const utilitySchemas = {
  chat: object({
    messages: array(object({ role: choice('system', 'user', 'assistant'), content: text(8000) }), 32, 1),
    guidanceIds: { ...array(uuid, 4, 1), uniqueItems: true },
  }, ['messages']),
  embed: object({ input: array(text(8000), 16, 1) }),
  rerank: object({ query: text(2000), documents: array(text(4000), 50, 1), topN: integer(1, 50) }, ['query', 'documents']),
  speech: object({ input: text(4000), voice: text(100) }),
  transcribe: object({ assetIds: array(uuid, 1, 1), language: { type: 'string', pattern: '^[a-z]{2}$' } }, ['assetIds']),
};
for (const [name, parameters] of Object.entries(utilitySchemas)) {
  const id = 'model.' + name;
  catalog.set(id, { id, name, pluginId: 'models', execution: 'gateway', parameters, minAssets: name === 'transcribe' ? 1 : 0,
    requiresConsent: false, requiresConfirmation: false, modes: ['chat', 'workflow'], cost: 2 });
}

export const modelAlias = { ...text(64),pattern:'^[a-z][a-z0-9_-]{0,63}$' };
catalog.set('model.voice-turn',{
  id:'model.voice-turn',name:'单轮语音问答',pluginId:'models',execution:'voice-turn',
  parameters:object({assetIds:array(uuid,1,1),transcriptionModelId:modelAlias,chatModelId:modelAlias,speechModelId:modelAlias,
    voice:text(100),language:{type:'string',pattern:'^[a-z]{2}$'},instructions:text(1000)},
    ['assetIds','transcriptionModelId','chatModelId','speechModelId','voice']),
  minAssets:1,requiresConsent:false,requiresConfirmation:false,modes:['chat','workflow'],cost:6,
});

export const capabilityId = choice(...catalog.keys());
export const capabilityRules = [...catalog.values()].map(capability => ({
  if: { properties: { capabilityId: { const: capability.id } }, required: ['capabilityId'] },
  then: { properties: { parameters: capability.id==='model.chat'
    ? {...capability.parameters,properties:{...capability.parameters.properties,stream:{type:'boolean'}}}
    : capability.parameters } },
}));

export function detectTerms({ content }) {
  const replacements = { '100%': '较高比例', '第一': '表现突出', '最': '较' };
  const matches = Array.from(content.matchAll(/100%|第一|最/gu), ({ 0: term, index }) => ({
    term, start: index, end: index + term.length, suggestion: replacements[term],
  }));
  return { matches, offsetUnit: 'utf16' };
}
