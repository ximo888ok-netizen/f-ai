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

export function videoLimits(model, type, capability) {
  const spec = model?.videoOptions?.[type];
  const durations = spec?.durations ?? [];
  return { ratios: spec?.ratios ?? [], resolutions: spec?.resolutions ?? [], durations, audio: spec?.audio === true,
    min: durations[0], max: durations.at(-1),
    promptMax: model?.protocol === 'runway-video' ? 1000 : capability?.parameters?.properties?.prompt?.maxLength ?? 4000 };
}

export function videoTaskInput({ capabilityId, modelId, prompt, asset, ratio, duration, resolution, audio }) {
  const parameters = { prompt };
  if (asset) parameters.assetIds = [asset.id];
  if (ratio) parameters.ratio = ratio;
  const options = {};
  if (duration) options.durationSeconds = duration;
  if (resolution) options.resolution = resolution;
  if (typeof audio === 'boolean') options.generateAudio = audio;
  if (Object.keys(options).length) parameters.options = options;
  return { capabilityId, mode: 'workflow', ...(modelId ? { modelId } : {}), parameters };
}

export function videoPlanSettings({ ratio, duration, resolution, audio }) {
  return [ratio && '画幅 ' + ratio, duration && '时长 ' + duration + ' 秒', resolution && '清晰度 ' + resolution,
    typeof audio === 'boolean' && (audio ? '有声成片' : '无声成片')].filter(Boolean).join('，');
}

export function videoPlanInput(input, limit) {
  const { prompt, skill, asset } = input;
  const direction = videoSkills.find(([id]) => id === skill)?.[3] ?? videoSkills[0][3];
  return { capabilityId: 'model.chat', mode: 'workflow', parameters: { messages: [
    { role: 'system', content: '你是电商短视频编导。返回可直接发给视频模型的一段完整提示词，描述画面、镜头、动作、运镜和节奏。' +
      '使用用户的语言，只返回提示词，最多 ' + limit + ' 字。只知道用户给出的文字与素材类型，不可声称看过素材，不添加未经提供的商品事实。' },
    { role: 'user', content: [direction, videoPlanSettings(input),
      asset && '成片时会提供' + (asset.mediaType === 'video/mp4' ? '参考视频' : '首帧图片'), '创作要求：' + prompt].filter(Boolean).join('\n') },
  ] } };
}
