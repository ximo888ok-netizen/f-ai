import { h, field, select, notice, link, input, textarea } from './live-ui.js';

export const platforms = { taobao: '淘宝', pinduoduo: '拼多多', douyin: '抖店' };
const labels = {
  prompt:'创作提示词', assetIds:'素材库文件', ratio:'画幅比例', templateId:'模板编号', format:'输出格式', options:'进阶参数',
  skuCodes:'SKU 编号，每行一个', productColor:'商品颜色', scale:'放大倍数', durationSeconds:'视频时长（秒）', keepAudio:'保留音轨',
  editInstructions:'编辑要求', product:'商品信息', platform:'平台', language:'语言', instructions:'补充要求', content:'待检测文案',
  shopId:'店铺', startDate:'开始日期', endDate:'结束日期', productIds:'商品编号，每行一个', listing:'发布内容', title:'商品标题',
  categoryId:'平台分类编号', description:'商品详情', variants:'规格清单', changes:'待变更商品清单', messages:'对话消息',
  input:'输入文本', voice:'音色', query:'查询文本', documents:'待重排文档，每行一项', topN:'最多返回数量',
  chat:'模型对话', embed:'文本向量', rerank:'文本重排', speech:'语音合成', transcribe:'语音转写',
};
export const cardTitle = capability => labels[capability.name] ?? capability.name;

export function schemaFields(schema, prefix, data) {
  return Object.entries(schema.properties ?? {}).map(([key, node]) => {
    const name = prefix + key;
    if (key === 'platform' && data.capability.pluginId === 'operations') return '';
    const label = labels[key] ?? key;
    const required = schema.required?.includes(key) ?? false;
    let attributes = required ? 'required ' : '';
    if (node.type === 'object') return '<fieldset><legend>' + h(label) + '</legend>' + schemaFields(node, name + '.', data) + '</fieldset>';
    if (node.enum) return field(label, select(name, (required ? [] : [['', '请选择']]).concat(node.enum.map(value => [value, platforms[value] ?? value])), undefined, attributes));
    if (key === 'assetIds') {
      const assets = data.assets.filter(asset => !data.capability.requiresConsent || (asset.consentReference && Date.parse(asset.consentExpiresAt) > Date.now()));
      return field(label + '（支持多选）', select(name, assets.map(asset => [asset.id, asset.name]), undefined, 'multiple ' + attributes)) +
        (!assets.length ? notice('素材库没有符合条件的文件。') : '') + link('打开素材库', 'assets');
    }
    if (key === 'shopId') return field(label, select(name, data.shops.map(shop => [shop.id, shop.name + ' · ' + platforms[shop.platform]]), undefined, attributes));
    if (node.type === 'boolean') return field(label, select(name, [['','使用默认值'],['true','是'],['false','否']]));
    if (node.type === 'integer') return field(label, input(name, attributes + 'type="number" min="' + node.minimum + '" max="' + node.maximum + '"'));
    if (key === 'guidanceIds') return field('专家、专家团或技能', select(name,(data.guidance ?? []).map(e=>[e.id,e.name]),data.selectedGuidance ?? [],'multiple'));
    if (key === 'messages') return field('系统指令（选填）', textarea('conversation.system', 'maxlength="8000"')) +
      field('你的消息', textarea('conversation.user', 'required maxlength="8000"'));
    if (node.type === 'array') {
      const examples = {
        variants:'[{"sku":"A1","priceMinor":9900,"stock":12}]',
        changes:'[{"productId":"填写平台商品号","stock":12}]',
        messages:'[{"role":"user","content":"填写问题"}]',
      };
      return field(label + (node.items.type === 'object' ? '（JSON 列表）' : ''), textarea(name,
        attributes + (examples[key] ? 'placeholder="' + h(examples[key]) + '"' : '')));
    }
    if (node.maxLength) attributes += 'maxlength="' + node.maxLength + '" ';
    return field(label, node.maxLength > 300 ? textarea(name, attributes) : input(name, attributes + (node.format === 'date' ? 'type="date"' : '')));
  }).join('');
}

export function parametersFrom(schema, prefix, formData, shops) {
  const params = {};
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const name = prefix + key;
    if (key === 'messages') {
      const system = formData.get('conversation.system')?.trim();
      const user = formData.get('conversation.user');
      params.messages = [...(system ? [{ role:'system', content:system }] : []), { role:'user', content:user }];
      continue;
    }
    const value = formData.get(name);
    if (node.type === 'object') {
      const nested = parametersFrom(node, name + '.', formData, shops);
      if (Object.keys(nested).length) params[key] = nested;
    } else if (key === 'assetIds' || key === 'guidanceIds') {
      const ids = formData.getAll(name);
      if (ids.length) params[key] = ids;
    } else if (value !== null && value !== '') {
      if (node.type === 'integer') params[key] = Number(value);
      else if (node.type === 'boolean') params[key] = value === 'true';
      else if (node.type === 'array' && node.items.type === 'object') {
        try { params[key] = JSON.parse(value); }
        catch { throw new Error((labels[key] ?? key) + '需要填写有效的 JSON 列表。'); }
        if (!Array.isArray(params[key])) throw new Error((labels[key] ?? key) + '需要填写 JSON 列表。');
      } else if (node.type === 'array') params[key] = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      else params[key] = value;
    }
  }
  if (params.shopId) params.platform = shops.find(shop => shop.id === params.shopId)?.platform;
  return params;
}
