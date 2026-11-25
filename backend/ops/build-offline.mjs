import { spawnSync } from 'node:child_process';
import { copyFile,cp,mkdir,mkdtemp,readdir,rename,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,dirname,isAbsolute,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioPublicFiles } from '../src/studio.js';
import {
  OFFLINE_FORMAT, OFFLINE_PLATFORM, OFFLINE_TOOLS, RUNTIME_LICENSES, nativeFileInventory, sha256File,
} from '../src/verify-offline-release.js';

// Assemble from a Git revision, a lockfile install and distribution directories only.
const repo=fileURLToPath(new URL('../../',import.meta.url));
const env=process.env;
const output=process.argv[2];
const pgArchive=env.FAI_PG_DIST_ARCHIVE,ffmpeg=env.VIDEO_FFMPEG_PATH;
const nodeDir=env.FAI_NODE_DIST;
if (process.platform!=='win32' || process.arch!=='x64' ||
    ![output,pgArchive,ffmpeg,nodeDir,env.FAI_QA_NPM_CACHE,env.npm_execpath].every(p=>p && isAbsolute(p))) {
  throw new Error('Use npm on Windows x64 with the distribution paths described in DEPLOYMENT.md');
}
const run=(file,args,cwd=repo,childEnv=env)=>{
  const result=spawnSync(file,args,{cwd,env:childEnv,encoding:'utf8',timeout:600000,windowsHide:true});
  if (result.status!==0) throw new Error(basename(file)+' failed: '+(result.stderr || '').slice(-600));
  return result.stdout.trim();
};
const temp=await mkdtemp(join(tmpdir(),'fai-offline-'));
try {
  const root=join(temp,'payload'),runtime=join(root,'runtime'),backend=join(root,'backend');
  await mkdir(runtime,{recursive:true});
  const revision=run('git',['rev-parse','HEAD']);
  const web='前端设计审查';
  const gitDir=run('git',['rev-parse','--absolute-git-dir']);
  run('git',['--git-dir='+gitDir,'--work-tree='+root,'-c','core.autocrlf=false','restore','--source='+revision,'--worktree','--',
    'backend/src','backend/sdk','backend/migrations','backend/package.json',
    'backend/package-lock.json','backend/.env.example','backend/DEPLOYMENT.md','backend/README.md','backend/ACCEPTANCE.md',
    ...studioPublicFiles.map(file => web + '/' + file)],
    repo,{...env,GIT_INDEX_FILE:join(temp,'release.index')});
  // Keep the portable archive paths independent of the target Windows system code page.
  const publicDir=join(backend,'public');
  await rename(join(root,web),publicDir);
  await rename(join(publicDir,'商家管理后台.html'),join(publicDir,'merchant.html'));
  const node=join(runtime,'node.exe');
  await copyFile(join(nodeDir,'node.exe'),node);
  await copyFile(join(nodeDir,'LICENSE'),join(runtime,'NODE-LICENSE'));
  run(node,[env.npm_execpath,'ci','--offline','--omit=dev','--no-audit','--no-fund','--cache',env.FAI_QA_NPM_CACHE],backend);
  const pg=join(runtime,'postgres'),media=join(runtime,'media');
  await mkdir(join(pg,'bin'),{recursive:true});await mkdir(media);
  run('tar',['-xf',pgArchive,'-C',temp,'pgsql/bin','pgsql/lib','pgsql/share','pgsql/server_license.txt','pgsql/commandlinetools_3rd_party_licenses.txt']);
  for (const part of ['lib','share','server_license.txt','commandlinetools_3rd_party_licenses.txt']) await cp(join(temp,'pgsql',part),join(pg,part),{recursive:true});
  async function copyTools(from,to,executables) {
    for (const name of await readdir(from)) {
      if (/\.dll$/i.test(name) || executables.includes(name)) await copyFile(join(from,name),join(to,name));
    }
  }
  await copyTools(join(temp,'pgsql','bin'),join(pg,'bin'),['postgres.exe','initdb.exe','pg_ctl.exe','psql.exe','pg_dump.exe','pg_restore.exe']);
  await copyTools(dirname(ffmpeg),media,['ffmpeg.exe','ffprobe.exe']);
  await copyFile(join(dirname(dirname(ffmpeg)),'LICENSE.txt'),join(media,'LICENSE.txt'));
  const dependencies=JSON.parse(run(node,['src/package-inventory.js'],backend));
  const tools=[];
  for (const [name,path,args,distribution] of OFFLINE_TOOLS) {
    const file=join(runtime,path);
    const source=path.startsWith('media/') ? env.FAI_FFMPEG_SOURCE || distribution : distribution;
    tools.push({name,path,source,version:run(file,args).split(/\r?\n/)[0],sha256:await sha256File(file)});
  }
  const licenses=await Promise.all(RUNTIME_LICENSES.map(async ([path,source])=>({path,source,sha256:await sha256File(join(root,path))})));
  const nativeFiles=await nativeFileInventory(root);
  const manifest={format:OFFLINE_FORMAT,platform:OFFLINE_PLATFORM,revision,dependencies,tools,licenses,nativeFiles};
  const manifestFile=join(root,'release.json');
  await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  await writeFile(join(backend,'release-revision.txt'),revision+'\n');
  const manifestSha256=await sha256File(manifestFile);
  run(node,['src/verify-offline-release.js',root,revision,manifestSha256],backend);
  await mkdir(resolve(output)); // Require a new delivery directory.
  const archive=join(output,'f-ai-backend-win-x64.tar.gz');
  run('tar',['-czf',archive,'-C',root,'.']);
  const sha256=await sha256File(archive);
  await writeFile(archive+'.sha256',sha256+'  '+basename(archive)+'\n',{flag:'wx'});
  await writeFile(join(output,'release.json.sha256'),manifestSha256+'  release.json\n',{flag:'wx'});
  console.log(JSON.stringify({revision,archive,sha256,manifestSha256}));
} finally {await rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:250});}
