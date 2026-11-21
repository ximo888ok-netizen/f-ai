import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { migrationFiles, postgres, row } from './db.js';

const exec=promisify(execFile);
const isWindows=process.platform==='win32';
const version=1;
const manifestName='manifest.json';
const sslParameters={sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY',
  sslcrl:'PGSSLCRL',sslcrldir:'PGSSLCRLDIR',channel_binding:'PGCHANNELBINDING',application_name:'PGAPPNAME'};
const identifier=/^[a-z][a-z0-9_-]{0,63}$/;

function targets(settings) {
  return [{name:'control',file:'control.dump',url:settings.databaseUrl},
    ...[...settings.dedicatedDatabases].sort(([a],[b])=>a.localeCompare(b)).map(([key,url])=>{
      if (!identifier.test(key)) throw new Error('Invalid database alias');
      return {name:'tenant:'+key,file:'tenant-'+key+'.dump',url};
    })];
}

function privateEnvironment(connection) {
  const invalidUrl=()=>new Error('Use a PostgreSQL connection URL with an explicit database');
  let url;
  try {url=new URL(connection);} catch {throw invalidUrl();}
  if (!['postgresql:','postgres:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw invalidUrl();
  }
  for (const key of url.searchParams.keys()) {
    if (!Object.hasOwn(sslParameters,key)) throw new Error('Unsupported database connection option for archiving');
  }
  const env={...process.env};
  const replaced=new Set(['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGPASSFILE',
    'PGSERVICE','PGSERVICEFILE','PGOPTIONS','PGTARGETSESSIONATTRS']);
  for (const key of Object.keys(env)) if (replaced.has(key.toUpperCase())) delete env[key];
  Object.assign(env,{PGHOST:url.hostname.replace(/^\[|\]$/g,''),PGPORT:url.port || '5432',
    PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGCONNECT_TIMEOUT:'10'});
  if (url.username) env.PGUSER=decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD=decodeURIComponent(url.password);
  for (const [name,variable] of Object.entries(sslParameters)) {
    if (url.searchParams.has(name)) env[variable]=url.searchParams.get(name);
  }
  return env;
}

function utilities(bin) {
  if (!bin || !isAbsolute(bin)) throw new Error('Set FAI_PG_BIN to an absolute PostgreSQL client tools directory');
  return async (command,args,env)=>{
    const tool=join(bin,command+(isWindows?'.exe':''));
    try {
      await exec(tool,args,{env,windowsHide:true,timeout:30*60*1000,maxBuffer:1024*1024});
    } catch (error) {
      throw new Error(command+' failed'+(typeof error.code==='number'?' (exit '+error.code+')':''));
    }
  };
}

async function hashFile(file) {
  const info=await lstat(file);
  if (!info.isFile() || !info.size) throw new Error('A required archive is not a regular, nonempty file');
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return {sha256:hash.digest('hex'),size:info.size};
}

async function assertEmpty(url) {
  const db=postgres(url);
  try {
    // Template databases contain built-in system objects and no application relations.
    const {occupied}=await row(db,`SELECT EXISTS(
      SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND left(n.nspname,3)<>'pg_'
      AND (n.nspname<>'public'
        OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=n.oid)
        OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace=n.oid)
        OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace=n.oid))
    ) AS occupied`);
    if (occupied) throw new Error('A restore target already contains database objects');
  } finally {await db.close();}
}

async function schemaVersion(url) {
  const db=postgres(url);
  try {
    const {applied}=await row(db,`SELECT COALESCE(array_agg(name ORDER BY name COLLATE "C"),ARRAY[]::text[]) AS applied FROM migrations`);
    if (!applied.length) throw new Error('Database has no application migrations');
    return applied;
  } finally {await db.close();}
}

export async function backupDatabases(settings,folder,bin=process.env.FAI_PG_BIN) {
  const destination=resolve(folder);
  const run=utilities(bin);
  const entries=targets(settings).map(target=>({...target,env:privateEnvironment(target.url)}));
  await mkdir(destination,{mode:0o700});
  const archives=[];
  for (const target of entries) {
    const filename=join(destination,target.file);
    const migrations=await schemaVersion(target.url);
    await run('pg_dump',['--format=custom','--no-password','--file',filename],target.env);
    archives.push({name:target.name,file:target.file,migrations,...await hashFile(filename)});
  }
  const manifest={version,createdAt:new Date().toISOString(),archives};
  await writeFile(join(destination,manifestName),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
  return manifest;
}

export async function restoreDatabases(settings,folder,bin=process.env.FAI_PG_BIN) {
  const source=resolve(folder);
  const run=utilities(bin);
  const descriptor=join(source,manifestName);
  const info=await lstat(descriptor);
  if (!info.isFile() || info.size>1024*1024) throw new Error('Invalid backup manifest');
  const manifest=JSON.parse(await readFile(descriptor,'utf8'));
  const entries=targets(settings).map(target=>({...target,env:privateEnvironment(target.url)}));
  if (manifest?.version!==version || !Array.isArray(manifest.archives) || manifest.archives.length!==entries.length) {
    throw new Error('The manifest does not match the configured database set');
  }
  const known=await migrationFiles();
  const archives=[];
  for (const [index,target] of entries.entries()) {
    const recorded=manifest.archives[index];
    if (recorded?.name!==target.name || recorded.file!==target.file || !Array.isArray(recorded.migrations)
      || !recorded.migrations.length || !recorded.migrations.every((name,i)=>known[i]===name)) {
      throw new Error('Archive database alias or migration baseline does not match this application');
    }
    const file=join(source,target.file);
    const actual=await hashFile(file);
    if (recorded.sha256!==actual.sha256 || recorded.size!==actual.size) throw new Error('Archive integrity check failed');
    await run('pg_restore',['--list',file],target.env);
    archives.push({target,recorded,file});
  }
  // Preflight the entire set before restoring any individual database.
  for (const {target} of archives) await assertEmpty(target.url);
  for (const {target,recorded,file} of archives) {
    await run('pg_restore',['--single-transaction','--exit-on-error','--no-owner','--no-acl','--no-password',
      '--dbname',`dbname='${target.env.PGDATABASE.replaceAll('\\','\\\\').replaceAll("'","\\'")}'`,file],target.env);
    if (JSON.stringify(await schemaVersion(target.url))!==JSON.stringify(recorded.migrations)) {
      throw new Error('Restored application schema does not match the manifest');
    }
  }
  return {restored:archives.map(({target})=>target.name)};
}
