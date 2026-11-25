export class ProviderError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

export function modelBaseUrl(raw) {
  const base = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username || base.password || base.search || base.hash) throw new Error('Invalid model baseUrl');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return { base, loopback };
}

// Polling and idempotent gateways can repeat a transport failure. A native
// creation request with an ambiguous outcome must not be submitted twice.
async function openUpstream(url,{headers,body,repeatable,timeout}) {
  let response;
  try {
    const multipart = body instanceof FormData;
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined || multipart ? headers : { ...headers, 'content-type': 'application/json' },
      body: multipart ? body : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ProviderError(repeatable ? 'PROVIDER_UNREACHABLE' : 'PROVIDER_OUTCOME_UNKNOWN', repeatable);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (!repeatable && response.status >= 500) throw new ProviderError('PROVIDER_OUTCOME_UNKNOWN');
    throw new ProviderError('PROVIDER_REJECTED', response.status === 429 || (repeatable && response.status >= 500));
  }
  return response;
}

export async function requestProviderStream(url,{headers,body,timeout=90000}) {
  const response=await openUpstream(url,{headers:{...headers,accept:'text/event-stream'},body,timeout,repeatable:false});
  if (!response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new ProviderError('INVALID_PROVIDER_RESULT');
  }
  return response.body;
}

export async function requestUpstream(url,{headers,body,repeatable=false,maxBytes=512*1024,timeout=45000,binary=false}) {
  const response=await openUpstream(url,{headers,body,repeatable,timeout});
  try {
    const chunks = [];
    let size = 0;
    for await (const value of response.body) {
      size += value.byteLength;
      if (size > maxBytes) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    if (binary) return Buffer.concat(chunks);
    // Some video services serialize long decimal IDs as numbers.
    return JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value, context) => {
      if ((key === 'task_id' || key === 'file_id') && typeof value === 'number' && !Number.isSafeInteger(value)) return context.source;
      return value;
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('INVALID_PROVIDER_RESULT', repeatable);
  }
}

export function mediaUrl(value) {
  if (typeof value !== 'string') throw new ProviderError('INVALID_PROVIDER_RESULT');
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('INVALID_PROVIDER_RESULT'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ProviderError('INVALID_PROVIDER_RESULT');
  return url.href;
}

export class PendingModelJob {
  constructor(id) {
    const value = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new ProviderError('INVALID_PROVIDER_RESULT');
    this.id = value;
  }
}
