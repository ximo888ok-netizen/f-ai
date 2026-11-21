import { ApiError, array, bool, integer, invalid, object, route, text } from './http.js';
import { ProviderError, requestUpstream } from './model-http.js';

const root = '/v1/search/web';
const tags = ['Web search'];
const result = object({ title:text(240), url:text(2048), excerpt:text(600,0) });

function resultUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

function clipped(value, limit) {
  return typeof value === 'string' ? Array.from(value.trim()).slice(0,limit).join('') : '';
}

export function createExaSearch(apiKey, request = requestUpstream) {
  if (!apiKey?.trim()) return null;
  return async (query, limit) => {
    const data = await request(new URL('https://api.exa.ai/search'), {
      headers: { 'x-api-key':apiKey.trim() },
      body: { query, numResults:limit, type:'auto', contents:{ highlights:true } },
      timeout:12000, maxBytes:256*1024, repeatable:true,
    });
    if (!Array.isArray(data?.results)) throw new ProviderError('INVALID_PROVIDER_RESULT');
    const seen = new Set();
    const items = [];
    for (const row of data.results) {
      const url = resultUrl(row?.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const excerpt = Array.isArray(row.highlights) ? clipped(row.highlights.filter(x=>typeof x==='string').join(' '),600) : '';
      items.push({title:clipped(row.title,240) || new URL(url).hostname,url,excerpt});
      if (items.length === limit) break;
    }
    return items;
  };
}

export function registerWebSearch(app, search) {
  route(app, 'GET', root, { tags, summary:'Check if web search is configured',
    response:{200:object({available:bool})} }, async () => ({ available:Boolean(search) }));
  route(app, 'POST', root, { tags, summary:'Search the public web from an explicit query',
    config: { rateLimit: { max:20, timeWindow:60000 } },
    body:object({query:text(400),limit:integer(1,10)},['query']),
    response:{200:object({items:array(result,10)})} }, async request => {
    const query = request.body.query.trim();
    if (!query) throw invalid('Enter a search query');
    if (!search) throw new ApiError(503,'SEARCH_NOT_CONFIGURED','Web search has no configured provider');
    try {
      return {items:await search(query,request.body.limit ?? 5)};
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      throw new ApiError(error.retryable ? 503 : 502,'SEARCH_PROVIDER_ERROR','The search provider could not complete this request');
    }
  });
}
