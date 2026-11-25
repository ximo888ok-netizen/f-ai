import { createHash } from 'node:crypto';
import { isUuid } from './config.js';
import { ApiError } from './http.js';

const limit = 10*1024*1024;
const failure = () => new ApiError(502,'WEBDAV_REQUEST_FAILED','The configured file store did not complete the request');
const malformed = () => new ApiError(409,'CLOUD_COPY_MISMATCH','The remote bytes do not match the saved checksum');

export function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function newStore(base, authorization, request) {
  const baseUrl = new URL(base);
  baseUrl.pathname = baseUrl.pathname.replace(/\/*$/, '/');
  const fingerprint = checksum(baseUrl.href);
  async function exchange(key,method,options={}) {
    // Names are generated from internal UUIDs. The client cannot supply a path or origin.
    if (!/^fai-[a-f0-9-]{110}$/.test(key)) throw failure();
    try {
      return await request(new URL(key,baseUrl),{method,redirect:'error',signal:AbortSignal.timeout(15000),
        ...options,headers:{authorization,...options.headers}});
    } catch {
      throw failure();
    }
  }
  async function read(key,size,digest) {
    const response = await exchange(key,'GET');
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status===404) throw new ApiError(404,'CLOUD_COPY_MISSING','The configured file store cannot find this copy');
      throw failure();
    }
    const chunks=[];
    let length=0;
    try {
      for await (const chunk of response.body) {
        length+=chunk.byteLength;
        if (length>size || length>limit) throw malformed();
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw failure();
    }
    const bytes=Buffer.concat(chunks);
    if (bytes.length!==size || checksum(bytes)!==digest) throw malformed();
    return bytes;
  }
  async function write(key,bytes,mime,digest) {
    const response = await exchange(key,'PUT',{headers:{'if-none-match':'*','content-type':mime},body:bytes});
    await response.body?.cancel();
    if (!response.ok && response.status!==412) throw failure();
    await read(key,bytes.length,digest);
  }
  return { fingerprint, read, write };
}

export function createWebdavBindings(env=process.env,request=fetch) {
  const config=JSON.parse(env.WEBDAV_BINDINGS_JSON || '[]');
  if (!Array.isArray(config)) throw new Error('WEBDAV_BINDINGS_JSON must contain an array');
  const bindings=new Map();
  for (const binding of config) {
    const id=binding?.workspaceId?.toLowerCase?.();
    const name=binding?.authorizationEnv;
    if (!isUuid(id) || bindings.has(id) || typeof name!=='string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
      throw new Error('Invalid WebDAV workspace or authorization setting');
    }
    let base;
    try { base=new URL(binding.baseUrl); } catch { throw new Error('Invalid WebDAV collection URL'); }
    const authorization=env[name];
    if (base.protocol!=='https:' || base.username || base.password || base.search || base.hash ||
        typeof authorization!=='string' || !/^(Basic|Bearer) [A-Za-z0-9._~+\/=-]+$/.test(authorization)) {
      throw new Error('WebDAV requires an HTTPS collection and a valid authorization secret');
    }
    bindings.set(id,newStore(base.href,authorization,request));
  }
  return bindings;
}
