export const factGroups = [
  ['selling', '卖点'], ['pain', '痛点'], ['scene', '使用场景'], ['audience', '适用人群'], ['expression', '表达方式'],
];

function jsonObject(text) {
  try {
    const result = JSON.parse(String(text ?? '').trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, ''));
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch { /* The caller shows a retryable format error. */ }
  throw new Error('模型返回的内容格式有误，可重试此步骤。');
}

function validText(text, maxLength) {
  return typeof text === 'string' && text.trim().length > 0 && text.trim().length <= maxLength;
}

export function directorFacts(text) {
  const data = jsonObject(text);
  const facts = factGroups.flatMap(([id, label]) => {
    if (!Array.isArray(data[id])) return [];
    return [...new Set(data[id].filter(item => validText(item, 120)).map(item => item.trim()))]
      .slice(0, 3).map(value => ({ label, value }));
  });
  if (!facts.length) throw new Error('未提炼出可选择的商品信息，可查看任务或重试。');
  return facts;
}

export function directorDirections(text) {
  const { directions } = jsonObject(text);
  const items = Array.isArray(directions) ? directions.filter(item => validText(item?.title, 32) && validText(item?.detail, 280)) : [];
  const unique = [...new Map(items.map(item => [item.title.trim(), { title: item.title.trim(), detail: item.detail.trim() }])).values()].slice(0, 4);
  if (unique.length < 2) throw new Error('模型未返回至少两个创作方向，可查看任务或重试。');
  return unique;
}

export function directorPlanInput(step, run, limit) {
  const settings = ['时长 ' + run.input.duration + ' 秒', run.input.ratio && '比例 ' + run.input.ratio].filter(Boolean).join('，');
  const checked = run.facts?.filter((_, index) => run.selectedFacts.has(index)).map(({ label, value }) => label + '：' + value).join('\n');
  const grounding = '你只收到用户提供的文字。不要声称识别过商品图，不添加未经提供的规格、价格、认证或功效。';
  const directions = run.directions?.[run.selectedDirection];
  const prompts = {
    insights: [
      grounding + '提炼给定商品的拍摄信息。只输出包含 selling、pain、scene、audience、expression 五个键的 JSON，各键为最多 3 条的字符串数组。' +
        '卖点仅取已给信息。痛点、场景、人群、表达方式允许给出明确标为建议的拍摄构思，每项最多 120 字，确实未知时返回空数组。',
      '商品信息：\n' + run.input.notes,
    ],
    directions: [
      grounding + '只使用已勾选信息，给出 2–4 个有区别的视频创作方向。只输出 JSON，格式为 {"directions":[{"title":"方向名称","detail":"拍摄设计"}]}。' +
        '名称最多 32 字，拍摄设计最多 280 字。标明镜头、节奏或构图上的取舍。',
      settings + '\n已选信息：\n' + checked,
    ],
    script: [
      grounding + '根据选择的创作方向写可直接用于图生视频的逐镜头脚本，包括主体、动作、运镜和镜头衔接。' +
        '成片会提供商品首帧，必须保留其主体与真实外观。只输出可编辑脚本文字，最多 ' + limit + ' 字。',
      settings + '\n已选信息：\n' + checked + '\n创作方向：' + (directions ? directions.title + '\n' + directions.detail : ''),
    ],
  };
  const [system, user] = prompts[step];
  return { capabilityId: 'model.chat', mode: 'workflow', parameters: { messages: [
    { role: 'system', content: system }, { role: 'user', content: user },
  ] } };
}
