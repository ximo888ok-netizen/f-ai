import { invalid } from './http.js';
import { validateMappedMedia } from './model-mapping.js';

export const videoInputModes = { 'video.compose': 'text', 'video.from-image': 'frame', 'video.reference': 'reference' };
// Stored tasks signed with the previous media parameter schema remain executable
// only across this specific, additive contract revision.
const contractUpgrade = {
  'video.compose': ['76ad1386e8221e97117cac7bc21cb8130cd300726f9810db316c2d1cedd0e2d0', 'fd8961d724cf691fc43ff6b71ac7a8c13716f7b1110303ff004cd25059534c7f'],
  'video.from-image': ['0b6ebc60ed714904f3e7f0c44c54e1b9c6b14d61bd2f2faaf880940d33dd518b', '69262cc9dd606dcfbd3bb735bdc5f89479cb782a145b31d28d9e453d08935a02'],
  'video.reference': ['f392114f099d888ed9afb2ed77203bbea27693d445cffcd4acd2eb37baaf209d', '99efaea7c8b7762e67d095561385ad3232ddb40c21fa0bbf781276d427b1edba'],
};

export function matchesTaskContract(id, saved, current) {
  return saved === current || (contractUpgrade[id]?.[0] === saved && contractUpgrade[id]?.[1] === current);
}

const legacyRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const ratios = [...legacyRatios, '21:9'];
const range = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const both = (durations, resolutions, audio, frameRatios = ratios) => ({
  text: { ratios, durations, resolutions, audio },
  frame: { ratios: frameRatios, durations, resolutions, audio },
});

function nativeOptions({ protocol, model }) {
  if (protocol === 'wan3-video' && ['wan3.0-video', 'wan3.0-video-prime'].includes(model)) {
    return both(range(2, 30), ['480p', '720p', '1080p'], true);
  }
  if (protocol === 'ark-video') {
    if (model === 'doubao-seedance-2-5-260628') return both(range(4, 30), ['480p', '720p', '1080p', '4k'], true, []);
    if (model === 'doubao-seedance-2-5-flash-261115') return both(range(4, 30), ['480p', '720p'], true, []);
  }
  if (protocol === 'minimax-h3-video' && ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max'].includes(model)) {
    const resolutions = model === 'MiniMax-H3' ? ['480p', '768p', '2k'] : ['480p', '768p'];
    return both(range(model === 'MiniMax-H3-Max' ? 5 : 4, 15), resolutions, true, []);
  }
  if (protocol === 'kling-video') {
    if (model === 'kling-4.0') return both(range(3, 30), ['720p', '1080p', '4k'], false, []);
    if (model === 'kling-4.0-flash') return both(range(3, 20), ['720p'], false, []);
  }
  if (protocol === 'runway-video' && model === 'gen4.5') {
    const options = both(range(2, 10), [], false, [...ratios, '9:21']);
    options.text.ratios = ['16:9', '9:16'];
    return options;
  }
  if (protocol === 'minimax-video' && ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02'].includes(model)) {
    const spec = { ratios: [], resolutions: [], durations: [6, 10], audio: false };
    return { text: spec, frame: spec };
  }
  return {};
}

function uniqueList(values, accepts) {
  return Array.isArray(values) && values.every(accepts) && new Set(values).size === values.length;
}

export function configuredVideoOptions(route, declared, capabilities) {
  const supported = Object.entries(videoInputModes).filter(([id]) => capabilities.includes(id)).map(([, mode]) => mode);
  if (declared === undefined) return Object.fromEntries(Object.entries(nativeOptions(route)).filter(([mode]) => supported.includes(mode)));
  if (route.protocol !== 'json-http' || route.kind !== 'video' || !declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error('Custom videoOptions require a json-http video route');
  }
  const options = {};
  for (const [mode, spec] of Object.entries(declared)) {
    if (!supported.includes(mode) || !spec || Object.keys(spec).some(key => !['ratios', 'resolutions', 'durations', 'audio'].includes(key)) ||
        !uniqueList(spec.ratios, value => typeof value === 'string' && /^\d{1,3}:\d{1,3}$/.test(value)) ||
        !uniqueList(spec.resolutions, value => typeof value === 'string' && /^[a-z0-9][a-z0-9x-]{0,19}$/i.test(value)) ||
        !uniqueList(spec.durations, value => Number.isSafeInteger(value) && value >= 1) || typeof spec.audio !== 'boolean') {
      throw new Error('Invalid videoOptions for mode ' + mode);
    }
    const sample = { prompt: 'video', ...(mode === 'text' ? {} : { assetIds: ['source'] }) };
    if (spec.ratios.length) sample.ratio = spec.ratios[0];
    const fields = {};
    if (spec.durations.length) fields.durationSeconds = spec.durations[0];
    if (spec.resolutions.length) fields.resolution = spec.resolutions[0];
    if (spec.audio) fields.generateAudio = false;
    if (Object.keys(fields).length) sample.options = fields;
    validateMappedMedia(route.mapping, sample);
    options[mode] = { ...spec, durations: [...spec.durations].sort((a, b) => a - b) };
  }
  return options;
}

export function validateVideoOptions(spec, params) {
  const { durationSeconds, resolution, generateAudio } = params.options ?? {};
  if (params.ratio !== undefined && !(spec?.ratios ?? legacyRatios).includes(params.ratio)) throw invalid('当前模型和输入方式不支持所选画幅');
  if (durationSeconds !== undefined && (spec ? !spec.durations.includes(durationSeconds) : durationSeconds > 10)) {
    throw invalid('当前模型不支持所选视频秒数');
  }
  if (resolution !== undefined && !spec?.resolutions.includes(resolution)) throw invalid('当前模型不支持所选清晰度');
  if (generateAudio !== undefined && (!spec?.audio || typeof generateAudio !== 'boolean')) throw invalid('当前模型不支持所选声音设置');
}
