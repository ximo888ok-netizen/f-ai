import { ProviderError } from './model-http.js';

export const maxTextChunks=4096;
const maximumWireBytes=512*1024;
const maximumTextBytes=64*1024;

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
          yield data.join('\n');
          data=[];
        }
      }
    }
    decoder.decode();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('MODEL_STREAM_INTERRUPTED');
  }
}

export async function streamChat(modelId,stream,writeChunk) {
  let text='';
  let size=0;
  let pending='';
  let lastWrite=0;
  let sequence=0;
  let finished=false;
  let done=false;
  async function flush() {
    if (!pending) return;
    if (++sequence>maxTextChunks) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
    await writeChunk(sequence,pending);
    lastWrite=Date.now();
    pending='';
  }
  for await (const data of dataEvents(stream)) {
    if (data==='[DONE]') {
      done=true;
      break;
    }
    let event;
    try {event=JSON.parse(data);} catch {throw new ProviderError('INVALID_PROVIDER_RESULT');}
    if (event?.error || !Array.isArray(event?.choices)) throw new ProviderError('INVALID_PROVIDER_RESULT');
    const choice=event.choices.find(entry=>entry?.index===0);
    if (!choice) continue;
    const delta=choice.delta?.content;
    if (delta!==undefined && delta!==null && typeof delta!=='string') throw new ProviderError('INVALID_PROVIDER_RESULT');
    if (delta) {
      if (finished || delta.includes('\u0000')) throw new ProviderError('INVALID_PROVIDER_RESULT');
      size+=Buffer.byteLength(delta);
      if (size>maximumTextBytes) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
      text+=delta;
      pending+=delta;
      if (pending.length>=512 || Date.now()-lastWrite>=150) await flush();
    }
    if (choice.finish_reason==='content_filter') throw new ProviderError('MODEL_CONTENT_BLOCKED');
    if (choice.finish_reason==='stop') finished=true;
    else if (choice.finish_reason) throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
  }
  if (!done || !finished) throw new ProviderError('MODEL_RESPONSE_INCOMPLETE');
  if (!text.trim()) throw new ProviderError('INVALID_PROVIDER_RESULT');
  await flush();
  return {type:'text',text,modelId};
}
