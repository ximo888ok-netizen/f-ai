import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, opendir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const failureCode = error => ({
  ENOENT:'MISSING', ENOTDIR:'NOT_DIRECTORY', EACCES:'PERMISSION_DENIED', EPERM:'PERMISSION_DENIED',
  EROFS:'READ_ONLY', ENOSPC:'NO_SPACE', EDQUOT:'NO_SPACE',
})[error.code] ?? 'IO_ERROR';

export function deploymentDirectories(env=process.env) {
  const directories=[
    {id:'migrations',path:fileURLToPath(new URL('../migrations/',import.meta.url)),write:false},
    {id:'help',path:fileURLToPath(new URL('./help/',import.meta.url)),write:false},
    {id:'temporary',path:tmpdir(),write:true},
  ];
  if (env.DEDICATED_CREDENTIAL_DIR) directories.push({id:'credentials',path:env.DEDICATED_CREDENTIAL_DIR,write:false});
  if (env.FAI_DESKTOP_STATE_DIR) directories.push({id:'desktop-state',path:env.FAI_DESKTOP_STATE_DIR,write:true});
  return directories;
}

async function inspectDirectory({id,path,write}) {
  const result={id,read:'ok',write:write?'pending':'not-required'};
  if (!isAbsolute(path)) return {...result,read:'INVALID_PATH',write:write?'INVALID_PATH':'not-required'};
  try {
    const directory=await opendir(path);
    try { await directory.read(); } finally { await directory.close(); }
    if (process.platform!=='win32') await access(path,constants.X_OK);
  } catch (error) { result.read=failureCode(error); }
  if (write) {
    const probe=join(path,'.fai-probe-'+randomUUID());
    let file;
    try {
      file=await open(probe,'wx+',0o600);
      await file.writeFile('F');
      const buffer=Buffer.alloc(1);
      const {bytesRead}=await file.read(buffer,0,1,0);
      result.write=bytesRead===1 && buffer[0]===70?'ok':'IO_ERROR';
    } catch (error) { result.write=failureCode(error); }
    finally {
      if (file) {
        try { await file.close(); } catch (error) { result.write=failureCode(error); }
        try { await unlink(probe); } catch { result.write='CLEANUP_FAILED'; }
      }
    }
  }
  return result;
}

export async function checkDirectories(directories=deploymentDirectories()) {
  return Promise.all(directories.map(inspectDirectory));
}

if (import.meta.main) {
  const checks=await checkDirectories();
  console.log(JSON.stringify(checks));
  process.exitCode=checks.every(item=>item.read==='ok' && ['ok','not-required'].includes(item.write))?0:1;
}
