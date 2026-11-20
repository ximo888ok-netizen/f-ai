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
  return instructions[payload.capabilityId] + '遵循输入中的平台、语言、文案类型和修订要求。仅使用给定商品事实。\n' + JSON.stringify(payload.parameters);
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
      data = await call('chat/completions', { model, messages });
      if (data?.choices?.[0]?.finish_reason === 'content_filter') throw new ProviderError('MODEL_CONTENT_BLOCKED');
      if (data?.choices?.[0]?.finish_reason === 'length') throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
      text = data?.choices?.[0]?.message?.content;
      break;
    case 'responses':
      data = await call('responses', { model, input: messages, store: false });
      if (data?.status !== 'completed') throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
      text = data.output?.filter(item => item.type === 'message' && item.role === 'assistant')
        .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
      break;
    case 'anthropic-messages':
      data = await call('messages', { model, max_tokens: 2048, messages: turns, system });
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
