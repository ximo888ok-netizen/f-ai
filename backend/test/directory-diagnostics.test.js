import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkDirectories } from '../src/directory-diagnostics.js';

test('directory checks use the service identity, leave no probes and redact paths',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fai-private-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'keep'),'untouched');
  const inspect=async path=>(await checkDirectories([{id:'test',path,write:true}]))[0];
  assert.deepEqual(await inspect(dir),{id:'test',read:'ok',write:'ok'});
  assert.deepEqual(await readdir(dir),['keep']);
  assert.deepEqual(await inspect(join(dir,'missing')),{id:'test',read:'MISSING',write:'MISSING'});
  assert.equal((await inspect(join(dir,'keep'))).read,'NOT_DIRECTORY');
  assert.equal((await inspect('relative-path')).write,'INVALID_PATH');
  if (process.platform!=='win32' && process.getuid()!==0) {
    const locked=join(dir,'read-only');
    await mkdir(locked,{mode:0o555});
    try {
      assert.deepEqual(await inspect(locked),{id:'test',read:'ok',write:'PERMISSION_DENIED'});
      assert.deepEqual(await readdir(locked),[]);
    } finally { await chmod(locked,0o700); }
  }
});
