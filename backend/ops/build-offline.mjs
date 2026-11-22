import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile,cp,mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,dirname,isAbsolute,join,relative,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const run=(file,args,cwd=repo)=>{
  const result=spawnSync(file,args,{cwd,encoding:'utf8',timeout:600000,windowsHide:true});
  if (result.status!==0) throw new Error(basename(file)+' failed: '+(result.stderr || '').slice(-600));
  return result.stdout.trim();
};
const hash=async file=>{
  const digest=createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};
const temp=await mkdtemp(join(tmpdir(),'fai-offline-'));
try {
  const root=join(temp,'payload'),runtime=join(root,'runtime'),backend=join(root,'backend');
  await mkdir(runtime,{recursive:true});
  const revision=run('git',['rev-parse','HEAD']);
  const source=join(temp,'source.tar');
  const web='前端设计审查/';
  run('git',['archive','--format=tar','-o',source,revision,'--','backend/src','backend/sdk','backend/migrations','backend/package.json',
    'backend/package-lock.json','backend/.env.example','backend/DEPLOYMENT.md','backend/README.md','backend/ACCEPTANCE.md',
    web+'打开设计稿.html',':(glob)'+web+'*.js',':(glob)'+web+'*.css',web+'assets/aurora.webp',web+'assets/optic-wave.webp']);
  run('tar',['-xf',source,'-C',root]);
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
      if (name.endsWith('.dll') || executables.includes(name)) await copyFile(join(from,name),join(to,name));
    }
  }
  await copyTools(join(temp,'pgsql','bin'),join(pg,'bin'),['postgres.exe','initdb.exe','pg_ctl.exe','psql.exe','pg_dump.exe','pg_restore.exe']);
  await copyTools(dirname(ffmpeg),media,['ffmpeg.exe','ffprobe.exe']);
  await copyFile(join(dirname(dirname(ffmpeg)),'LICENSE.txt'),join(media,'LICENSE.txt'));
  const dependencies=JSON.parse(run(node,['src/package-inventory.js'],backend));
  const binaries=[
    ['node','node.exe',['--version'],'https://nodejs.org/dist/'],
    ...['postgres','initdb','pg_ctl','psql','pg_dump','pg_restore'].map(name=>
      [name,'postgres/bin/'+name+'.exe',['--version'],'https://www.enterprisedb.com/download-postgresql-binaries']),
    ['ffmpeg','media/ffmpeg.exe',['-version'],'https://github.com/FFmpeg-Builds/FFmpeg-Builds'],
    ['ffprobe','media/ffprobe.exe',['-version'],'https://github.com/FFmpeg-Builds/FFmpeg-Builds'],
  ];
  const tools=[];
  for (const [name,path,args,source] of binaries) {
    const file=join(runtime,path);
    tools.push({name,path,source,version:run(file,args).split(/\r?\n/)[0],sha256:await hash(file)});
  }
  const nativeFiles=[];
  async function inventory(directory) {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if (entry.isDirectory()) await inventory(path);
      else if (/\.(exe|dll|node)$/i.test(entry.name)) nativeFiles.push({path:relative(root,path).replaceAll('\\','/'),sha256:await hash(path)});
    }
  }
  await inventory(runtime);await inventory(join(backend,'node_modules'));
  nativeFiles.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const manifest={format:1,platform:'win32-x64',revision,dependencies,tools,nativeFiles};
  await writeFile(join(root,'release.json'),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(join(backend,'release-revision.txt'),revision+'\n');
  await mkdir(resolve(output)); // Require a new delivery directory.
  const archive=join(output,'f-ai-backend-win-x64.tar.gz');
  run('tar',['-czf',archive,'-C',root,'.']);
  const sha256=await hash(archive);
  await writeFile(archive+'.sha256',sha256+'  '+basename(archive)+'\n',{flag:'wx'});
  console.log(JSON.stringify({revision,archive,sha256}));
} finally {await rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:250});}
