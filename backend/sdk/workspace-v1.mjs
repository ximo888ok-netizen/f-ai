// The trusted host supplies a workspace-bound transport that attaches member credentials.
// Each call resolves to the API response body or rejects with the API error.
function id(value) {
  if (typeof value!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new TypeError('Invalid resource ID');
  return value;
}
function page({limit=30,offset=0}={}) {
  if (!Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(offset) || offset<0 || offset>1000000) throw new RangeError('Invalid page');
  return new URLSearchParams({limit,offset});
}

export class WorkspaceHttpError extends Error {
  constructor(statusCode, code, message, requestId) {
    super(message);
    this.name = 'WorkspaceHttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.requestId = requestId;
  }
}

// Configure and keep this request function in the trusted host.
export function createWorkspaceHttpRequest({ origin, workspaceId, getToken }) {
  const base = new URL(origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && loopback)) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new TypeError('Expected a workspace API origin using HTTPS or loopback HTTP');
  }
  const apiOrigin = base.origin;
  const workspace = id(workspaceId);
  if (typeof getToken !== 'function') throw new TypeError('Expected a session token getter');
  const fetchFromHost = globalThis.fetch.bind(globalThis);

  return async (method, path, payload) => {
    if (typeof path !== 'string' || !path.startsWith('/v1/') || path.includes('\\')) {
      throw new TypeError('Expected a relative workspace API path');
    }
    const url = new URL(path, apiOrigin);
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/v1/') || url.hash) {
      throw new TypeError('Expected a relative workspace API path');
    }

    let token;
    try {
      token = await getToken();
    } catch {
      throw new WorkspaceHttpError(401, 'UNAUTHENTICATED', 'A valid session is required');
    }
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
      throw new WorkspaceHttpError(401, 'UNAUTHENTICATED', 'A valid session is required');
    }

    const headers = { authorization: 'Bearer ' + token, 'x-workspace-id': workspace };
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchFromHost(url, {
        method, headers, body, redirect: 'error', credentials: 'omit',
        cache: 'no-store', referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new WorkspaceHttpError(undefined, 'TRANSPORT_ERROR', 'Workspace API request failed');
    }

    const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    const json = mediaType === 'application/json' || mediaType.endsWith('+json');
    if (!response.ok) {
      const detail = json ? (await response.json().catch(() => undefined))?.error : undefined;
      if (!json) await response.body?.cancel().catch(() => {});
      throw new WorkspaceHttpError(response.status,
        typeof detail?.code === 'string' ? detail.code : 'HTTP_ERROR',
        typeof detail?.message === 'string' ? detail.message : 'Workspace API returned an error',
        typeof detail?.requestId === 'string' ? detail.requestId : undefined);
    }
    if (response.status === 204 || response.status === 205) return undefined;

    try {
      if (json) return await response.json();
      if (/^(image|audio|video)\//.test(mediaType) ||
          ['application/octet-stream', 'application/vnd.adobe.photoshop'].includes(mediaType)) {
        return new Uint8Array(await response.arrayBuffer());
      }
      await response.body?.cancel();
    } catch {
      // Report a decoding or interrupted response without exposing the underlying request.
    }
    throw new WorkspaceHttpError(response.status, 'INVALID_RESPONSE', 'Workspace API returned an invalid response');
  };
}

export function workspaceV1(request) {
  const taskPath=value=>'/v1/tasks/'+id(value);
  return Object.freeze({
    version:1,
    plugins:()=>request('GET','/v1/plugins'),
    submit:input=>request('POST','/v1/tasks',input),
    task:id=>request('GET',taskPath(id)),
    events:(id,options)=>request('GET',taskPath(id)+'/events?'+page(options)),
    assets:options=>request('GET','/v1/assets?'+page(options)),
    asset:value=>request('GET','/v1/assets/'+id(value)),
    assetContent:value=>request('GET','/v1/assets/'+id(value)+'/content'),
    uploadAsset:input=>request('POST','/v1/assets',input),
    notifications:options=>request('GET','/v1/notifications?'+page(options)),
    readNotification:value=>{
      if (typeof value!=='string' || !/^[1-9][0-9]{0,17}$/.test(value)) throw new TypeError('Invalid notification ID');
      return request('POST','/v1/notifications/'+value+'/read');
    },
    cancel:id=>request('POST',taskPath(id)+'/cancel'),
    regenerate:(id,input)=>request('POST',taskPath(id)+'/regenerate',input),
  });
}

const scopes = Object.freeze({
  'plugins.read':['plugins'], 'tasks.read':['task','events'], 'tasks.write':['submit','cancel','regenerate'],
  'assets.read':['assets','asset','assetContent'], 'assets.write':['uploadAsset'],
  'notifications.read':['notifications'], 'notifications.write':['readNotification'],
});

// The trusted host owns transport, grants and lifecycle. Give plugin code only the returned facade.
export function bindPluginV1(request, manifest, isGranted) {
  if (manifest?.sdkVersion!==1 || !Array.isArray(manifest.permissions) || typeof isGranted!=='function') throw new TypeError('Unsupported plugin manifest');
  const api=workspaceV1(request);
  const facade={version:1};
  for (const scope of manifest.permissions) {
    if (!Object.hasOwn(scopes,scope)) throw new TypeError('Unknown plugin permission');
    for (const method of scopes[scope]) facade[method]=(...args)=>{
      if (isGranted(scope)!==true) throw new Error('PLUGIN_PERMISSION_DENIED');
      return api[method](...args);
    };
  }
  return Object.freeze(facade);
}
