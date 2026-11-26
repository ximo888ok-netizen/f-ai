import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { ProviderError } from './model-http.js';

const exec=promisify(execFile);
const scripts={
  white:['check_main_image.py','7c18a6c9bccec9026436a67d8cea981757333240'],
  stitch:['stitch_long_image.py','5c4f8b227381195b2b09f4319650a3215eeb7b67'],
  storyboard:['generate_prompt.py','24e031a87cb3c0ce6fc8b9922e86c9cc29f251b1'],
};
export async function localScript(source,skill) {
  const [name,hash]=scripts[skill.local],path=join(dirname(source),'scripts',name);
  // git on Windows can materialize CRLF even for a pinned LF source.
  const bytes=Buffer.from((await readFile(path,'utf8')).replace(/\r\n/g,'\n'));
  if(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==hash)throw new Error('Source mismatch');
  return bytes;
}
function pythonEnv(){
  const env={};
  for(const k of ['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG'])if(process.env[k])env[k]=process.env[k];
  return env;
}
export async function probePython(python){
  const options={windowsHide:true,timeout:12000,env:pythonEnv()};
  await exec(python,['-I','-c','import sys; assert sys.version_info >= (3,8)'],options);
  try{await exec(python,['-I','-c','from PIL import Image; import numpy'],options);return 'imaging';}catch{return 'standard';}
}
export async function runLocal(python,source,spec,dir,names,parameters){
  const path=join(dir,'tool.py'),out=join(dir,'out');
  await writeFile(path,await localScript(source,spec),{flag:'wx'});
  const inputs=names.map(n=>join(dir,'in',n));
  async function call(args,allowCheckFailure=false){
    try{return (await exec(python,['-I','-B','-X','utf8',path,...args],{cwd:dir,env:pythonEnv(),timeout:65000,maxBuffer:256*1024,windowsHide:true})).stdout;}
    catch(e){if(allowCheckFailure && e.code===1 && e.stdout?.trim().startsWith('{'))return e.stdout;throw new ProviderError('MEDIA_SKILL_FAILED');}
  }
  let text='',files=[];
  if(spec.local==='storyboard'){
    text=await call(['--product='+parameters.prompt,'--images',...names,'--aspect-ratio',parameters.ratio??'9:16']);
  }else if(spec.local==='white'){
    const target=join(out,'main-image.jpg');
    await call([inputs[0],'--json','--fix',target],true);
    const audit=JSON.parse(await call([target,'--json'],true));
    text='修正后检查：'+(audit.pass?'通过':'仍有待核对项')+'\n'+['white_background','coverage','size','exact_ffffff'].map(k=>audit[k].detail).join('\n');
    files=['main-image.jpg'];
  }else{
    await call([...inputs,'--width','750','--slice','1546','--out',join(out,'detail.jpg')]);
    files=['detail.jpg'];
    for(const name of (await readdir(join(out,'detail-slices'))).sort()){
      const label='slice-'+name;await rename(join(out,'detail-slices',name),join(out,label));files.push(label);
    }
    text='按素材顺序拼接，宽 750 px，共 '+(files.length-1)+' 张切片。';
  }
  await writeFile(join(out,'result.json'),JSON.stringify({status:'succeeded',text,files}));
}
