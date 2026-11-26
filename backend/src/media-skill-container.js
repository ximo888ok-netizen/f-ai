import {execFile} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute,dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ProviderError} from './model-http.js';

const runner=fileURLToPath(new URL('../integrations',import.meta.url));
const identifiers=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;
const secretVars=/^(OPENAI_API_KEY|DASHSCOPE_API_KEY|ARK_API_KEY|SEEDANCE_EP_ID|BYTEPLUS_API_KEY|FAL_KEY|QHKIT_TOKEN|DLAZY_API_KEY|GEMINI_API_KEY|STABILITY_API_KEY|MINIMAX_API_KEY|VIDU_TOKEN|RUNWAY_MCP_TOKEN|ALIBABA_CLOUD_(ACCESS_KEY_ID|ACCESS_KEY_SECRET|SECURITY_TOKEN)|MEDIA_OSS_(BUCKET|ENDPOINT)|MEDIA_(AIDGE_ENDPOINT|SUITE_PROVIDER|IMAGE_MODEL|VIDEO_MODEL|PLANNER_KEY|PLANNER_MODEL|DOWNLOAD_HOSTS)|OPENSTORYLINE_URL)$/;
export function validateBinding(b,env){
  if(!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(b.workspaceId))throw new Error('Invalid media workspace');
  if(b.driver==='desktop-python'){
    if(!['commerce','suite','byte','wan','aidge','runway','firered'].includes(b.source)||!isAbsolute(b.python??'')||b.profile)
      throw new Error('Invalid desktop Python media binding');
  }else if((b.driver && b.driver!=='docker')||!/^sha256:[a-f0-9]{64}$/.test(b.image) ||
    !identifiers.test(b.network??'') || ['none','bridge','host','default'].includes(b.network))throw new Error('Invalid isolated media runtime binding');
  if(b.profile && (!isAbsolute(b.profile)||b.profile.includes(',')))throw new Error('Use an absolute dedicated media profile');
  const auth={};
  for(const [alias,ref] of Object.entries(b.env??{})){
    if(!secretVars.test(alias)||typeof ref!=='string'||!/^[A-Z][A-Z0-9_]*$/.test(ref))throw new Error('Invalid media credential reference');
    auth[alias]=env[ref]??'';
  }
  return {...b,workspaceId:b.workspaceId.toLowerCase(),auth};
}
function container(binary,b,source,input,probe){
  const desktop=b.driver==='desktop-python';
  const name='fai-media-'+randomUUID();
  const mount=(src,dst)=>'type=bind,source='+src+',target='+dst+',readonly';
  const args=['run','--pull=never','--rm','-i','--name',name,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--pids-limit','192','--memory','3g','--cpus','2','--user','65532:65532','--network',probe?'none':b.network,
    '--tmpfs','/tmp:rw,nosuid,nodev,size=1536m,mode=1777','--mount',mount(source,'/opt/source'),'--mount',mount(runner,'/opt/fai')];
  if(b.profile)args.push('--mount',mount(b.profile,'/opt/vendor-profile'));
  for(const key of Object.keys(b.auth))args.push('--env',key);
  args.push('--entrypoint','python3',b.image,'-I','-B','/opt/fai/media_container.py',probe?'probe':'run');
  const env=Object.fromEntries((desktop?['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG']:['PATH','SystemRoot','WINDIR','HOME','USERPROFILE','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','TEMP','TMP']).filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  if(desktop)env.PATH=dirname(b.python)+delimiter+(env.PATH??'');
  return new Promise((resolve,reject)=>{
    const child=execFile(desktop?b.python:binary,desktop?['-I','-B','-X','utf8',join(runner,'media_container.py'),probe?'probe':'run',source]:args,
      {windowsHide:true,timeout:probe?15000:20*60*1000,maxBuffer:probe?65536:68*1024*1024,env:{...env,...b.auth}},
      (error,stdout)=>{
        if(error){
          if(!desktop && (error.killed||error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')){
            execFile(binary,['rm','-f',name],{windowsHide:true,timeout:15000},()=>{});
          }
          reject(new ProviderError('MEDIA_EXECUTOR_FAILED'));return;
        }
        try{resolve(JSON.parse(stdout));}catch{reject(new ProviderError('INVALID_SKILL_OUTPUT'));}
      });
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(input));
  });
}
export async function probeContainer(bin,b,source,spec){
  if(Object.values(b.auth).some(v=>!v))return {state:'credentials_required'};
  try{return await container(bin,b,source,{source:b.source,files:[spec.file],alias:spec.alias},true);}
  catch{return {state:'runtime_unavailable'};}
}
export async function runContainer(bin,b,source,s,dir,names,params){
  const assets=await Promise.all(names.map(async name=>({name,data:(await readFile(join(dir,'in',name))).toString('base64')})));
  const slots=params.slots??s.slots??[];
  const required=Math.max(s.minOutputs,slots.length);
  const reply=await container(bin,b,source,{source:s.source,alias:s.alias,skill:s.file,title:s.title,kind:s.output,minOutputs:required,slots,
    brief:params.prompt,channel:params.platform,ratio:params.ratio,frameMode:params.frameMode,assets},false);
  if(reply.status!=='succeeded'||!Array.isArray(reply.files)||reply.files.length<required||reply.files.length>24)throw new ProviderError('MEDIA_SKILL_FAILED');
  const files=[];let bytes=0;
  for(const [i,item] of reply.files.entries()){
    if(!/^\.(jpg|png|mp4)$/.test(item.ext)||typeof item.data!=='string')throw new ProviderError('INVALID_SKILL_OUTPUT');
    const buffer=Buffer.from(item.data,'base64');bytes+=buffer.length;
    if(!buffer.length||buffer.length>10*1024*1024||bytes>48*1024*1024)throw new ProviderError('INVALID_SKILL_OUTPUT');
    const name=String(i+1).padStart(2,'0')+'-'+s.alias+item.ext;
    await writeFile(join(dir,'out',name),buffer,{flag:'wx'});files.push(name);
  }
  await writeFile(join(dir,'out','result.json'),JSON.stringify({status:reply.status,text:reply.text,files}));
}
