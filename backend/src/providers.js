import { ApiError } from './http.js';
import { detectTerms } from './catalog.js';
import { ProviderError, requestUpstream } from './model-http.js';

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
    async run(task, payload) {
      const data = await requestUpstream(endpoint, { headers: { authorization: 'Bearer ' + token, 'idempotency-key': task.id }, body: payload, repeatable: true });
      if (!data?.result || typeof data.result !== 'object' || Array.isArray(data.result)) throw new ProviderError('INVALID_PROVIDER_RESULT');
      return data.result;
    },
  });
  return providers;
}

export function matchingProviders(providers, capability) {
  if (capability.execution !== 'gateway') return providers.get(capability.execution)?.supports(capability) ? [capability.execution] : [];
  const matches = [];
  for (const [id, provider] of providers) {
    if (provider.info && provider.supports(capability)) matches.push(id);
  }
  if (providers.get('gateway')?.supports(capability)) matches.push('gateway');
  return matches;
}

export function providerFor(providers, capability, modelId) {
  if (capability.execution === 'endpoint') throw new ApiError(400, 'USE_CAPABILITY_ENDPOINT', 'Use ' + capability.endpoint);
  const matches = matchingProviders(providers, capability);
  if (modelId !== undefined) {
    if (!matches.includes('model:' + modelId)) throw new ApiError(422, 'MODEL_NOT_SUPPORTED', 'Model alias is unavailable for this capability');
    return 'model:' + modelId;
  }
  if (!matches.length) throw new ApiError(503, 'CAPABILITY_UNAVAILABLE', 'No enabled provider for this capability');
  return matches[0];
}
