import { action, date, field, form, grid, h, heading, input, item, link, list, notice, panel, retryKey, select, textarea } from './live-ui.js';
import { describeError } from './studio-errors.js';

const flags = {taskNotifications:'接收任务消息', memberNotifications:'接收成员变更消息', rememberConversations:'在当前标签页记住首页对话'};
const label = value => ({ ok:'正常', degraded:'需检查', unavailable:'不可用' }[value] ?? value);
function metrics(d) {
  const values = [['数据库',label(d.database)],['文件系统',label(d.filesystem)],['运行时',d.runtime ?? d.nodeVersion],
    ['本地存储', d.storage],['运行时长', d.uptimeSeconds == null ? null : d.uptimeSeconds + ' 秒'],
    ['常驻内存', d.memoryBytes == null ? null : (Number(d.memoryBytes)/1048576).toFixed(1)+' MiB'],
    ['累计 CPU 时间', d.cpuMilliseconds == null ? null : d.cpuMilliseconds+' 毫秒']];
  return '<dl class="live-facts">'+values.filter(([,v])=>v!=null).map(([k,v])=>'<dt>'+h(k)+'</dt><dd>'+h(v)+'</dd>').join('')+'</dl>';
}
export async function settings(ctx) {
  const [{preferences}, feedback] = await Promise.all([ctx.api('/v1/settings'),ctx.api('/v1/feedback?limit=10')]);
  ctx.html(heading('设置与诊断')+'<div class="live-row">'+action('外观主题','appearance')+link('个人资料与积分','account')+link('个人记忆','resources/memory/personal')+action('查找功能（Ctrl / ⌘ + K）','find-navigation')+'</div>'+
    grid(panel('工作区偏好',form('settings',Object.entries(flags).map(([key,name])=>field(name,
      input(key,'type="checkbox" '+((preferences[key]??true)?'checked':'')))).join(''))),
      panel('服务诊断',action('检查服务和数据库','check')+'<div id="checks" aria-live="polite"></div>'))+
    '<details class="card live-panel live-fold"><summary>意见反馈</summary>'+
    form('feedback',field('类别',select('category',[['issue','使用问题'],['suggestion','功能建议']]))+
      field('内容',textarea('message','required maxlength="4000"')),'提交反馈')+
    '<h3>最近提交</h3>'+list(feedback.items,f=>item(f.category==='issue'?'使用问题':'功能建议',date(f.createdAt),notice(f.message)),'暂无反馈。')+'</details>');
  ctx.click('appearance',()=>document.querySelector('[data-theme-open]')?.click());
  ctx.submit('settings',async data=>{
    const values=Object.fromEntries(Object.keys(flags).map(k=>[k,data.has(k)]));
    await ctx.api('/v1/settings',{method:'PATCH',body:values});
    if (!values.rememberConversations) {
      const key='fai.agent.home.v1:'+ctx.account.id+':'+ctx.workspace.id;
      try {sessionStorage.removeItem(key);sessionStorage.removeItem(key+':history');} catch {}
    }
    ctx.reload();
  });
  const key=retryKey();
  ctx.submit('feedback',async data=>{
    const values={category:data.get('category'),message:data.get('message').trim()};
    await ctx.api('/v1/feedback',{method:'POST',body:{...values,id:key(values)}});
    ctx.reload();
  });
  ctx.click('check',async()=>{
    const requests=[['运行状态','/health'],['数据库与迁移','/ready']];
    if(ctx.manager)requests.push(['资源诊断','/v1/diagnostics'],['工作区数据库','/v1/workspace/database']);
    const area=document.querySelector('#checks');area.textContent='正在检查…';
    const results=await Promise.allSettled(requests.map(([,url])=>ctx.api(url,url.startsWith('/v1/')?{}:{auth:false})));
    if(ctx.active())area.innerHTML=results.map((r,i)=>r.status==='rejected'?item(requests[i][0],describeError(r.reason)):
      i===2?metrics(r.value):i===3?item('工作区数据库',({shared:'共享实例',dedicated:'独立实例',local:'本机数据库'}[r.value.mode]??r.value.mode)+' · '+({ready:'就绪',preparing:'准备中',unavailable:'不可用'}[r.value.state]??r.value.state)):item(requests[i][0],label(r.value.status))).join('');
  });
}
