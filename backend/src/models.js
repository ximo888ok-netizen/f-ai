import { modelProviders } from './merchant-connections.js';
import { featureAllowed, memberFeatureSettings } from './merchant-features.js';
import { createHash } from 'node:crypto';
import { catalog, modelAlias } from './catalog.js';
import { invalid, object, route as httpRoute, text } from './http.js';
import { modelBaseUrl, requestProviderStream, requestUpstream } from './model-http.js';
import { supportsTextStream, streamText } from './model-stream.js';
import { generateImage, supportsImageQuality } from './model-image.js';
import { pollMapped, runMapped, validateMappedMedia, validateMapping } from './model-mapping.js';
import { generateText, textCapabilities, textPrompt, textRequest } from './model-text.js';
import { utilityCapabilities, runUtility } from './model-utilities.js';
import { pollVideo, startVideo, videoInputLimits } from './model-video.js';
import { configuredVideoOptions, validateVideoOptions, videoInputModes } from './video-options.js';

const protocols = {
  'openai-embeddings': 'embedding', 'cohere-rerank': 'rerank', 'openai-transcription': 'transcription', 'openai-speech': 'speech',
  'chat-completions': 'text', responses: 'text', 'anthropic-messages': 'text', 'gemini-content': 'text',
  'cohere-chat': 'text', 'ollama-chat': 'text', 'openai-images': 'image', 'gemini-image': 'image',
  'qwen-image': 'image', 'seedream-image': 'image', 'minimax-h3-image': 'image',
  'wan3-video': 'video', 'minimax-h3-video': 'video', 'kling-video': 'video',
  'runway-video': 'video', 'ark-video': 'video', 'wan-video': 'video', 'wan-frames':'video', 'minimax-video': 'video',
};
const idPattern=modelAlias.pattern;
export const modelIdSchema=modelAlias;

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
  const videoMode = capability.id === 'video.compose' && params.assetIds?.length ? 'frame' : videoInputModes[capability.id];
  if (videoMode) validateVideoOptions(config.videoOptions?.[videoMode], params);
  if (config.protocol === 'json-http') return validateMappedMedia(config.mapping, params);
  if (!params.prompt?.trim()) throw invalid('This model requires a prompt');
  const count = params.assetIds?.length ?? 0;
  const limits = videoInputLimits(config);
  if (limits && params.options?.durationSeconds < limits.minSeconds) throw invalid('该模型视频至少需要 ' + limits.minSeconds + ' 秒');
  if (limits?.frameRatioFromImage && count && params.ratio) throw invalid('首帧生视频的画幅由输入图片决定');
  if (config.protocol === 'qwen-image' && (count > 3 || params.format === 'jpg')) throw invalid('千问图像 3.0 最多接收三张参考图，输出格式为 PNG');
  if(config.protocol==='ark-video' && capability.id==='video.skill-seedance-film'){
    if(count>(params.frameMode==='references'?9:2))throw invalid('首尾帧最多两张，多图参考最多九张。');
    return;
  }
  if(config.protocol==='wan-frames'){
    if(count!==2 || params.ratio || params.prompt.length>800)throw invalid('万相首尾帧需要两张有序图片，画幅沿用首帧，描述最多 800 字。');
    return;
  }
  if (config.protocol === 'wan-video' && count) throw invalid('This model route only accepts text input');
  if (config.kind === 'video' && count > 1) throw invalid('This model route accepts at most one first-frame image');
  if (capability.id === 'video.from-image' && count !== 1) throw invalid('Select one first-frame image');
  if (params.templateId) throw invalid('Template execution requires a workflow provider');
  const supportedOptions = config.kind === 'video' ? ['durationSeconds', 'resolution', 'generateAudio'] : [];
  if (Object.keys(params.options ?? {}).some(key => !supportedOptions.includes(key))) throw invalid('Unsupported model option');
  if (params.format && !(config.kind === 'image' ? ['png', 'jpg'] : ['mp4']).includes(params.format)) throw invalid('Unsupported model output format');
  if (config.protocol === 'openai-images' && params.ratio && params.ratio !== '1:1') throw invalid('This route supports explicit square images only');
  if (config.protocol === 'runway-video') {
    const ratios = count ? ['16:9', '9:16', '1:1'] : ['16:9', '9:16'];
    if ((params.ratio && !(config.videoOptions?.[videoMode]?.ratios ?? ratios).includes(params.ratio)) || params.prompt.length > 1000 || params.options?.durationSeconds < 2) throw invalid('Unsupported Runway ratio, duration or prompt length');
  }
  if (config.protocol === 'minimax-video' && params.ratio) throw invalid('This video route does not accept an aspect ratio');
}

function allowed(protocol, kind) {
  if(protocol==='wan-frames')return ['video.skill-wan-generate'];
  if(protocol==='ark-video')return ['video.compose','video.from-image','video.skill-seedance-film'];
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
    const { base, loopback } = modelBaseUrl(entry.baseUrl);
    if (entry.keyEnv !== undefined && (typeof entry.keyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(entry.keyEnv))) throw new Error('Invalid model keyEnv');
    const key = entry.keyEnv && env[entry.keyEnv];
    if (!key && (!loopback || entry.keyEnv)) throw new Error('Missing credentials for model ' + entry.id);
    const supported = allowed(entry.protocol, kind);
    if (entry.protocol === 'json-http' && !entry.capabilities) throw new Error('Specify the supported capabilities for a mapped model');
    const capabilities = entry.capabilities ?? supported;
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(id => !supported.includes(id))) throw new Error('Invalid capabilities for model ' + entry.id);
    const config = { id: entry.id, model: entry.model, protocol: entry.protocol, kind, mapping: entry.mapping, apiKeyHeader: entry.apiKeyHeader };
    const videoOptions = configuredVideoOptions(config, entry.videoOptions, capabilities);
    if (Object.keys(videoOptions).length) config.videoOptions = videoOptions;
    const headers = headersFor(config, key);
    if (entry.streamText!==undefined && typeof entry.streamText!=='boolean') throw new Error('streamText must be a boolean');
    const streaming=entry.streamText===true;
    if (streaming && (!supportsTextStream(config.protocol) || !capabilities.includes('model.chat'))) {
      throw new Error('Text streaming requires a supported streaming protocol with model.chat');
    }
    const videoLimits = videoInputLimits(config);
    const info = { id: config.id, model: config.model, protocol: config.protocol, kind, capabilities: [...new Set(capabilities)],
      ...(videoLimits ? { videoLimits } : {}), ...(config.videoOptions ? { videoOptions } : {}),
      streamText: streaming, imageQuality: supportsImageQuality(config) };
    const signatureConfig = { ...config, videoOptions: entry.videoOptions };
    const signature = createHash('sha256').update(JSON.stringify([base.href,signatureConfig,entry.keyEnv,...(streaming?[true]:[])])).digest('hex');
    const call = (path,body,extra,binary=false,timeout) => requestUpstream(new URL(path,base), {
      body, headers: { ...headers, ...extra }, repeatable: body === undefined,
      maxBytes: binary ? 10 * 1024 * 1024 : ['image', 'embedding'].includes(kind) ? 15 * 1024 * 1024 : 512 * 1024,
      binary,timeout:timeout ?? (body===undefined?30000:90000),
    });
    if (entry.checkModels !== undefined && typeof entry.checkModels !== 'boolean') throw new Error('checkModels must be a boolean');
    if (entry.checkModels && !['chat-completions', 'responses', 'openai-images'].includes(entry.protocol)) {
      throw new Error('checkModels requires a compatible GET /models endpoint');
    }
    const longImageRequest = ['qwen-image', 'seedream-image', 'minimax-h3-image'].includes(config.protocol);
    const adapter = {
      info, signature, loopback, ...(longImageRequest ? { runTimeoutMs: 600000 } : {}),
      supports: capability => capabilities.includes(capability.id),
      validate: (capability, params) => validateParameters(config, capability, params),
      async run(task,payload,{timeout}={}) {
        const request=(path,body,extra,binary)=>call(path,body,extra,binary,timeout ?? adapter.runTimeoutMs);
        if (config.protocol === 'json-http') {
          const prompt = kind === 'text' ? textPrompt(payload) : payload.parameters.prompt;
          return runMapped(config,payload,prompt,request);
        }
        if (utilityCapabilities[kind]) return runUtility(config,payload,request);
        if (payload.assets.some(asset => !['image/png', 'image/jpeg'].includes(asset.mediaType))) throw invalid('Expected a PNG or JPEG image');
        if (kind === 'image') return generateImage(config,payload,request);
        if (kind === 'video') return startVideo(config,payload,request);
        return generateText(config,payload,request);
      },
    };
    if (entry.checkModels) {
      adapter.check = async () => {
        const result = await call('models', undefined, undefined, false, 5000);
        if (!Array.isArray(result?.data) || !result.data.some(item => item?.id === config.model)) {
          throw new Error('Configured model was not listed by the provider');
        }
      };
    }
    if (streaming) adapter.streamText=async (payload,writeChunk)=>{
      const [path,body]=textRequest(config,payload.parameters.messages);
      const content=await requestProviderStream(new URL(path,base),{headers,body:{...body,stream:true}});
      return streamText(config,content,writeChunk);
    };
    if (config.protocol === 'json-http' && entry.mapping.poll) adapter.poll = id => pollMapped(config, id, call);
    else if (config.protocol !== 'json-http' && kind === 'video') adapter.poll = id => pollVideo(config, id, call);
    providers.set('model:' + config.id, adapter);
  }
  return providers;
}

export function registerModels(app, providers, db) {
  httpRoute(app, 'GET', '/v1/models', {
    tags: ['Models'], summary: 'List configured upstream model aliases for task submission',
    querystring: object({ capabilityId: { type: 'string', enum: [...catalog.keys()] } }, []),
  }, async request => {
    const [available, settings] = await Promise.all([
      modelProviders(db, request.context.workspaceId, providers), memberFeatureSettings(db, request.context),
    ]);
    const items = [];
    for (const {info} of available.values()) {
      if (!info) continue;
      const capabilities = info.capabilities.filter(id => {
        const capability = catalog.get(id);
        return capability && featureAllowed(settings.get(capability.pluginId), id);
      });
      if (capabilities.length && (!request.query.capabilityId || capabilities.includes(request.query.capabilityId))) {
        items.push({ ...info, capabilities, imageQuality: info.imageQuality === true });
      }
    }
    return {items};
  });
}
