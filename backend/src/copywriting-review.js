import { detectTerms, reviewCopy } from './catalog.js';
import { requirePlugin } from './plugin-policy.js';
import { row } from './db.js';
import { ApiError, array, choice, integer, invalid, notFound, object, route, text } from './http.js';

const root='/v1/copywriting';
const tags=['Copywriting review'];
const platform=choice('taobao','pinduoduo','douyin');
const revision=integer(0,2147483646);
const ruleParams=object({platform});
const fields='platform,revision,title_limit AS "titleLimit",selling_point_limit AS "sellingPointLimit",forbidden_phrases AS "forbiddenPhrases",updated_at AS "updatedAt"';
const changed=()=>new ApiError(409,'COPY_RULES_CHANGED','Reload the platform rules before trying again');

async function read(db,workspaceId,platform) {
  const result=await row(db,`SELECT ${fields} FROM workspace_copywriting_rules WHERE workspace_id=$1 AND platform=$2`,[workspaceId,platform]);
  if (!result) throw notFound('Copywriting rules');
  return result;
}

function normalize(phrases) {
  const normalized=[...new Set(phrases.map(phrase=>phrase.trim().toLowerCase()))];
  if (normalized.some(phrase=>!phrase)) throw invalid('Forbidden phrases cannot be blank');
  return normalized.sort();
}

function validate(value,limit,phrases,field,position) {
  const normalized=value.trim();
  if (!normalized) throw invalid('Copy must contain text');
  const issues=[];
  const length=Array.from(normalized).length;
  const property={field,...(position!==undefined && {position})};
  if (length>limit) issues.push({...property,code:'TOO_LONG',length,limit});
  for (const {term,suggestion,start,end} of detectTerms({content:value}).matches) {
    issues.push({...property,code:'REVIEW_TERM',term,suggestion,start,end});
  }
  for (const phrase of phrases) {
    const match=new RegExp(RegExp.escape(phrase),'iu').exec(value);
    if (match) {
      issues.push({...property,code:'FORBIDDEN_PHRASE',term:phrase,start:match.index,end:match.index+match[0].length});
    }
  }
  return issues;
}

function review(rules,title,sellingPoints) {
  const issues=validate(title,rules.titleLimit,rules.forbiddenPhrases,'title');
  sellingPoints.forEach((point,index)=>issues.push(...validate(point,rules.sellingPointLimit,rules.forbiddenPhrases,'sellingPoints',index)));
  return {passed:issues.length===0,issues};
}

export function registerCopywritingReview(app,db) {
  route(app,'GET',root+'/rules/:platform',{tags,params:ruleParams,summary:'Read workspace copywriting rules for a platform'},
    request=>read(db,request.context.workspaceId,request.params.platform));
  route(app,'PUT',root+'/rules/:platform',{ feature: 'copywriting',
    tags,params:ruleParams,manager:true,summary:'Save explicit workspace copy rules at a specified revision',
    body:object({revision,titleLimit:integer(1,300),sellingPointLimit:integer(1,1000),forbiddenPhrases:array(text(100),50)}),
  },async request=>{
    const {body,params,context}=request;
    const values=[context.workspaceId,params.platform,body.titleLimit,body.sellingPointLimit,normalize(body.forbiddenPhrases)];
    const saved=body.revision===0
      ? await row(db,`INSERT INTO workspace_copywriting_rules(workspace_id,platform,title_limit,selling_point_limit,forbidden_phrases)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING ${fields}`,values)
      : await row(db,`UPDATE workspace_copywriting_rules SET title_limit=$3,selling_point_limit=$4,forbidden_phrases=$5,
          revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND platform=$2 AND revision=$6 RETURNING ${fields}`,
        [...values,body.revision]);
    if (!saved) throw changed();
    return saved;
  });
  route(app,'POST',root+'/review',{ feature: 'copywriting.detect-terms',
    tags,summary:'Review title and selling points against versioned workspace rules',
    body:object({platform,revision:integer(1,2147483646),title:text(600),sellingPoints:array(text(2000),10),
      previewReplacements:{type:'boolean'}},['platform','revision','title','sellingPoints']),
  },async request=>{
    const {platform,revision,title,sellingPoints}=request.body;
    await requirePlugin(db,request.context.workspaceId,'copywriting');
    const rules=await read(db,request.context.workspaceId,platform);
    if (rules.revision!==revision) throw changed();
    const result={platform,revision,offsetUnit:'utf16',...review(rules,title,sellingPoints)};
    if (request.body.previewReplacements) {
      const newTitle=reviewCopy(title).preview;
      const newPoints=sellingPoints.map(point=>reviewCopy(point).preview);
      result.preview={title:newTitle,sellingPoints:newPoints,...review(rules,newTitle,newPoints)};
    }
    return result;
  });
}
