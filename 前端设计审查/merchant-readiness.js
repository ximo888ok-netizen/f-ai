import { item, notice } from './live-ui.js';
import { describeError } from './studio-errors.js';

const checks=[
  ['模型登记','/v1/models',r=>r.items.length+' 个可选模型'],
  ['店铺授权','/v1/shops',r=>r.items.filter(s=>s.capabilities.length).length+' 个启用且有权限的店铺'],
  ['网盘绑定','/v1/cloud-assets/status',r=>r.available?'已配置':'未配置'],
  ['飞书绑定','/v1/channels/feishu?limit=1',r=>r.available?'已配置':'未配置'],
  ['视频处理','/v1/video-export/status',r=>r.available?'已启用':'未启用'],
  ['网页检索','/v1/search/web',r=>r.available?'已配置':'未配置'],
];
export function bindReadiness(ctx) {
  ctx.click('readiness',async()=>{
    const target=document.querySelector('[data-readiness-result]');target.textContent='正在读取工作区能力…';
    const results=await Promise.allSettled(checks.map(([,url])=>ctx.api(url)));
    if(!ctx.active())return;
    target.innerHTML=notice('读取时间 '+new Date().toLocaleString('zh-CN'))+results.map((r,i)=>
      item(checks[i][0],r.status==='fulfilled'?checks[i][2](r.value):'读取失败 · '+describeError(r.reason))).join('');
  });
}
