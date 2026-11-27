import { ApiError } from './http.js';
import { detectTerms } from './catalog.js';
import { voiceTurnProvider } from './voice-turn.js';
import { mediaUrl, ProviderError, requestUpstream } from './model-http.js';
import { GeneratedFile } from './model-file.js';
import { validateVideoOptions, videoInputModes } from './video-options.js';

export { ProviderError };

export function createProviders({ url, token, capabilities = [] } = {}) {
  const providers = new Map([['local', {
    supports: capability => capability.id === 'copywriting.detect-terms',
    run: async task => detectTerms(task.input.parameters),
  }]]);
  if (!url && !token && !capabilities.length) return providers;
  if (!url || !token || !capabilities.length) throw new Error('Gateway URL, token, and capability allow-list must be configured together');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error('Gateway URL must be a clean HTTPS endpoint');
  }
  const enabled = new Set(capabilities);
  providers.set('gateway', {
    supports: capability => enabled.has(capability.id),
    validate(capability, parameters) {
      if (Object.hasOwn(videoInputModes, capability.id)) validateVideoOptions(undefined, parameters);
    },
    async run(task, payload) {
      const data = await requestUpstream(endpoint, { headers: { authorization: 'Bearer ' + token, 'idempotency-key': task.id }, body: payload, repeatable: true });
      const result = data?.result;
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.keys(result).length) throw new ProviderError('INVALID_PROVIDER_RESULT');
      const kind = { 'image.main-image':'image', 'video.compose':'video', 'video.from-image':'video' }[payload.capabilityId];
      if (!kind) return result;
      if (result.type && result.type !== kind) throw new ProviderError('INVALID_PROVIDER_RESULT');
      if (kind === 'image' && result.dataBase64) return GeneratedFile.image(result.dataBase64, result.mediaType);
      if (result.assetId !== undefined) {
        if (typeof result.assetId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.assetId)) throw new ProviderError('INVALID_PROVIDER_RESULT');
        return { ...result, type:kind };
      }
      return { ...result, type:kind, url:mediaUrl(result.url) };
    },
  });
  return providers;
}

export function taskProvider(providers,id) {
  return id==='voice-turn'?voiceTurnProvider(providers):providers.get(id);
}

export function matchingProviders(providers, capability) {
  if (capability.execution !== 'gateway') return taskProvider(providers,capability.execution)?.supports(capability) ? [capability.execution] : [];
  if(capability.mediaSkill){
    const s=capability.mediaSkill;
    return [...providers].filter(([,p])=>p.info && p.supports(capability) &&
      (p.info.id===s.alias || p.info.protocol===(s.native??s.alsoNative))).map(([id])=>id);
  }
  const matches = [];
  for (const [id, provider] of providers) {
    if (provider.info && provider.supports(capability)) matches.push(id);
  }
  if (providers.get('gateway')?.supports(capability)) matches.push('gateway');
  return matches;
}

export function providerFor(providers, capability, modelId, stream=false) {
  if (capability.execution === 'endpoint') throw new ApiError(400, 'USE_CAPABILITY_ENDPOINT', 'Use ' + capability.endpoint);
  let matches = matchingProviders(providers, capability);
  if (stream) {
    matches=matches.filter(id=>typeof providers.get(id).streamText==='function');
    if (!matches.length || (modelId!==undefined && !matches.includes('model:'+modelId))) {
      throw new ApiError(modelId===undefined?503:422,'MODEL_STREAM_UNAVAILABLE','Select a model configured for text streaming');
    }
  }
  if (modelId !== undefined) {
    if (!matches.includes('model:' + modelId)) throw new ApiError(422, 'MODEL_NOT_SUPPORTED', 'Model alias is unavailable for this capability');
    return 'model:' + modelId;
  }
  if (!matches.length) throw new ApiError(503, 'CAPABILITY_UNAVAILABLE', 'No enabled provider for this capability');
  return matches[0];
}
