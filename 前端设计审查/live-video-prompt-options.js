export const videoInputs = {
  text: { label: '文字生成视频', capabilityId: 'video.compose' },
  frame: { label: '首帧图生成', capabilityId: 'video.from-image' },
  reference: { label: '参考视频', capabilityId: 'video.reference' },
};

export const videoSkills = [
  ['auto', '自动编排', '按要求决定镜头与节奏。', '根据需求安排镜头、运镜和节奏。'],
  ['story', '剧情演绎', '先交代情境，再通过动作呈现商品卖点。', '用一个简短场景引出商品，通过动作呈现卖点。'],
];

export const videoTemplates = [
  ['商品展示', '全貌 → 细节 → 定格', '先用中景展示商品全貌，再用近景拍摄关键细节，最后以一个稳定的商品镜头收尾。'],
  ['场景演绎', '使用场景 → 动作 → 商品', '先展示商品的真实使用场景，再用连续动作说明用途，最后回到商品本身。'],
  ['口播短片', '开场问题 → 卖点 → 收尾', '用一句与商品用途相关的问题开场，以画面说明已提供的卖点，最后用简短口播收尾。'],
];

export const videoRatios = [['', '模型默认'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:4', '3:4']];

export function videoLimits(model, type, capability) {
  const schema = capability?.parameters?.properties;
  const ratios = schema?.ratio?.enum ?? [];
  const duration = schema?.options?.properties?.durationSeconds;
  const runway = model?.protocol === 'runway-video';
  const accepted = runway ? (type === 'frame' ? ['16:9', '9:16', '1:1'] : ['16:9', '9:16']) : ratios;
  return {
    ratios: model?.protocol === 'minimax-video' ? [] : ratios.filter(ratio => accepted.includes(ratio)),
    min: Math.max(duration?.minimum ?? 1, runway ? 2 : 1), max: duration?.maximum ?? 10,
    promptMax: runway ? 1000 : schema?.prompt?.maxLength ?? 4000,
  };
}

export function videoTaskInput({ capabilityId, modelId, prompt, asset, ratio, duration }) {
  const parameters = { prompt };
  if (asset) parameters.assetIds = [asset.id];
  if (ratio) parameters.ratio = ratio;
  if (duration) parameters.options = { durationSeconds: duration };
  return { capabilityId, mode: 'workflow', ...(modelId ? { modelId } : {}), parameters };
}

export function videoPlanInput({ prompt, skill, asset, ratio, duration }, limit) {
  const direction = videoSkills.find(([id]) => id === skill)?.[3] ?? videoSkills[0][3];
  return { capabilityId: 'model.chat', mode: 'workflow', parameters: { messages: [
    { role: 'system', content: '你是电商短视频编导。返回可直接发给视频模型的一段完整提示词，描述画面、镜头、动作、运镜和节奏。' +
      '使用用户的语言，只返回提示词，最多 ' + limit + ' 字。只知道用户给出的文字与素材类型，不可声称看过素材，不添加未经提供的商品事实。' },
    { role: 'user', content: [direction, ratio && '画幅 ' + ratio, duration && '时长 ' + duration + ' 秒',
      asset && '成片时会提供' + (asset.mediaType === 'video/mp4' ? '参考视频' : '首帧图片'), '创作要求：' + prompt].filter(Boolean).join('\n') },
  ] } };
}
