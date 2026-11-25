import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, renameSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { mediaSkills } from '../src/media-skills.js';
import { mediaSources } from '../src/media-skill-sources.js';

const [destination] = process.argv.slice(2);
if (!destination) throw new Error('Usage: node prepare.mjs <external-source-directory>');
const root=resolve(destination);
const git=(args,opts={})=>execFileSync('git',args,{stdio:['pipe','pipe','inherit'],encoding:'utf8',windowsHide:true,...opts});
async function prepare([name,{repo,revision}]) {
  const parent=join(root,name),out=join(parent,revision);
  const skills=mediaSkills.filter(s=>s.source===name);
  mkdirSync(parent,{recursive:true});
  if(!existsSync(out)){
    const temp=mkdtempSync(join(parent,'.install-'));
    git(['clone','--quiet','--no-checkout','--filter=blob:none','--depth=1','https://github.com/'+repo+'.git',temp]);
    try{git(['-C',temp,'cat-file','-e',revision+'^{commit}'],{stdio:'ignore'});}
    catch{git(['-C',temp,'fetch','--depth=1','origin',revision]);}
    // Source and support files only. Published example media and datasets do not enter a customer job.
    const locations=new Set(skills.map(s=>dirname(s.file)));
    if(name==='fal')for(const extra of ['skills/genmedia','skills/fal-media','skills/model-routing'])locations.add(extra);
    if(name==='ark')locations.add('skills/arkcli-shared');
    if(name==='byte')locations.add('skills/byted-ark-seedance-guide');
    if(name==='runway')locations.add('.mcp.json');
    const patterns=[...locations].map(p=>p==='.'?'/*':'/'+p);
    git(['-C',temp,'sparse-checkout','set','--no-cone','--stdin'],{input:[...patterns,'/LICENSE*','/README*','!*.mp4','!*.webm','!*.zip','!*.safetensors','!*.gif'].join('\n')+'\n'});
    git(['-C',temp,'checkout','--quiet','--detach',revision]);
    for(const s of skills)readFileSync(join(temp,s.file));
    renameSync(temp,out);
  }
  if(git(['-C',out,'rev-parse','HEAD']).trim()!==revision)throw new Error('Unexpected source revision for '+name);
  console.log(name,revision,skills.length);
}
const entries=Object.entries(mediaSources);
for(let i=0;i<entries.length;i+=3)await Promise.all(entries.slice(i,i+3).map(prepare));
