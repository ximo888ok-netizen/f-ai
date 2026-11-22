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
