import { revisedCopy } from './live-copy-suggestions.js';
import { bindContentAgent, editedProof, integrationSlot } from './live-agent-integrations.js';
import { sceneDesk } from './studio-workflows.js';
import { field, form, grid, h, input, item, link, list, notice, panel, textarea, toast } from './live.js';

const platforms={taobao:'淘宝',pinduoduo:'拼多多',douyin:'抖店'};
const root='/v1/copywriting';
const lines=value=>value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);

export async function copyReviewPage(ctx) {
  const platform=Object.hasOwn(platforms,ctx.args[0])?ctx.args[0]:'pinduoduo';
  const url=root+'/rules/'+platform;
  let rules;
  try {rules=await ctx.api(url);} catch (error) {if (error.code!=='NOT_FOUND') throw error;}
  const editor=ctx.manager?panel('工作区规则',form('copy-rules',
    field('标题字数上限',input('titleLimit','type="number" min="1" max="300" required value="'+h(rules?.titleLimit)+'"')) +
    field('每条卖点字数上限',input('sellingPointLimit','type="number" min="1" max="1000" required value="'+h(rules?.sellingPointLimit)+'"')) +
    field('禁用短语（每行一条）',textarea('forbiddenPhrases','maxlength="5050"',rules?.forbiddenPhrases.join('\n'))),'保存规则')):'';
  const review=rules?form('copy-review',field('商品标题',input('title','required maxlength="600"')) +
    field('卖点（每行一条）',textarea('sellingPoints','maxlength="20010"')),'校验文案') :
    notice(ctx.manager ? '先保存本平台的工作区规则，即可检查商品标题和卖点。' : '请工作区管理员先设置本平台的文案规则。');
  const platformLinks=Object.entries(platforms).map(([key,label])=>key===platform
    ? '<strong aria-current="page">'+h(label)+'</strong>':link(label,'copy-review/'+key));
  const rulesPane='<nav class="scene-platforms" aria-label="校验平台">'+platformLinks.join('')+'</nav>'+
    grid(panel('文案检查',review+'<div data-copy-result aria-live="polite"></div>'),editor);
  sceneDesk(ctx,'copywriting',[
    {id:'write',label:'内容创作',icon:'copywriting',body:integrationSlot('ecommerce-content-agent')},
    {id:'check',label:'平台校验',icon:'tasks',body:rulesPane},
  ], ctx.args[0] ? 'check' : 'write',link('创作文案','create/copywriting/copywriting.generate')+link('技能运行','skills'));
  void bindContentAgent(ctx, platform);
  ctx.submit('copy-rules',async data=>{
    const body={revision:rules?.revision ?? 0,titleLimit:Number(data.get('titleLimit')),
      sellingPointLimit:Number(data.get('sellingPointLimit')),forbiddenPhrases:lines(data.get('forbiddenPhrases'))};
    await ctx.api(url,{method:'PUT',body});
    toast('平台规则已保存');
    ctx.reload();
  });
  const edit=document.querySelector('[data-form="copy-review"]');
  if(!edit)return;
  if (ctx.args[1] === 'from' && ctx.args[2]) {
    const task = await ctx.api('/v1/tasks/' + encodeURIComponent(ctx.args[2]));
    if (!ctx.active()) return;
    if (task.capabilityId !== 'copywriting.content-package' || task.state !== 'succeeded' || task.result?.platform !== platform) throw new Error('该任务没有此平台可校验的文案。');
    const revised=editedProof.get(task.id);
    edit.elements.title.value = revised?.title ?? task.result.title;
    edit.elements.sellingPoints.value = revised?.sellingPoints ?? task.result.sellingPoints.join('\n');
  }
  let sequence=0;
  const target=document.querySelector('[data-copy-result]');
  edit.addEventListener('input',()=>{sequence++;target.replaceChildren();});
  function read(){return {platform,revision:rules.revision,title:edit.elements.title.value,sellingPoints:lines(edit.elements.sellingPoints.value)};}
  async function check(){
    const token=++sequence, submitted=read();
    target.textContent='正在校验…';
    let response;
    try {response=await ctx.api(root+'/review',{method:'POST',body:submitted});}
    catch(e){if(ctx.active()&&token===sequence)target.textContent='校验未完成，可以重新提交。';throw e;}
    if(!ctx.active()||token!==sequence)return;
    const revised=revisedCopy(submitted,response.issues);
    const replaceable=response.issues.some(i=>i.code==='REVIEW_TERM');
    target.innerHTML=notice(response.passed?'文案通过工作区规则校验。':'发现需要修改或确认的内容。')+
      list(response.issues,issue=>item(issue.field==='title'?'标题':'卖点 '+(issue.position+1),
        issue.code==='TOO_LONG'?'当前 '+issue.length+' 字，上限 '+issue.limit :
          issue.code==='REVIEW_TERM'?'审阅词语 '+issue.term+'，建议 '+issue.suggestion:'命中禁用短语 '+issue.term),'')+
      (replaceable?'<p>'+revised.marked+'</p><button type="button" class="smallbtn" data-apply-copy>应用词语建议并复检</button>':'');
    target.querySelector('[data-apply-copy]')?.addEventListener('click',()=>{
      if(token!==sequence)return;
      edit.elements.title.value=revised.title;edit.elements.sellingPoints.value=revised.sellingPoints.join('\n');
      target.replaceChildren();edit.requestSubmit();
    },{once:true});
  }
  ctx.submit('copy-review',check);
}
