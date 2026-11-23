// Both modes operate on the same native fields so returning to a step keeps its value.
export function taskIntake(form, capability) {
  const mode=form.elements.mode;
  const submit=form.querySelector('button:not([type]),button[type=submit]');
  if(!mode || !submit)return;
  const groups=[...form.children].filter(node=>node!==submit && !node.contains(mode));
  const caption=(node)=>node.matches('fieldset')?node.querySelector('legend')?.textContent:
    [...node.childNodes].filter(x=>x.nodeType===3).map(x=>x.textContent).join('').trim();
  const value=(node)=>[...node.querySelectorAll('input, select, textarea')].map(el=>{
    if(el.tagName==='SELECT')return [...el.selectedOptions].filter(o=>o.value).map(o=>o.textContent).join('、');
    if(el.type==='checkbox')return el.checked?'是':'否';
    return el.value.trim();
  }).filter(Boolean).join(' · ');
  const preview=document.createElement('details');
  preview.className='live-fold';
  preview.innerHTML='<summary>核对参数</summary><dl class="live-facts"></dl>';
  const transcript=document.createElement('div');
  transcript.className='live-intake';transcript.setAttribute('aria-live','polite');
  const controls=document.createElement('div');controls.className='live-row';
  controls.innerHTML='<button type="button" class="smallbtn" data-prev>上一步</button><button type="button" class="smallbtn" data-next>继续</button>';
  form.insertBefore(transcript,groups[0]??submit);form.insertBefore(preview,submit);form.insertBefore(controls,submit);
  let index=0;
  const guided=()=>mode.value==='chat' && capability.id!=='model.chat';
  function show(){
    const chat=guided();
    groups.forEach((g,i)=>{g.hidden=chat&&index!==i;});
    controls.hidden=!chat;transcript.hidden=!chat;
    controls.firstElementChild.disabled=index===0;
    controls.lastElementChild.hidden=index===groups.length;
    submit.hidden=chat && index<groups.length;
    preview.hidden=chat && index<groups.length;
    if(chat && index===groups.length)preview.open=true;
    transcript.textContent=chat?(index<groups.length?'第 '+(index+1)+' / '+groups.length+' 项 · '+(caption(groups[index])||'填写参数'):'参数已收齐，请核对后提交。'):'';
  }
  function summary(){
    const list=preview.querySelector('dl');list.replaceChildren();
    for(const node of groups){const entry=value(node);if(!entry)continue;
      const dt=document.createElement('dt'),dd=document.createElement('dd');
      dt.textContent=caption(node)||'参数';dd.textContent=entry;list.append(dt,dd);
    }
  }
  const advance=()=>{
    const invalid=groups[index]?.querySelector(':invalid');
    if(invalid){invalid.reportValidity();return;}
    index=Math.min(index+1,groups.length);show();summary();
    (groups[index]?.querySelector('input,select,textarea')??submit).focus();
  };
  controls.firstElementChild.onclick=()=>{index=Math.max(0,index-1);show();};
  controls.lastElementChild.onclick=advance;
  mode.addEventListener('change',()=>{index=0;show();summary();});
  form.addEventListener('input',()=>{if(preview.open)summary();});
  preview.addEventListener('toggle',()=>{if(preview.open)summary();});
  form.addEventListener('keydown',event=>{
    if(event.key==='Enter' && guided() && index<groups.length && !event.isComposing && event.target.matches('input:not([type=checkbox])')){
      event.preventDefault();advance();
    }
  });
  form.addEventListener('invalid',event=>{
    if(!guided())return;
    const i=groups.findIndex(g=>g.contains(event.target));
    if(i>=0 && groups[i].hidden){index=i;show();}
  },true);
  show();
}
