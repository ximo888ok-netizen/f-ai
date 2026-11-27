// Official model IDs are also used to derive stable workspace model aliases.
const families = [
  ['qwen-image', 'FAI_DASHSCOPE_KEY', 'compatible-mode/v1', ['qwen-image-3.0', 'qwen-image-3.0-pro']],
  ['wan3-video', 'FAI_DASHSCOPE_KEY', 'api/v1', ['wan3.0-video', 'wan3.0-video-prime']],
  ['seedream-image', 'FAI_ARK_KEY', 'https://ark.cn-beijing.volces.com/api/v3', ['doubao-seedream-5-5-261028']],
  ['ark-video', 'FAI_ARK_KEY', 'https://ark.cn-beijing.volces.com/api/v3',
    ['doubao-seedance-2-5-260628', 'doubao-seedance-2-5-flash-261115']],
  ['minimax-h3-image', 'FAI_MINIMAX_KEY', 'https://api.minimax.cn/v1', ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed']],
  ['minimax-h3-video', 'FAI_MINIMAX_KEY', 'https://api.minimax.cn/v2',
    ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max']],
  ['kling-video', 'FAI_KLING_KEY', 'https://api-beijing.klingai.com', ['kling-4.0', 'kling-4.0-flash']],
];

export function mediaModelPresets(names, env) {
  return names.map(model => {
    const family = families.find(([, , , models]) => models.includes(model));
    if (!family) throw new Error('Unknown model in FAI_MEDIA_MODELS: ' + model);
    const [protocol, keyEnv, endpoint] = family;
    let baseUrl = endpoint;
    if (keyEnv === 'FAI_DASHSCOPE_KEY') {
      const workspace = env.FAI_DASHSCOPE_WORKSPACE;
      if (!workspace || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(workspace)) {
        throw new Error('Set FAI_DASHSCOPE_WORKSPACE to the Beijing Model Studio workspace identifier');
      }
      baseUrl = 'https://' + workspace + '.cn-beijing.maas.aliyuncs.com/' + endpoint;
    }
    return { id: model.toLowerCase().replaceAll('.', '-'), model, protocol, keyEnv, baseUrl };
  });
}
