import { h } from './live-ui.js';

function offsets(value, issues) {
  return issues.filter(i => i.code==='REVIEW_TERM' && Number.isInteger(i.start) && Number.isInteger(i.end) &&
    value.slice(i.start,i.end)===i.term).sort((a,b)=>a.start-b.start);
}
export function reviseText(value, issues, markup=false) {
  const escape=markup?h:String;
  let at=0, out='';
  for(const i of offsets(value,issues)){
    if(i.start<at)continue;
    out+=escape(value.slice(at,i.start))+(markup?'<mark>'+h(i.term)+'</mark>':i.suggestion);
    at=i.end;
  }
  return out+escape(value.slice(at));
}
export function revisedCopy(submission,issues) {
  const title=issues.filter(i=>i.field==='title');
  const byLine=index=>issues.filter(i=>i.field==='sellingPoints'&&i.position===index);
  return { title:reviseText(submission.title,title), sellingPoints:submission.sellingPoints.map((v,i)=>reviseText(v,byLine(i))),
    marked:[reviseText(submission.title,title,true),...submission.sellingPoints.map((v,i)=>reviseText(v,byLine(i),true))].join('<br>') };
}
