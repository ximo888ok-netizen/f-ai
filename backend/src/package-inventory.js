import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const bytes=await readFile(new URL('../package-lock.json',import.meta.url));
const lock=JSON.parse(bytes);
const packages=Object.entries(lock.packages).filter(([path,item])=>path && !item.dev).map(([path,item])=>({
  name:item.name ?? path.slice(path.lastIndexOf('node_modules/')+'node_modules/'.length),
  version:item.version,license:item.license ?? null,optional:Boolean(item.optional),
  ...(item.os && {os:item.os}),...(item.cpu && {cpu:item.cpu}),
})).sort((a,b)=>a.name.localeCompare(b.name,'en') || a.version.localeCompare(b.version,'en'));
console.log(JSON.stringify({backend:lock.name,version:lock.version,node:process.versions.node,
  lockSha256:createHash('sha256').update(bytes).digest('hex'),packages},null,2));
