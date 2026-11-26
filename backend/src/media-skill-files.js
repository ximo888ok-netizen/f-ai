import { lstat, open, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { imageSize } from 'image-size';
import { GeneratedFile } from './model-file.js';
import { ProviderError } from './model-http.js';

const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp4':'video/mp4'};
const bad=()=>new ProviderError('INVALID_SKILL_OUTPUT');
export async function writeInputs(dir,assets,skill) {
  const names=[];let inputPixels=0,height=0;
  for(const [i,asset] of assets.entries()){
    const ext=Object.keys(mime).find(key=>mime[key]===asset.mediaType);
    if(!ext||!skill.mediaTypes.includes(asset.mediaType))throw new ProviderError('INVALID_SKILL_INPUT');
    const bytes=Buffer.from(asset.dataBase64,'base64');
    if(asset.mediaType.startsWith('image/')){
      const {width,height:h}=imageSize(bytes);
      if(!width||!h||width>20000||h>20000)throw new ProviderError('SKILL_INPUT_DIMENSIONS');
      inputPixels+=width*h;height+=Math.round(h*750/width);
      if(inputPixels>32000000 || (skill.local==='white' && (Math.max(width,h)/.87)**2>32000000) ||
        (skill.local==='stitch' && (height>30000 || h*750/width<0.5)))throw new ProviderError('SKILL_INPUT_DIMENSIONS');
    }
    const name=String(i+1).padStart(2,'0')+ext;
    await writeFile(join(dir,name),bytes,{flag:'wx'});names.push(name);
  }
  return names;
}
export class MediaOutputs {
  constructor(files,details={}) {this.files=files;this.details=details;}
}
async function readRegular(path,limit){
  const stat=await lstat(path);
  if(!stat.isFile()||stat.nlink!==1||!stat.size||stat.size>limit)throw bad();
  const handle=await open(path,'r');
  try {return await handle.readFile();} finally{await handle.close();}
}
export async function readOutputs(directory,spec) {
  const manifest=JSON.parse(await readRegular(join(directory,'result.json'),128*1024));
  if(manifest.status!=='succeeded')throw new ProviderError('MEDIA_SKILL_FAILED');
  if(typeof manifest.text!=='string'||manifest.text.length>24000)throw bad();
  if(spec.output==='text'){
    if(!manifest.text.trim())throw bad();
    return {text:manifest.text,skill:spec.id};
  }
  if(!Array.isArray(manifest.files)||manifest.files.length<spec.minOutputs||manifest.files.length>24)throw bad();
  const files=[],seen=new Set();let total=0;
  for(const name of manifest.files){
    if(typeof name!=='string'||name!==basename(name)||!/^[\p{L}\p{N} _.-]{1,100}$/u.test(name)||seen.has(name.toLowerCase()))throw bad();
    seen.add(name.toLowerCase());
    const mediaType=mime[extname(name).toLowerCase()];
    if(!mediaType?.startsWith(spec.output+'/'))throw bad();
    const bytes=await readRegular(join(directory,name),10*1024*1024);
    total+=bytes.length;if(total>48*1024*1024)throw bad();
    files.push({name,file:new GeneratedFile(bytes,mediaType)});
  }
  return new MediaOutputs(files,{skill:spec.id,text:manifest.text});
}
export async function storeMediaOutputs(db,task,result){
  const files=[];
  for(const {name,file} of result.files){
    const assetId=randomUUID();
    await db.query('INSERT INTO assets (id,workspace_id,account_id,name,media_type,source,purpose,data,derived_ai) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)',
      [assetId,task.workspace_id,task.account_id,name,file.mediaType,task.provider_id,task.capability_id,file.bytes]);
    files.push({name,assetId,mediaType:file.mediaType});
  }
  return {...result.details,...files[0],type:files[0].mediaType.split('/')[0],modelId:task.input.modelId,files};
}
