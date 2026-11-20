
import { ApiError } from './http.js';
import { detectTerms } from './catalog.js';

export class ProviderError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

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
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + token,
            'content-type': 'application/json',
            'idempotency-key': task.id,
          },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: AbortSignal.timeout(45000),
        });
      } catch {
        throw new ProviderError('PROVIDER_UNREACHABLE', true);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError('PROVIDER_REJECTED', response.status >= 500 || response.status === 429);
      }
      let data;
      try {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 512 * 1024) {
            await reader.cancel();
            throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
          }
          chunks.push(value);
        }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('INVALID_PROVIDER_RESULT', true);
      }
      if (!data || !data.result || typeof data.result !== 'object' || Array.isArray(data.result)) {
        throw new ProviderError('INVALID_PROVIDER_RESULT');
      }
      return data.result;
    },
  });
  return providers;
}

export function providerFor(providers, capability) {
  if (capability.execution === 'endpoint') {
    throw new ApiError(400, 'USE_CAPABILITY_ENDPOINT', 'Use ' + capability.endpoint);
  }
  const provider = providers.get(capability.execution);
  if (!provider?.supports(capability)) {
    throw new ApiError(503, 'CAPABILITY_UNAVAILABLE', 'No enabled provider for this capability');
  }
  return capability.execution;
}
