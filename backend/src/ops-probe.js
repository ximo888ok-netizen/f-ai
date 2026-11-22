const knownAlerts=new Set(['QUEUE_DELAY','LEASE_EXPIRED','PROVIDER_POLL_DELAY','SCHEDULE_DELAY','TASK_FAILURE_RATE']);

export async function probe(env=process.env) {
  const url=new URL(env.FAI_PROBE_ORIGIN);
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.origin!==env.FAI_PROBE_ORIGIN || !(url.protocol==='https:' || (local && url.protocol==='http:'))) {
    throw new Error('Supply an HTTPS origin or an HTTP loopback origin');
  }
  const workspace=env.FAI_PROBE_WORKSPACE_ID;
  const token=env.FAI_PROBE_SESSION;
  if (Boolean(workspace)!==Boolean(token)) throw new Error('Supply the workspace and session together');
  const issues=[];
  async function get(path,headers) {
    try {
      const response=await fetch(new URL(path,url),{headers,redirect:'error',signal:AbortSignal.timeout(5000)});
      if (!response.ok) {await response.body?.cancel();return null;}
      return await response.json();
    } catch {return null;}
  }
  const [health,ready,diagnostic]=await Promise.all([
    get('/health'),get('/ready'),workspace && get('/v1/diagnostics/alerts',{'x-workspace-id':workspace,authorization:'Bearer '+token}),
  ]);
  if (health?.status!=='ok') issues.push('PROCESS_UNAVAILABLE');
  if (ready?.status!=='ready') issues.push('DATABASE_NOT_READY');
  if (workspace) {
    if (!Array.isArray(diagnostic?.alerts) || !diagnostic.alerts.every(code=>knownAlerts.has(code))) issues.push('WORKSPACE_PROBE_FAILED');
    else issues.push(...diagnostic.alerts);
  }
  return {observedAt:new Date().toISOString(),scope:workspace?'workspace':'service',ok:issues.length===0,issues};
}

if (import.meta.main) {
  try {
    const sample=await probe();
    console.log(JSON.stringify(sample));
    process.exitCode=sample.ok?0:1;
  } catch {
    console.error('Invalid probe settings. Check FAI_PROBE_ORIGIN and the optional workspace/session pair.');
    process.exitCode=2;
  }
}
