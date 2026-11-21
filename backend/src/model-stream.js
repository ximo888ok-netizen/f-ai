import { ProviderError } from './model-http.js';
import { responsesText } from './model-text.js';

export const maxTextChunks=4096;
const maximumWireBytes=512*1024;
const maximumTextBytes=64*1024;
const doneMarker = Symbol('done');
const incomplete = () => new ProviderError('MODEL_RESPONSE_INCOMPLETE');
const invalidEvent = () => new ProviderError('INVALID_PROVIDER_RESULT');

async function* dataEvents(stream) {
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let buffer='';
  let data=[];
  let size=0;
  try {
    for await (const bytes of stream) {
      size+=bytes.byteLength;
      if (size>maximumWireBytes) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
      buffer+=decoder.decode(bytes,{stream:true});
      let newline;
      while ((newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline).replace(/\r$/,'');
        buffer=buffer.slice(newline+1);
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
        if (!line && data.length) {
          const record = data.join('\n');
          data=[];
          if (record === '[DONE]') yield doneMarker;
          else {
            let event;
            try { event = JSON.parse(record); } catch { throw invalidEvent(); }
            if (!event || typeof event !== 'object' || Array.isArray(event)) throw invalidEvent();
            yield event;
          }
        }
      }
    }
    decoder.decode();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('MODEL_STREAM_INTERRUPTED');
  }
}

async function* chatCompletions(events) {
  let finished = false;
  for await (const event of events) {
    if (event === doneMarker) {
      if (!finished) throw incomplete();
      return;
    }
    if (event.error || !Array.isArray(event.choices)) throw invalidEvent();
    const choice = event.choices.find(entry => entry?.index === 0);
    if (!choice) continue;
    const delta = choice.delta?.content;
    if (delta != null && typeof delta !== 'string') throw invalidEvent();
    if (delta) {
      if (finished) throw invalidEvent();
      yield delta;
    }
    if (choice.finish_reason === 'content_filter') throw new ProviderError('MODEL_CONTENT_BLOCKED');
    if (choice.finish_reason === 'stop') finished = true;
    else if (choice.finish_reason) throw incomplete();
  }
  throw incomplete();
}

function textDelta(value) {
  if (typeof value !== 'string') throw invalidEvent();
  return value;
}

function index(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidEvent();
  return value;
}

async function* openAIResponses(events) {
  let output = -1;
  let part = -1;
  for await (const event of events) {
    if (event === doneMarker) break;
    switch (event.type) {
      case 'response.refusal.delta':
      case 'response.refusal.done':
        throw new ProviderError('MODEL_CONTENT_BLOCKED');
      case 'error':
      case 'response.failed':
      case 'response.incomplete':
        if (event.response?.incomplete_details?.reason === 'content_filter') throw new ProviderError('MODEL_CONTENT_BLOCKED');
        throw incomplete();
      case 'response.output_text.delta': {
        const nextOutput = index(event.output_index);
        const nextPart = index(event.content_index);
        const delta = textDelta(event.delta);
        const newPart = nextOutput !== output || nextPart !== part;
        // The workbench appends text in order, so a provider may not reopen an earlier part.
        if (nextOutput < output || (nextOutput === output && nextPart < part)) throw invalidEvent();
        yield (newPart && output >= 0 ? '\n' : '') + delta;
        output = nextOutput;
        part = nextPart;
        break;
      }
      case 'response.completed':
        yield { finalText: responsesText(event.response) };
        return;
    }
  }
  throw incomplete();
}

async function* anthropicMessages(events) {
  let started = false;
  let block = null;
  let nextIndex = 0;
  let visibleBlocks = 0;
  let stopReason;
  for await (const event of events) {
    if (event === doneMarker) break;
    switch (event.type) {
      case 'message_start':
        if (started || event.message?.role !== 'assistant') throw invalidEvent();
        started = true;
        break;
      case 'content_block_start': {
        const type = event.content_block?.type;
        if (!started || stopReason || block || index(event.index) !== nextIndex || typeof type !== 'string') throw invalidEvent();
        block = { index: nextIndex++, type };
        if (type === 'text') yield (visibleBlocks++ ? '\n' : '') + textDelta(event.content_block.text);
        break;
      }
      case 'content_block_delta':
        if (!block || block.index !== event.index) throw invalidEvent();
        if (block.type === 'text' && event.delta?.type === 'text_delta') yield textDelta(event.delta.text);
        break;
      case 'content_block_stop':
        if (!block || block.index !== event.index) throw invalidEvent();
        block = null;
        break;
      case 'message_delta':
        if (!started || block) throw invalidEvent();
        stopReason = event.delta?.stop_reason ?? stopReason;
        break;
      case 'error':
        throw new ProviderError('MODEL_STREAM_INTERRUPTED');
      case 'message_stop':
        if (stopReason === 'refusal') throw new ProviderError('MODEL_CONTENT_BLOCKED');
        if (!started || block || !['end_turn', 'stop_sequence'].includes(stopReason)) throw incomplete();
        return;
    }
  }
  throw incomplete();
}

const readers = new Map([
  ['chat-completions', chatCompletions],
  ['responses', openAIResponses],
  ['anthropic-messages', anthropicMessages],
]);

export const supportsTextStream = protocol => readers.has(protocol);

export async function streamText({ id: modelId, protocol }, stream, writeChunk) {
  let text = '';
  let size = 0;
  let pending = '';
  let lastWrite = 0;
  let sequence = 0;
  async function flush() {
    if (!pending) return;
    if (++sequence > maxTextChunks) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
    await writeChunk(sequence, pending);
    lastWrite = Date.now();
    pending = '';
  }
  const read = readers.get(protocol);
  for await (const delta of read(dataEvents(stream))) {
    if (typeof delta !== 'string') {
      if (delta.finalText !== text) throw incomplete();
      continue;
    }
    if (!delta) continue;
    if (delta.includes('\u0000')) throw invalidEvent();
    size += Buffer.byteLength(delta);
    if (size > maximumTextBytes) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
    text += delta;
    pending += delta;
    if (pending.length >= 512 || Date.now() - lastWrite >= 150) await flush();
  }
  if (!text.trim()) throw invalidEvent();
  await flush();
  return { type: 'text', text, modelId };
}
