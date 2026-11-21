import { field, form, grid, h, heading, input, item, link, list, notice, panel, textarea, toast } from './live.js';

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
    notice('这个平台还没有工作区规则。');
  const platformLinks=Object.entries(platforms).map(([key,label])=>key===platform
    ? '<strong aria-current="page">'+h(label)+'</strong>':link(label,'copy-review/'+key));
  ctx.html(heading('平台文案校验')+link('返回技能运行','skills') +
    '<div class="live-row">'+platformLinks.join('')+'</div>' +
    grid(editor,panel('文案检查',review+'<div data-copy-result aria-live="polite"></div>')));
  ctx.submit('copy-rules',async data=>{
    const body={revision:rules?.revision ?? 0,titleLimit:Number(data.get('titleLimit')),
      sellingPointLimit:Number(data.get('sellingPointLimit')),forbiddenPhrases:lines(data.get('forbiddenPhrases'))};
    await ctx.api(url,{method:'PUT',body});
    toast('平台规则已保存');
    ctx.reload();
  });
  ctx.submit('copy-review',async data=>{
    const response=await ctx.api(root+'/review',{method:'POST',body:{
      platform,revision:rules.revision,title:data.get('title'),sellingPoints:lines(data.get('sellingPoints')),
    }});
    if (!ctx.active()) return;
    document.querySelector('[data-copy-result]').innerHTML=notice(response.passed?'文案通过工作区规则校验。':'发现需要修改或确认的内容。')+
      list(response.issues,issue=>item(issue.field==='title'?'标题':'卖点 '+(issue.position+1),
        issue.code==='TOO_LONG'?'当前 '+issue.length+' 字，上限 '+issue.limit :
          issue.code==='REVIEW_TERM'?'审阅词语 '+issue.term+'，建议 '+issue.suggestion:'命中禁用短语 '+issue.term),'');
  });
}
