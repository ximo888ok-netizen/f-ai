import { diagnosticAlerts } from './diagnostic-alerts.js';
import { alertSettings,notifyProbe } from './ops-notify.js';

const knownAlerts=new Set(diagnosticAlerts);

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

export async function runProbe(env=process.env) {
  const startedAt=Date.now();
  const sample=await probe(env);
  const settings=alertSettings(env);
  if (!settings) return sample;
  try {return {...sample,notification:await notifyProbe(settings,sample,startedAt)};}
  catch {return {...sample,notification:{error:'ALERT_STATE_UNAVAILABLE'}};}
}

if (import.meta.main) {
  try {
    const sample=await runProbe();
    console.log(JSON.stringify(sample));
    process.exitCode=sample.ok && !sample.notification?.pending && !sample.notification?.error ? 0 : 1;
  } catch {
    console.error('Invalid probe settings. Check FAI_PROBE_ORIGIN, the optional workspace/session pair and the alert configuration.');
    process.exitCode=2;
  }
}
