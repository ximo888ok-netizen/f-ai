import { ProviderError } from './model-http.js';

const instructions = {
  'copywriting.generate': '为商品编写电商文案。',
  'copywriting.platform-adaptation': '根据指定平台改写商品文案。',
  'copywriting.translate': '用目标语言改写商品文案，保留商品属性。',
  'copywriting.selling-points': '根据提供的商品事实提炼卖点和对比话术。',
};

export const textCapabilities = Object.keys(instructions);

export function textPrompt(payload) {
  if (payload.capabilityId === 'model.chat') return JSON.stringify(payload.parameters.messages);
  const {templateVersion=1,...parameters}=payload.parameters;
  const introduction=instructions[payload.capabilityId];
  if (templateVersion===1) return introduction+'遵循输入中的平台、语言、文案类型和修订要求。仅使用给定商品事实。\n'+JSON.stringify(parameters);
  if (templateVersion!==2) throw new ProviderError('COPY_TEMPLATE_UNAVAILABLE');
  const comparison=payload.capabilityId==='copywriting.selling-points'
    ? '提炼三条商品卖点。有竞品事实时，根据双方已给事实写一段对比话术，缺少依据时说明所缺信息。' : '';
  return introduction+comparison+'language 指定输出语言，inputLanguage 指定原文语言。遵循平台、所选文案栏目和修订要求，保留给定商品属性。\n'+JSON.stringify(parameters);
}

export function textRequest({ protocol, model }, messages) {
  switch (protocol) {
    case 'chat-completions': return ['chat/completions', { model, messages }];
    case 'responses': return ['responses', { model, input: messages, store: false }];
    case 'anthropic-messages': {
      const instruction = messages[0].role === 'system' ? messages[0].content : undefined;
      return ['messages', { model, max_tokens: 2048, messages: instruction === undefined ? messages : messages.slice(1), system: instruction }];
    }
    default: throw new ProviderError('CAPABILITY_UNAVAILABLE');
  }
}

export function responsesText(response) {
  if (response?.status !== 'completed') throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
  if (!Array.isArray(response.output)) throw new ProviderError('INVALID_PROVIDER_RESULT');
  const parts = response.output.filter(item => item?.type === 'message' && item.role === 'assistant')
    .flatMap(item => Array.isArray(item.content) ? item.content : []);
  if (parts.some(part => part?.type === 'refusal')) throw new ProviderError('MODEL_CONTENT_BLOCKED');
  const text = parts.filter(part => part?.type === 'output_text').map(part => part.text);
  if (text.some(part => typeof part !== 'string')) throw new ProviderError('INVALID_PROVIDER_RESULT');
  return text.join('\n');
}

export async function generateText(route, payload, call) {
  const { protocol, model } = route;
  const prompt = textPrompt(payload);
  const messages = payload.capabilityId === 'model.chat' ? payload.parameters.messages : [{ role: 'user', content: prompt }];
  const hasSystem = messages[0].role === 'system';
  const system = hasSystem ? messages[0].content : undefined;
  const turns = hasSystem ? messages.slice(1) : messages;
  let text;
  let data;
  switch (protocol) {
    case 'chat-completions':
      data = await call(...textRequest(route, messages));
      if (data?.choices?.[0]?.finish_reason === 'content_filter') throw new ProviderError('MODEL_CONTENT_BLOCKED');
      if (data?.choices?.[0]?.finish_reason === 'length') throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
      text = data?.choices?.[0]?.message?.content;
      break;
    case 'responses':
      text = responsesText(await call(...textRequest(route, messages)));
      break;
    case 'anthropic-messages':
      data = await call(...textRequest(route, messages));
      if (['max_tokens', 'refusal'].includes(data?.stop_reason)) throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
      text = data?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
      break;
    case 'gemini-content':
      data = await call('models/' + encodeURIComponent(model) + ':generateContent', {
        contents: turns.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
        systemInstruction: hasSystem ? { parts: [{ text: system }] } : undefined,
      });
      if (data?.candidates?.[0]?.finishReason && data.candidates[0].finishReason !== 'STOP') throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
      text = data?.candidates?.[0]?.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n');
      break;
    case 'cohere-chat':
      data = await call('chat', { model, messages });
      if (data?.finish_reason && data.finish_reason.toLowerCase() !== 'complete') throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
      text = data?.message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
      break;
    case 'ollama-chat':
      data = await call('chat', { model, messages, stream: false });
      text = data?.message?.content;
      break;
    default:
      throw new ProviderError('CAPABILITY_UNAVAILABLE');
  }
  if (typeof text !== 'string' || !text.trim() || text.includes('\u0000')) throw new ProviderError('INVALID_PROVIDER_RESULT');
  return { type: 'text', text, modelId: route.id };
}
