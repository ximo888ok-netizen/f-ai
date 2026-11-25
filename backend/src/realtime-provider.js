import { createHash } from 'node:crypto';
import { isUuid } from './config.js';
import { modelBaseUrl, ProviderError } from './model-http.js';

export const maxSdpBytes = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');

// Accept an audio offer with an optional event data channel. The peer handles ICE and DTLS.
export function isVoiceSdp(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxSdpBytes || /\0|\r(?!\n)/.test(value)) return false;
  const [session, ...media] = value.split(/\r?\n(?=m=)/);
  const audio = media.filter(part => part.startsWith('m=audio '));
  if (!/^v=0\r?\n/.test(session) || audio.length !== 1 || media.length > 2 ||
      !media.every(part => /^(?:m=audio [1-9]\d* (?:UDP|TCP)\/TLS\/RTP\/SAVPF? |m=application \d+ (?:UDP\/DTLS\/SCTP|DTLS\/SCTP) )/i.test(part))) return false;
  const attributes = [...audio[0].split(/\r?\n/), ...session.split(/\r?\n/)];
  const direction = attributes.find(line => /^a=(?:inactive|sendonly|recvonly|sendrecv)$/.test(line));
  return (!direction || direction === 'a=sendrecv') && ['a=fingerprint:','a=ice-ufrag:','a=ice-pwd:'].every(
    prefix => attributes.some(line => line.startsWith(prefix) && line.length > prefix.length));
}

function locationId(location, base) {
  if (!location) return null;
  const calls = new URL('realtime/calls/', base);
  let url;
  try { url = new URL(location, base); } catch { return null; }
  if (url.origin !== calls.origin || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(calls.pathname)) return null;
  const id = url.pathname.slice(calls.pathname.length);
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null;
}

async function answerText(response) {
  const chunks = [];
  let size = 0;
  if (!response.body || !/^application\/sdp(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Expected an SDP answer');
  }
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxSdpBytes) throw new Error('SDP answer is too large');
    chunks.push(chunk);
  }
  const answer = Buffer.concat(chunks).toString('utf8');
  if (!isVoiceSdp(answer)) throw new Error('Invalid SDP answer');
  return answer;
}

export function createRealtimeBindings(env = process.env) {
  const entries = JSON.parse(env.REALTIME_VOICE_BINDINGS_JSON || '[]');
  if (!Array.isArray(entries)) throw new Error('Expected a realtime voice binding array');
  const bindings = new Map();
  for (const entry of entries) {
    if (!isUuid(entry?.workspaceId) || typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 256 ||
        typeof entry.voice !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.voice) ||
        !Number.isInteger(entry.credits) || entry.credits < 1 || entry.credits > 1000000 ||
        !Number.isInteger(entry.durationSeconds) || entry.durationSeconds < 10 || entry.durationSeconds > 3600) {
      throw new Error('Invalid realtime voice binding');
    }
    const workspaceId = entry.workspaceId.toLowerCase();
    if (bindings.has(workspaceId)) throw new Error('Duplicate realtime voice workspace');
    const { base, loopback } = modelBaseUrl(entry.baseUrl ?? 'https://api.openai.com/v1/');
    if (entry.keyEnv !== undefined && (typeof entry.keyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(entry.keyEnv))) {
      throw new Error('Invalid realtime voice key environment variable');
    }
    const key = entry.keyEnv && env[entry.keyEnv];
    if (!key && (!loopback || entry.keyEnv)) throw new Error('Missing realtime voice credential');
    const headers = key ? { authorization:'Bearer ' + key } : {};
    const { model, voice, credits, durationSeconds } = entry;
    bindings.set(workspaceId, {
      model, voice, credits, durationSeconds,
      fingerprint: hash(JSON.stringify([base.href, entry.keyEnv ?? null, workspaceId])),
      async open(offer, accountId) {
        const form = new FormData();
        form.set('sdp', offer);
        form.set('session', JSON.stringify({ type:'realtime', model, audio:{
          input:{turn_detection:{type:'server_vad',create_response:true,interrupt_response:true}},output:{voice},
        } }));
        let response;
        try {
          response = await fetch(new URL('realtime/calls',base), {method:'POST',body:form,redirect:'error',
            headers:{...headers, 'openai-safety-identifier':hash(workspaceId + '/' + accountId)},signal:AbortSignal.timeout(12000)});
        } catch { throw new ProviderError('PROVIDER_OUTCOME_UNKNOWN'); }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderError(response.status >= 500 ? 'PROVIDER_OUTCOME_UNKNOWN' : 'PROVIDER_REJECTED');
        }
        const callId = locationId(response.headers.get('location'),base);
        if (!callId) {
          await response.body?.cancel();
          throw new ProviderError('PROVIDER_OUTCOME_UNKNOWN');
        }
        try { return { callId, answer:await answerText(response) }; }
        catch {
          // A call already exists. Retain its trusted ID for server-side hangup.
          return { callId, error:'INVALID_PROVIDER_RESULT' };
        }
      },
      async hangup(callId) {
        const response = await fetch(new URL('realtime/calls/' + encodeURIComponent(callId) + '/hangup',base), {
          method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        return response.ok || response.status === 404 || response.status === 410;
      },
    });
  }
  return bindings;
}
