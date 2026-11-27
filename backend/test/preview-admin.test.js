import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('local startup ignores legacy seed credentials and creates no preview owner or opening balance', {timeout:60000}, async t => {
  const child = spawn(process.execPath,[fileURLToPath(new URL('../src/local-studio.js',import.meta.url))], {
    windowsHide:true, stdio:['ignore','pipe','pipe'],
    env:{...process.env,FAI_LOCAL_STUDIO_PORT:'0',FAI_DESKTOP_STATE_DIR:'',
      FAI_PREVIEW_ADMIN_PASSWORD:'unused-password',FAI_PREVIEW_ADMIN_CREDITS:'321',
      MODEL_PROVIDERS_JSON:'[]',MODEL_PROVIDERS_FILE:'',FAI_MEDIA_MODELS:'',FAI_MEDIA_SKILLS_FILE:'',FAI_PLUGIN_INTEGRATIONS_FILE:''},
  });
  const closed = once(child,'exit');
  t.after(async()=>{ if(child.exitCode===null && child.signalCode===null) child.kill(); await closed; });
  let origin;
  for await(const line of createInterface({input:child.stdout})) {
    const match = line.match(/ready at (http:\/\/127\.0\.0\.1:\d+)/);
    if(match){origin=match[1];break;}
  }
  assert.ok(origin,'local server is ready');
  const post=(path,body)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/v1/auth/login',{email:'admin',password:'unused-password'})).status,400);
  assert.equal((await post('/v1/auth/login',{email:'admin@preview.invalid',password:'unused-password'})).status,401);
  const created=await post('/v1/auth/register',{email:'owner@example.test',password:'registered-password',displayName:'Owner',type:'enterprise',workspaceName:'Workspace'});
  assert.equal(created.status,201);
  const session=await created.json();
  const headers={authorization:'Bearer '+session.token,'x-workspace-id':session.workspaces[0].id};
  const wallet=await fetch(origin+'/v1/credits/wallet',{headers});
  assert.equal(wallet.status,200);
  assert.equal((await wallet.json()).available,0);
});
