import { createHash } from 'node:crypto';
import { catalog } from './catalog.js';
import { invalid, object, route as httpRoute, text } from './http.js';
import { requestUpstream } from './model-http.js';
import { generateImage } from './model-image.js';
import { pollMapped, runMapped, validateMappedMedia, validateMapping } from './model-mapping.js';
import { generateText, textCapabilities, textPrompt } from './model-text.js';
import { utilityCapabilities, runUtility } from './model-utilities.js';
import { pollVideo, startVideo } from './model-video.js';

const protocols = {
  'openai-embeddings': 'embedding', 'cohere-rerank': 'rerank', 'openai-transcription': 'transcription', 'openai-speech': 'speech',
  'chat-completions': 'text', responses: 'text', 'anthropic-messages': 'text', 'gemini-content': 'text',
  'cohere-chat': 'text', 'ollama-chat': 'text', 'openai-images': 'image', 'gemini-image': 'image',
  'runway-video': 'video', 'ark-video': 'video', 'wan-video': 'video', 'minimax-video': 'video',
};
const idPattern = '^[a-z][a-z0-9_-]{0,63}$';
export const modelIdSchema = { ...text(64), pattern: idPattern };

function cleanBase(raw) {
  const base = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username || base.password || base.search || base.hash) throw new Error('Invalid model baseUrl');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return { base, loopback };
}

function validateParameters(config, capability, params) {
  if (config.kind === 'rerank' && params.topN > params.documents.length) throw invalid('topN exceeds the document count');
  if (capability.id === 'model.chat') {
    const { messages } = params;
    const start = messages[0].role === 'system' ? 1 : 0;
    if (messages[start]?.role !== 'user' || messages.at(-1).role !== 'user' || messages.slice(start).some(item => item.role === 'system')) {
      throw invalid('Use an optional initial system message followed by a conversation starting and ending with the user');
    }
  }
  if (config.kind === 'text' || utilityCapabilities[config.kind]) return;
  if (config.protocol === 'json-http') return validateMappedMedia(config.mapping, params);
  if (!params.prompt?.trim()) throw invalid('This model requires a prompt');
  const count = params.assetIds?.length ?? 0;
  if (config.protocol === 'wan-video' && count) throw invalid('This model route only accepts text input');
  if (config.kind === 'video' && count > 1) throw invalid('This model route accepts at most one first-frame image');
  if (capability.id === 'video.from-image' && count !== 1) throw invalid('Select one first-frame image');
  if (params.templateId) throw invalid('Template execution requires a workflow provider');
  const supportedOptions = config.kind === 'video' ? ['durationSeconds'] : [];
  if (Object.keys(params.options ?? {}).some(key => !supportedOptions.includes(key))) throw invalid('Unsupported model option');
  if (params.format && !(config.kind === 'image' ? ['png', 'jpg'] : ['mp4']).includes(params.format)) throw invalid('Unsupported model output format');
  if (config.protocol === 'openai-images' && params.ratio && params.ratio !== '1:1') throw invalid('This route supports explicit square images only');
  if (config.protocol === 'runway-video') {
    const ratios = count ? ['16:9', '9:16', '1:1'] : ['16:9', '9:16'];
    if ((params.ratio && !ratios.includes(params.ratio)) || params.prompt.length > 1000 || params.options?.durationSeconds < 2) throw invalid('Unsupported Runway ratio, duration or prompt length');
  }
  if (config.protocol === 'minimax-video' && params.ratio) throw invalid('This video route does not accept an aspect ratio');
}

function allowed(protocol, kind) {
  if (utilityCapabilities[kind]) return utilityCapabilities[kind];
  if (protocol === 'json-http' && ['image', 'video'].includes(kind)) {
    return [...catalog.values()].filter(capability => capability.pluginId === kind).map(capability => capability.id);
  }
  if (kind === 'text') return ['model.chat', ...textCapabilities];
  if (kind === 'video') return protocol === 'wan-video' ? ['video.compose'] : ['video.compose', 'video.from-image'];
  return ['image.main-image', 'image.replace-background', 'image.recolor', 'image.outpaint'];
}

function headersFor(config, key) {
  if (!key) return {};
  if (config.protocol === 'anthropic-messages') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (config.protocol === 'runway-video') return { authorization: 'Bearer ' + key, 'X-Runway-Version': '2024-11-06' };
  if (config.protocol.startsWith('gemini-')) return { 'x-goog-api-key': key };
  if (config.protocol === 'json-http') {
    const scheme = config.mapping.authScheme ?? 'Bearer';
    return { [config.mapping.authHeader ?? 'authorization']: scheme ? scheme + ' ' + key : key };
  }
  if (config.apiKeyHeader === 'api-key') return { 'api-key': key };
  return { authorization: 'Bearer ' + key };
}

export function installModels(providers, definitions, env = process.env) {
  if (!Array.isArray(definitions)) throw new Error('Model configuration must be an array');
  for (const entry of definitions) {
    if (entry?.enabled === false) continue;
    if (entry?.enabled !== undefined && entry.enabled !== true) throw new Error('Model enabled must be a boolean');
    if (!entry || typeof entry.id !== 'string' || !new RegExp(idPattern).test(entry.id) || providers.has('model:' + entry.id)) throw new Error('Invalid or duplicate model alias');
    if (typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 256) throw new Error('Invalid upstream model name');
    if (entry.protocol === 'json-http') validateMapping(entry.mapping);
    else if (!Object.hasOwn(protocols, entry.protocol)) throw new Error('Unknown model protocol');
    if (entry.apiKeyHeader && (entry.protocol !== 'chat-completions' || entry.apiKeyHeader !== 'api-key')) throw new Error('Unsupported model key header');
    const kind = entry.protocol === 'json-http' ? entry.mapping.kind : protocols[entry.protocol];
    const { base, loopback } = cleanBase(entry.baseUrl);
    if (entry.keyEnv !== undefined && (typeof entry.keyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(entry.keyEnv))) throw new Error('Invalid model keyEnv');
    const key = entry.keyEnv && env[entry.keyEnv];
    if (!key && (!loopback || entry.keyEnv)) throw new Error('Missing credentials for model ' + entry.id);
    const supported = allowed(entry.protocol, kind);
    if (entry.protocol === 'json-http' && !entry.capabilities) throw new Error('Specify the supported capabilities for a mapped model');
    const capabilities = entry.capabilities ?? supported;
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(id => !supported.includes(id))) throw new Error('Invalid capabilities for model ' + entry.id);
    const config = { id: entry.id, model: entry.model, protocol: entry.protocol, kind, mapping: entry.mapping, apiKeyHeader: entry.apiKeyHeader };
    const headers = headersFor(config, key);
    const info = { id: config.id, model: config.model, protocol: config.protocol, kind, capabilities: [...new Set(capabilities)] };
    const signature = createHash('sha256').update(JSON.stringify([base.href, config, entry.keyEnv])).digest('hex');
    const call = (path, body, extra, binary = false) => requestUpstream(new URL(path, base), {
      body, headers: { ...headers, ...extra }, repeatable: body === undefined,
      maxBytes: binary ? 10 * 1024 * 1024 : ['image', 'embedding'].includes(kind) ? 15 * 1024 * 1024 : 512 * 1024, binary, timeout: body === undefined ? 30000 : 90000,
    });
    const adapter = {
      info, signature,
      supports: capability => capabilities.includes(capability.id),
      validate: (capability, params) => validateParameters(config, capability, params),
      async run(task, payload) {
        if (config.protocol === 'json-http') {
          const prompt = kind === 'text' ? textPrompt(payload) : payload.parameters.prompt;
          return runMapped(config, payload, prompt, call);
        }
        if (utilityCapabilities[kind]) return runUtility(config, payload, call);
        if (payload.assets.some(asset => !['image/png', 'image/jpeg'].includes(asset.mediaType))) throw invalid('Expected a PNG or JPEG image');
        if (kind === 'image') return generateImage(config, payload, call);
        if (kind === 'video') return startVideo(config, payload, call);
        return generateText(config, payload, call);
      },
    };
    if (config.protocol === 'json-http' && entry.mapping.poll) adapter.poll = id => pollMapped(config, id, call);
    else if (config.protocol !== 'json-http' && kind === 'video') adapter.poll = id => pollVideo(config, id, call);
    providers.set('model:' + config.id, adapter);
  }
  return providers;
}

export function registerModels(app, providers) {
  httpRoute(app, 'GET', '/v1/models', {
    tags: ['Models'], summary: 'List configured upstream model aliases for task submission',
    querystring: object({ capabilityId: { type: 'string', enum: [...catalog.keys()] } }, []),
  }, async request => ({
    items: [...providers.values()].map(provider => provider.info).filter(info => info && (!request.query.capabilityId || info.capabilities.includes(request.query.capabilityId))),
  }));
}
