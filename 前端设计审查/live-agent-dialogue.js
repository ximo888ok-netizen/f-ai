import { findImages, findProducts, recentDrafts, recentTasks, renderCover, saveDraft } from './live-agent-tools.js';
import { interpret, referencedChat } from './live-agent-model.js';

const help = '我可以查商品、查最近任务、列出草稿、查询可用积分，也可以裁切商品主图、用图片建立商品草稿。试试「查商品：托特包」。';
const clean = s => s.replace(/^[\s：:“”「」『』"']+|[\s。！？?！“”「」『』"']+$/gu, '').trim();
const ordinals = '一二三四五六';
function ordinal(input) {
  const match = input.match(/(?:第|选(?:择)?\s*)?([1-6一二三四五六])(?:个|款|张|项|号)?/u);
  return match ? (/\d/.test(match[1]) ? Number(match[1]) - 1 : ordinals.indexOf(match[1])) : -1;
}
function coverSize(text) {
  const pair = text.match(/(\d+)\s*[×xX＊*]\s*(\d+)/u);
  if (pair) return [Number(pair[1]), Number(pair[2])];
  const one = text.match(/(\d+)\s*(?:像素|px)/iu);
  return one ? [Number(one[1]), Number(one[1])] : [800, 800];
}
const validSize = dimensions => dimensions.every(n => n >= 32 && n <= 1920);
const coverReview = job => ({ text: '素材：' + job.image.name + '\n将居中裁切为 ' + job.width + ' × ' + job.height + ' 的 PNG 主图，原图保留。回复「开始出图」即可执行。' });
function titleFrom(input) {
  const quoted = input.match(/[「『“"']([^」』”"']+)[」』”"']/u);
  if (quoted) return clean(quoted[1]);
  const after = input.match(/草稿(?:[，,：:\s]*(?:标题(?:为|是)?|叫作?|名为|名称是)\s*|[：:]\s*)(.+)$/u);
  if (after) return clean(after[1]);
  const before = input.match(/(?:给|为|把)\s*(.+?)\s*(?:新建|创建|建|做|存)(?:立|成|为|一份|一个|个)?(?:商品|上新)?草稿/u);
  return before && !/^(?:这个|这款|第[\d一二三四五六])/.test(before[1]) ? clean(before[1]) : '';
}
function localIntent(input) {
  input = input.replace(/^(?:(?:麻烦你|麻烦|请你|请|帮我|给我|我想要|我想|能不能)\s*)+/u, '').trim();
  if (/^(?:不要|别|先别|不想|取消)|删除|批量发布|下架/.test(input)) return { action: 'help' };
  if (/草稿/.test(input) && /新建|创建|建(?:立|个|一|成|商品|草稿)|做(?:个|一|成)|生成|起草|存(?:成|为)/.test(input)) return { action: 'draft', value: titleFrom(input) };
  if (/草稿/.test(input) && /查|看|列|最近|哪些|所有|^草稿$/.test(input)) return { action: 'drafts' };
  if (/裁切|裁剪|裁成|方形主图|调整尺寸/.test(input) && /图|尺寸|\d\s*[x×*]/i.test(input)) return { action:'cover', value:input };
  if (/主图|素材/.test(input) && /选择|引用|选图|选.*主图/.test(input)) return { action: 'images' };
  if (/积分|余额/.test(input) && !/分配|充值|转/.test(input)) return { action: 'balance' };
  if (/任务/.test(input) && /最近|列|查|看|哪些|失败|成功|完成|排队|执行中|取消的|^任务$/.test(input)) {
    const state = [['失败','failed'],['取消','cancelled'],['排队','queued'],['执行中','running'],['成功','succeeded'],['已完成','succeeded']].find(([word])=>input.includes(word));
    return { action: 'tasks', value: state?.[1] ?? '' };
  }
  const search = input.match(/(?:搜索|查询|查找|查看|查|找)(?:一下|下|找)?(?:我的|一下)?\s*(?:商品|货品|SKU)\s*[：:]?(.*)/iu);
  if (search) return { action: 'products', value: clean(search[1]) };
  if (/(?:有哪些|哪些|列出|看看|所有|全部)(?:我的|当前)?商品|^商品[清单列表]*$/u.test(input)) return { action: 'products', value: '' };
  const find = input.match(/^(?:搜一下|搜索|查找|查一下|查下|找一下|找找)\s*(.+)$/u);
  if (find) return { action:'products', value:clean(find[1]) };
  return null;
}

async function pickImage(ctx, thread, query = '') {
  thread.images = await findImages(ctx, query);
  if (!thread.images.length) return { text: query ? '没有找到这张图片，可以换个名称再选，或直接上传主图。' : '素材库里还没有可用的主图。可以在当前对话直接上传 JPEG 或 PNG 图片。',
    items: [{ title: '打开素材库', route: 'assets' }] };
  return { text: '选一张商品主图，或回复它的序号。' };
}
function draftReview(draft) {
  return { text: '草稿标题：' + draft.title + '\n主图：' + draft.image.name + (draft.product ? '\n商品 SKU：' + draft.product.sku : '') +
    '\n确认后保存。也可以说「标题改为……」。' };
}
async function nextDraftStep(ctx, thread) {
  if (!thread.draft.title) return { text: '这份商品草稿叫什么名字？' };
  if (!thread.draft.image) return pickImage(ctx, thread);
  return draftReview(thread.draft);
}

export function attachImage(ctx, thread, image) {
  thread.attachment = image;
  thread.images = null;
  if (thread.cover) { thread.cover.image = image; return coverReview(thread.cover); }
  if (thread.draft) { thread.draft.image = image; return nextDraftStep(ctx, thread); }
  return { text: '已引用「' + image.name + '」。接下来可以说「新建草稿」。' };
}

export async function respond(ctx, thread, raw, options = {}) {
  const input = raw.trim();
  const destinations = { '生产工作台':'desk', '素材库':'assets', '商品档案':'products', '任务记录':'tasks',
    '图片处理':'media/images', '商品草稿':'drafts', '创作台':'create', '我的项目':'projects', ...ctx.navigation };
  const open = input.match(/^(?:请帮我|请|帮我|麻烦)?(?:打开|进入|带我去|前往|切换到)(?:一下)?\s*(.+?)[。！]?$/u);
  if (open && Object.hasOwn(destinations, open[1])) {
    return { text:'正在打开' + open[1] + '。', navigateTo:destinations[open[1]], items:[{ title:open[1], route:destinations[open[1]] }] };
  }
  if (/^(取消|算了|放弃)[。！]?$/u.test(input)) {
    thread.draft = null; thread.cover = null; thread.images = null; thread.seeking = false;
    return { text: '已结束当前操作。' };
  }
  if (thread.images?.length) {
    const index = /^(?:选(?:择)?|用)?\s*(?:第)?[1-6一二三四五六](?:个|款|张|号)?[。！]?$/u.test(input) ? ordinal(input) : -1;
    const image = thread.images[index] ?? thread.images.find(a => a.name === input);
    if (image) return attachImage(ctx, thread, image);
  }
  if (thread.cover) {
    const job = thread.cover;
    if (/^(?:确认|确定|开始出图|开始处理|执行)[。！]?$/u.test(input) && job.image) {
      const output = await renderCover(ctx, job);
      thread.cover = null; thread.images = null; thread.attachment = output;
      return { text:'主图已保存到素材库，也已引用到当前对话。可以继续说「用这张图新建草稿」。',
        items:[{ title:output.name, detail:'查看成品', route:'media/images/new/' + encodeURIComponent(output.id) }] };
    }
    if (/\d+\s*[×xX＊*]\s*\d+/u.test(input)) {
      const size = coverSize(input);
      if (!validSize(size)) return { text:'请输入宽、高各为 32 到 1920 像素的尺寸。' };
      [job.width, job.height] = size;
    }
    if (!job.image || /(?:换|选择|引用).*主图/.test(input)) return pickImage(ctx, thread, thread.images && !/主图/.test(input) ? clean(input) : '');
    return coverReview(job);
  }
  if (thread.draft) {
    if (/^(?:保存|确认|确定|好|可以)(?:保存)?(?:草稿)?[。！]?$/u.test(input)) {
      if (!thread.draft.title || !thread.draft.image) return nextDraftStep(ctx, thread);
      const result = await saveDraft(ctx, thread.draft);
      thread.draft = null; thread.images = null; thread.attachment = null;
      return result;
    }
    if (/^(?:换|选择|更换|引用).*主图/.test(input)) return pickImage(ctx, thread);
    const change = input.match(/^(?:把)?(?:标题|名字|名称)?(?:改成|改为|改叫)[：:\s]*(.+)$/u);
    if (change || !thread.draft.title) {
      const title = clean(change ? change[1] : input);
      if (!title || title.length > 200) return { text:'请给我一个 1 到 200 字的草稿标题。' };
      thread.draft.title = title;
      return nextDraftStep(ctx, thread);
    }
    if (thread.images) return pickImage(ctx, thread, clean(input));
    return { text:'这份草稿仍待确认。可以保存、修改标题、更换主图，或回复「取消」。' };
  }
  const knowledge=input.match(/^(?:请|帮我|请帮我)?(?:查|搜|搜索|检索|查询)(?:一下)?知识库[：:\s]*(.+)$/u);
  if(knowledge){
    const query=clean(knowledge[1]);
    if(query.length>160)return {text:'检索词最多 160 字。'};
    const {items}=await ctx.api('/v1/knowledge/search',{method:'POST',body:{query,...(thread.knowledgeBase ? {baseIds:[thread.knowledgeBase.id]} : {})}});
    return {text:items.length?'以下是你有权访问的知识库出处。':'已授权知识库中没有找到匹配的文档。',items:items.slice(0,5).map(r=>({title:r.name,detail:r.baseName+' · '+r.snippet,route:'resources/'+encodeURIComponent(r.baseId)+'/'+encodeURIComponent(r.documentId)}))};
  }
  if (thread.references?.length) return {text:await referencedChat(ctx, thread, options.modelId, {onTask:options.onTask})};
  let plan = localIntent(input);
  if (!plan && thread.seeking) plan = { action: 'products', value: clean(input) };
  thread.seeking = false;
  if (!plan && options.model && thread.attachment) return {text:await referencedChat(ctx, thread, options.modelId, {onTask:options.onTask})};
  if (!plan && options.model) plan = await interpret(ctx, thread.messages, options.onTask, options.modelId);
  if (!plan && thread.images) return pickImage(ctx, thread, clean(input));
  if (!plan) return { text: help };
  if (plan.action !== 'images') thread.images = null;
  switch (plan.action) {
    case 'cover': {
      const size = coverSize(plan.value || '');
      if (!validSize(size)) return { text:'请输入宽、高各为 32 到 1920 像素的尺寸。' };
      thread.cover = { id:crypto.randomUUID(), width:size[0], height:size[1], image:thread.attachment ?? null };
      return thread.cover.image ? coverReview(thread.cover) : pickImage(ctx, thread);
    }
    case 'answer': return { text:'模型建议：' + plan.value };

    case 'products': {
      const response = await findProducts(ctx, plan.value ?? '');
      thread.products = response.items.map(i => i.product);
      if (!plan.value) thread.seeking = true;
      return response;
    }
    case 'tasks': return recentTasks(ctx, plan.value);
    case 'drafts': return recentDrafts(ctx);
    case 'images': return pickImage(ctx, thread);
    case 'balance': {
      const wallet = await ctx.api('/v1/credits/wallet');
      return { text:'可用积分 ' + wallet.available + '，预占 ' + wallet.reserved + '。', items:[{ title:'查看积分流水', route:'account' }] };
    }
    case 'draft': {
      const index = /第[1-6一二三四五六]/u.test(input) ? ordinal(input) : /这款|这个商品|上面.*商品/u.test(input) && thread.products?.length === 1 ? 0 : -1;
      const product = thread.products?.[index];
      if (index >= 0 && !product) return { text:'请先查商品，再告诉我用列表里的第几个建草稿。' };
      if ((plan.value ?? '').length > 200) return { text:'草稿标题最多 200 字，请缩短后再试。' };
      thread.draft = { id: crypto.randomUUID(), title: plan.value || product?.name || '', image: thread.attachment ?? null, product };
      thread.images = null;
      return nextDraftStep(ctx, thread);
    }
    default: return { text: help };
  }
}
