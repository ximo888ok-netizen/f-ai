import { deskSections } from './studio-workflows.js';
import { customerPage } from './live-customer.js';
import { operationsPage } from './live-operations.js';
import { copyReviewPage } from './live-copy-review.js';
import { onboarding, bindOnboarding } from './live-onboarding.js';
import { date, generationModeTabs, h, heading, item, link, list, notice, panel, path } from './live-ui.js';
import { cardTitle } from './live-task-fields.js';
import { capabilityLinks } from './live-catalog.js';
import { bindImageGeneration, imageGenerationForm } from './image-generation/index.js';
import { mainImageCapabilityId } from './image-generation/options.js';
import { agentImagePlannerId } from './image-generation/agent.js';
import { assetPreview } from './live-asset-preview.js';
import { mountDisplay } from './live-spatial.js';
import { storyboards } from './live-storyboards.js';
import { videoPromptPage } from './live-video-prompt.js';
import { videoQuickPage } from './live-video-quick.js';
import { videoDirectorPage } from './live-video-director.js';

const taskStates = { queued:'排队中', running:'执行中', succeeded:'已完成', failed:'失败', cancelled:'已取消' };
const videoModes = [
  ['prompt', 'desk/video', '提示词成片'],
  ['quick', 'desk/video/quick', '智能快创'],
  ['director', 'desk/video/director', '智能导演'],
  ['skills','desk/video/skills','视频制作技能'],
];

function recentDrafts(drafts) {
  if (!drafts.length) {
    return panel('商品草稿', '<div class="live-resume"><div class="live-resume-copy">' +
      notice('还没有保存的商品草稿。') + link('新建商品草稿', 'drafts/new') +
      '</div><div class="live-draft-photo" data-empty-display aria-hidden="true"></div></div>');
  }
  const [latest, ...others] = drafts;
  return panel('继续编辑', '<div class="live-resume"><div class="live-resume-copy"><h3>' + h(latest.title) + '</h3>' +
    notice('拼多多商品草稿 · ' + date(latest.updatedAt)) + link('继续编辑这份草稿', 'drafts/' + path(latest.id)) +
    '</div><div class="live-draft-photo" data-draft-photo></div></div>' +
    (others.length ? '<details class="live-fold"><summary>其他最近草稿（' + others.length + '）</summary>' +
      others.map(d => item(d.title, date(d.updatedAt), link('继续编辑', 'drafts/' + path(d.id)))).join('') + '</details>' : ''));
}

function videoDesk(ctx, plugin, wallet, tools, render, planning, tasks) {
  const [mode, route] = videoModes.find(([id]) => id === ctx.args[1]) ?? videoModes[0];
  const tabs = generationModeTabs('视频生成模式', videoModes, mode);
  const embedded = { ...ctx, html: body => render('<div class="live-video-generation">' + tabs +
    '<div class="live-video-workflow">' + body + '</div></div>' +
    '<details class="live-fold"><summary>更多视频工具</summary><div class="live-row">' +
    link('视频导出', 'media/video') + '</div>' + tools + '</details>') };
  if(mode==='skills')return import('./media-skill-desk.js').then(m=>m.mediaSkillDesk(embedded,plugin,wallet,ctx.args[2]));
  if (mode === 'director') {
    const id = ctx.args[2];
    if (!id) return videoDirectorPage(embedded, plugin, wallet, planning, tasks, route + '/storyboards');
    return storyboards(embedded, id === 'storyboards' ? undefined : id,
      '<div class="live-row">' + link('返回智能导演', route) + '</div>', route);
  }
  if (mode === 'prompt') return videoPromptPage(embedded, plugin, wallet, planning, tasks, taskStates);
  return videoQuickPage(embedded, plugin, wallet, planning, tasks);
}

export async function dashboard(ctx) {
  const current = Object.hasOwn(deskSections, ctx.args[0]) ? ctx.args[0] : 'image';
  const section = deskSections[current];
  const operations = current === 'operations';
  const [wallet, catalog, tasks, messages, drafts, settings] = await Promise.all([
    ctx.api('/v1/credits/wallet'), ctx.api('/v1/plugins'), ctx.api('/v1/tasks?limit=30'),
    ctx.api('/v1/notifications?limit=1'),
    operations ? ctx.api('/v1/studio/pinduoduo-drafts?limit=3') : null,
    operations ? ctx.api('/v1/settings') : null,
  ]);
  if (!ctx.active()) return;
  const capabilityNames = new Map([...catalog.items, catalog.models].flatMap(plugin =>
    plugin.capabilities.map(c => [c.id, cardTitle(c)])));
  const plugin = catalog.items.find(entry => entry.id === current);
  const recent = tasks.items.filter(task => task.pluginId === current).slice(0, 5);
  const links = (section.links ?? []).map(([label, route]) => link(label, route)).join('');
  const tools = plugin?.capabilities.length ? '<div class="live-catalog-grid">' + capabilityLinks(plugin, ctx).join('') + '</div>'
    : notice('当前分类暂无已登记的能力。');
  const imageGeneration = current === 'image';
  const mainImage = plugin?.capabilities.find(entry => entry.id === mainImageCapabilityId);
  const mode = ['advanced', 'agent'].includes(ctx.args[1]) ? ctx.args[1] : 'quick';
  const planning = catalog.models.capabilities.find(entry => entry.id === agentImagePlannerId);
  const render = (content, embedded = false) => ctx.html('<div class="live-desk-stage">' +
    (embedded ? content : heading(section.label) + content) + '</div>' +
    '<div class="live-desk-lower">' +
    '<div>' + (operations ? recentDrafts(drafts.items) : '') +
    panel('近期' + section.label + '任务', list(recent, t => '<div class="live-task-line"><div><strong>' +
      h(capabilityNames.get(t.capabilityId) ?? t.capabilityId) + '</strong>' +
      '<p class="live-muted"><span class="task-state-dot" data-state="' + h(t.state) + '">' +
      h(taskStates[t.state] ?? t.state) + '</span> · ' + h(date(t.createdAt)) + '</p></div>' +
      link('查看任务', 'tasks/' + path(t.id)) + '</div>', tasks.items.length === 30
        ? '最近 30 个工作区任务中没有此插件的记录。' : '此插件暂无任务。')) + '</div>' +
    '<div class="live-desk-tools"><div class="live-account-strip">' + link('可用 ' + wallet.available + ' 积分 · 预占 ' + wallet.reserved, 'account') +
    link('消息 · ' + messages.unread + ' 条未读', 'inbox') + '</div>' +
    (operations ? onboarding(settings.preferences) : '') + '</div></div>');
  if (current === 'video') return videoDesk(ctx, plugin, wallet, tools, render, planning, tasks.items);
  if (imageGeneration) {
    if(ctx.args[1]==='skills'){
      const nav=generationModeTabs('图片生成模式',[['quick','desk/image','快速模式'],['advanced','desk/image/advanced','高级模式'],['agent','desk/image/agent','Agent 生图'],['skills','desk/image/skills','平台图片技能']],'skills');
      const {mediaSkillDesk}=await import('./media-skill-desk.js');
      return mediaSkillDesk({...ctx,html:body=>render(nav+body)},plugin,wallet,ctx.args[2]);
    }
    render(imageGenerationForm(wallet, mainImage, mode, planning) +
      '<details class="live-fold"><summary>更多图片工具</summary>' + tools + '</details>');
    bindImageGeneration(ctx, mainImage, wallet, planning);
    return;
  }
  const scene = { 'customer-service': customerPage, operations: operationsPage, copywriting: copyReviewPage }[current];
  const extra = '<details class="live-fold desk-extra"><summary>更多' + h(section.label) + '工具</summary>' +
    '<div class="live-row">' + links + '</div>' + tools + '</details>';
  await scene({ ...ctx, args: ctx.args.slice(1), html: body => render(body + extra, true) });
  if (!ctx.active()) return;
  if (!operations) return;
  bindOnboarding(ctx);

  if (!drafts.items.length) {
    mountDisplay(document.querySelector('[data-empty-display]'), ctx.signal);
    return;
  }
  const holder = document.querySelector('[data-draft-photo]');
  try {
    const draft = await ctx.api('/v1/studio/pinduoduo-drafts/' + path(drafts.items[0].id));
    const image = draft.images.find(i => i.role === 'main');
    if (ctx.active() && image) {
      await assetPreview(ctx, holder)(image.assetId, draft.title + '主图');
      mountDisplay(holder, ctx.signal);
    }
  } catch { /* The draft link stays available if its optional thumbnail cannot be read. */ }
}
