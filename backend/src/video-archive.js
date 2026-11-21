import { GeneratedFile } from './model-file.js';
import { requestUpstream } from './model-http.js';

export function createVideoArchive(origins, request = requestUpstream) {
  if (!origins.length) return null;
  const allowed = new Set(origins);
  return async value => {
    let url;
    try { url = new URL(value); } catch { return {status:'not_allowed'}; }
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.has(url.origin)) {
      return {status:'not_allowed'};
    }
    try {
      const bytes = await request(url, {binary:true,maxBytes:10*1024*1024,timeout:12000,repeatable:true});
      return {status:'saved',file:new GeneratedFile(bytes,'video/mp4')};
    } catch {
      return {status:'failed'};
    }
  };
}
