import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from './catalog.js';
import { ApiError,route } from './http.js';
import { modelProviders } from './merchant-connections.js';
import { ProviderError } from './model-http.js';
import { mediaSkills } from './media-skills.js';
import { mediaSources } from './media-skill-sources.js';
import { readOutputs,writeInputs } from './media-skill-files.js';
import { localScript,probePython,runLocal } from './media-skill-local.js';
import { probeContainer,runContainer,validateBinding } from './media-skill-container.js';
import { matchingProviders } from './providers.js';
import { featureAllowed,readSettings } from './merchant-features.js';

const builtins=fileURLToPath(new URL('../media-runtime/',import.meta.url));
export function mediaSettings(env=process.env){
  if(!env.FAI_MEDIA_SKILLS_FILE)return {bindings:[]};
  const c=JSON.parse(readFileSync(env.FAI_MEDIA_SKILLS_FILE,'utf8').replace(/^\uFEFF/,''));
  for(const p of [c.sources,c.python,c.docker].filter(Boolean))if(!isAbsolute(p)||p.includes(','))throw new Error('Media runtime paths must be absolute');
  const bindings=(c.bindings??[]).map(b=>validateBinding(b,env));
  const ids=new Set();
  for(const b of bindings){
    const key=b.workspaceId+'/'+b.source;
    if(!mediaSkills.some(s=>!s.native&&!s.local&&s.source===b.source)||ids.has(key))throw new Error('Duplicate or unknown media runtime source');
    ids.add(key);
  }
  return {...c,bindings};
}
export async function installMediaSkills(providers,settings=mediaSettings(),loopbackOnly=false){
  const definitions=new Map();
  let python='';
  if(settings.python){try{python=await probePython(settings.python);}catch{/* Independently configured vendors can still be used. */}}
  for(const spec of mediaSkills){
    const src=mediaSources[spec.source];
    const dir=spec.source==='aidge'?builtins:settings.sources&&join(settings.sources,spec.source,src.revision);
    const file=dir&&join(dir,spec.file);
    let installed=false;
    if(!spec.native && file){try{await access(file);installed=true;}catch{/* Missing checkout is visible in the directory. */}}
    let state=installed?'executor_required':'source_missing';
    const bindings=new Map();
    if(installed && spec.local){
      state=python && (spec.local==='storyboard'||python==='imaging')?'local_ready':'python_required';
      if(state==='local_ready')try{await localScript(file,spec);}catch{state='source_mismatch';}
    }else if(installed&&!spec.native){
      for(const binding of settings.bindings.filter(b=>b.source===spec.source)){
        if(binding.driver==='desktop-python'&&!loopbackOnly)throw new Error('Desktop Python media bindings require a loopback-only studio');
        const probe=settings.docker||binding.driver==='desktop-python'?await probeContainer(settings.docker,binding,dir,spec):{state:'runtime_unavailable'};
        bindings.set(binding.workspaceId,{binding,state:probe.state??'runtime_unavailable'});
      }
    }
    const stateFor=id=>bindings.get(id.toLowerCase())?.state??state;
    definitions.set(spec.id,{stateFor,installed,usesPlanner:id=>!spec.local&&!!bindings.get(id.toLowerCase())?.binding.auth.MEDIA_PLANNER_KEY});
    if(spec.native || !(state==='local_ready' || [...bindings.values()].some(b=>b.state==='configured')))continue;
    const info={id:spec.alias,kind:spec.output,model:spec.title,protocol:'media-skill',capabilities:[spec.id],streamText:false,imageQuality:false};
    const signature=createHash('sha256').update(JSON.stringify([spec.id,src?.revision,settings.python,settings.sources,
      [...bindings].map(([w,{binding:b}])=>[w,b.driver,b.python,b.image,b.network,b.profile,b.env])])).digest('hex');
    if(providers.has('model:'+info.id))throw new Error('Duplicate media model id: '+info.id);
    providers.set('model:'+info.id,{info,signature,nonRepeatable:true,runTimeoutMs:spec.local?210000:1250000,
      availableIn:workspace=>['local_ready','configured'].includes(stateFor(workspace)),
      supports:c=>c.id===spec.id,
      validate:(_c,p)=>{
        if(!p.prompt.trim())throw new ApiError(400,'INVALID_INPUT','请填写商品资料或制作要求。');
        if(spec.alsoNative==='ark-video' && p.frameMode!=='references' && p.assetIds?.length>2)throw new ApiError(422,'INVALID_INPUT','首尾帧模式最多两张图片。');
      },
      async run(task,{parameters,assets}){
        const binding=bindings.get(task.workspace_id.toLowerCase())?.binding;
        if(!spec.local&&!binding)throw new ProviderError('MEDIA_EXECUTOR_UNAVAILABLE');
        const dirJob=await mkdtemp(join(tmpdir(),'fai-media-'));
        try{
          await mkdir(join(dirJob,'in'));await mkdir(join(dirJob,'out'));
          const names=await writeInputs(join(dirJob,'in'),assets,spec);
          if(spec.local)await runLocal(settings.python,file,spec,dirJob,names,parameters);
          else await runContainer(settings.docker,binding,dir,spec,dirJob,names,parameters);
          return await readOutputs(join(dirJob,'out'),spec);
        }finally{await rm(dirJob,{recursive:true,force:true});}
      },
    });
  }
  return definitions;
}
export function registerMediaSkills(app,db,providers,directory){
  for(const kind of ['image','video']){
    route(app,'GET','/v1/media-skills/'+kind,{feature:kind,tags:['Studio media'],summary:'Read workspace '+kind+' skills'},async req=>{
      const available=await modelProviders(db,req.context.workspaceId,providers);
      const policy=await readSettings(db,req.context,kind,false);
      return {items:mediaSkills.filter(s=>s.kind===kind).map(s=>{
        const cap=catalog.get(s.id),runtime=directory.get(s.id);
        const eligible=featureAllowed(policy,s.id);
        const matches=(eligible?matchingProviders(available,cap):[]).filter(p=>{
          const info=available.get(p)?.info;
          return info && (info.id===s.alias || info.protocol===(s.native??s.alsoNative));
        });
        let state=s.native?(matches.length?'configured':'model_required'):runtime.stateFor(req.context.workspaceId);
        if(s.alsoNative && matches.some(p=>available.get(p).info.protocol===s.alsoNative))state='configured';
        if(!matches.length&&['configured','local_ready'].includes(state))state='disabled';
        if(!eligible)state='disabled';
        return {id:s.id,alias:s.alias,title:s.title,group:s.group,channels:s.channels,origin:s.origin,source:s.source,
          revision:s.native||s.source==='aidge'?null:mediaSources[s.source].revision,installed:runtime.installed,
          state,models:matches.map(p=>available.get(p).info.id),usesPlanner:runtime.usesPlanner(req.context.workspaceId),slots:s.slots??[],frameMode:s.alsoNative==='ark-video',cost:cap.cost,min:s.min,max:s.max,types:s.mediaTypes,
          needsMovie:!!s.needsMovie,needsImage:!!s.needsImage,consent:s.consent,output:s.output,minOutputs:s.minOutputs,local:s.local??null,native:s.native??null};
      })};
    });
  }
}
