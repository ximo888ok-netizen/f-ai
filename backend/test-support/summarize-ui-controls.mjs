import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [inputs, output] = process.argv.slice(2);
if (!inputs || !output) throw new Error('Expected coverage input and output directories');
const records = new Map(), checks = new Set(), traces = new Set();
async function collect(directory) {
  for (const item of await readdir(directory,{withFileTypes:true})) {
    const file = join(directory,item.name);
    if (item.isDirectory()) { await collect(file); continue; }
    if (item.name === 'actions.tap') {
      const tap = await readFile(file,'utf8');
      for(const match of tap.matchAll(/^# (?:UI action|Browser check passed): (.+)$/gm)) checks.add(match[1].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi,':id'));
      continue;
    }
    if (!item.name.endsWith('.json')) continue;
    const {suite,controls} = JSON.parse(await readFile(file,'utf8'));
    if (!Array.isArray(controls)) continue;
    traces.add(suite);
    for (const {view,action,control,clicks} of controls) {
      const key = JSON.stringify([view,action,control]);
      const row = records.get(key) ?? { view, action, control, clicks:0 };
      row.clicks += clicks;
      records.set(key,row);
    }
  }
}
await collect(inputs);
if (!records.size) throw new Error('Browser did not report any visible controls');
const controls=[...records.values()].sort((a,b)=>a.view.localeCompare(b.view)||a.action.localeCompare(b.action));
const commands=new Map();
for(const row of controls){
  const id=row.control ?? row.action;
  const command=commands.get(id) ?? {id,views:new Set(),clicks:0};
  command.views.add(row.view);
  command.clicks+=row.clicks;
  commands.set(id,command);
}
const distinctControls=[...commands.values()].map(({id,views,clicks})=>({id,views:[...views].sort(),clicks}));
const report = { suites:[...traces].sort(), trustedClicks:controls.reduce((n,r)=>n+r.clicks,0),
  observedViewControlPairs:controls.length, clickedViewControlPairs:controls.filter(r=>r.clicks).length,
  actionChecks:[...checks].sort(), distinctControls, controls };
await mkdir(output,{recursive:true});
await writeFile(join(output,'controls.json'), JSON.stringify(report,null,2));
const lines = ['# 工作台按钮验收', '',
  '测试使用合成账号与素材。每条已点击记录来自浏览器的可信点击事件。操作断言来自逐功能测试。',
  '', '共记录 '+report.trustedClicks+' 次点击。相同按钮出现在不同页面、状态或列表项时会分别记录。', '',
  '按同一控件标识合并，'+distinctControls.filter(row=>row.clicks).length+' / '+distinctControls.length+' 个标识收到了可信点击事件。', '',
  '## 操作断言', '', ...report.actionChecks.map(s=>'- '+s), '',
  '## 页面控件记录','','页面、控件、点击次数。0 表示本次观察到了控件，但该页面状态下没有记录到点击。','',
  '| 页面 | 控件 | 点击次数 |','| --- | --- | ---: |', ...controls.map(r=>'| '+[r.view,r.action].map(v=>v.replaceAll('|','\\|')).join(' | ')+' | '+r.clicks+' |')];
await writeFile(join(output,'buttons.md'),lines.join('\n')+'\n');
console.log('Trusted clicks: '+report.trustedClicks+'; labelled action checks: '+report.actionChecks.length+'; browser suites: '+report.suites.length);
