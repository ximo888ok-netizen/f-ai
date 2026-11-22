// The trusted host supplies a workspace-bound transport that attaches member credentials.
// Each call resolves to the API response body or rejects with the API error.
export function workspaceV1(request) {
  const taskPath=id=>{
    if (typeof id!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new TypeError('Invalid task ID');
    return '/v1/tasks/'+id;
  };
  return Object.freeze({
    version:1,
    plugins:()=>request('GET','/v1/plugins'),
    submit:input=>request('POST','/v1/tasks',input),
    task:id=>request('GET',taskPath(id)),
    events:(id,{limit=30,offset=0}={})=>{
      if (!Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(offset) || offset<0 || offset>1000000) {
        throw new RangeError('Invalid event page');
      }
      return request('GET',taskPath(id)+'/events?'+new URLSearchParams({limit,offset}));
    },
    cancel:id=>request('POST',taskPath(id)+'/cancel'),
    regenerate:(id,input)=>request('POST',taskPath(id)+'/regenerate',input),
  });
}
