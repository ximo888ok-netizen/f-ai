import { createHash } from 'node:crypto';
import { ApiError, array, object, route, text } from './http.js';
import { ProviderError } from './providers.js';
import { commercePlatforms } from './integration-config.js';
import { generationTimeout, runIntegration } from './integration-runner.js';
import { activeHandoffs, pauseNativeReplies, shopEvidence, shopHistory } from './customer-agent-store.js';
import { connectionEnabled } from './merchant-connections.js';
import { catalog } from './catalog.js';
import { deskShopEnabled, managedCommerceShop } from './desk-shops.js';

export const agentTools = {
  customer: { id: 'customer-agent', capability: 'customer-service.reply-draft', feature: 'customer-service' },
  content: { id: 'ecommerce-content-agent', capability: 'copywriting.content-package', feature: 'copywriting' },
  commerce: { id: 'mcp-cn-commerce', feature: 'operations' },
};

function checkedGeneration(kind, data, params) {
  if (kind === 'customer' && typeof data?.text === 'string' && data.text.trim()) return { text: data.text.trim(), engine: agentTools.customer.id };
  if (kind !== 'content' || data?.platform !== params.platform ||
    !['optimized_title','description','social_copy'].every(k => typeof data[k] === 'string' && data[k].trim()) ||
    ![data.selling_points,data.seo_keywords].every(a => Array.isArray(a) && a.length && a.every(v => typeof v === 'string' && v.trim()))) {
    throw new ProviderError('INVALID_PROVIDER_RESULT');
  }
  return { engine: agentTools.content.id, platform: data.platform, title: data.optimized_title,
    sellingPoints: data.selling_points, keywords: data.seo_keywords, description: data.description, socialCopy: data.social_copy, score: data.quality_score,
    text: [data.optimized_title, ...data.selling_points, data.description, data.social_copy, data.seo_keywords.join('、')].join('\n\n') };
}

export async function installIntegrations(providers, config, invoke = runIntegration) {
  const runtimes = {};
  await Promise.all(Object.entries(agentTools).map(async ([kind, tool]) => {
    const settings = config[kind];
    if (!settings) { runtimes[kind] = { state: 'not_configured' }; return; }
    let capabilities;
    try { capabilities = await invoke(settings, kind, 'probe', { platforms: commercePlatforms }); }
    catch { runtimes[kind] = { state: 'runtime_unavailable' }; return; }
    runtimes[kind] = { state: 'ready', capabilities };
    if (kind === 'commerce') return;
    if (!settings.model?.key) { runtimes[kind].state = 'model_unconfigured'; return; }
    const info = { id: tool.id, model: settings.model.name, kind: 'text', protocol: tool.id,
      capabilities: [tool.capability], streamText: false, imageQuality: false };
    if (providers.has('model:' + info.id)) throw new Error('Duplicate integration model alias: ' + info.id);
    providers.set('model:' + info.id, {
      info, nonRepeatable: true, runTimeoutMs: generationTimeout[kind],
      signature: createHash('sha256').update(JSON.stringify([info,settings.model.baseUrl,settings.python,settings.source])).digest('hex'),
      supports: capability => capability.id === tool.capability,
      async run(_task, { parameters }) {
        const data = await invoke(settings, kind, 'generate', { model: settings.model, parameters });
        return checkedGeneration(kind, data, parameters);
      },
    });
  }));
  return runtimes;
}

function authorizedShop(settings, workspace, id) {
  const shop = settings?.shops.get(workspace.toLowerCase() + '/' + id);
  if (!shop) throw new ApiError(404, 'NOT_FOUND', '当前工作区没有这项店铺绑定。');
  return shop;
}

async function requireEnabledShop(db,workspace,id) {
  if (!await deskShopEnabled(db,workspace,id)) throw new ApiError(409,'CONNECTION_DISABLED','此店铺已停用。');
}

export function registerIntegrations(app, db, config, runtimes, invoke = runIntegration, shopAuth = null) {
  const tags = ['Workspace integrations'];
  for (const [kind, tool] of Object.entries(agentTools)) {
    route(app, 'GET', '/v1/integrations/' + tool.id, { tags, feature: tool.capability ?? tool.feature, summary: 'Read ' + tool.id + ' availability' }, async request => {
      const { workspaceId, role } = request.context;
      const runtime = runtimes[kind];
      const shops = [...(config[kind]?.shops.values() ?? [])].filter(s => role !== 'member' && s.workspaceId === workspaceId.toLowerCase());
      const state = tool.capability && runtime.state === 'ready' && !(await connectionEnabled(db, workspaceId, 'model', tool.id)) ? 'disabled' : runtime.state;
      return { engine: tool.id, state, cost: catalog.get(tool.capability)?.cost ?? 0, model: config[kind]?.model?.name ?? null,
        shops: await Promise.all(shops.map(async ({ id, name, platform, credentials, expiresAt }) => ({ id, name, platform,
          ...(kind === 'commerce' ? { authorized: Boolean(credentials) && !(expiresAt && Date.parse(expiresAt) <= Date.now()) &&
            await deskShopEnabled(db, workspaceId, id) } : {}) }))),
        ...(kind === 'commerce' ? { operations: runtime.capabilities ?? {} } : {}) };
    });
  }
  for (const [name, reader] of [['knowledge',shopEvidence],['history',shopHistory]]) {
    route(app, 'POST', '/v1/integrations/customer-agent/' + name, { tags, feature:'customer-service.answer', manager:true,
      summary:'Read bound Customer-Agent ' + name, body:object({ shopId:text(64), query:text(150) }) }, async req => {
      const shop = authorizedShop(config.customer, req.context.workspaceId, req.body.shopId);
      await requireEnabledShop(db,req.context.workspaceId,shop.id);
      const query = req.body.query.trim();
      if (!query) throw new ApiError(400,'INVALID_INPUT','请输入查询内容。');
      return reader(shop, query);
    });
  }
  for(const [name,write] of [['handoffs',false],['handoff',true]]) {
    route(app,'POST','/v1/integrations/customer-agent/'+name,{tags,manager:true,feature:'customer-service.handoff',
      body:write?object({shopId:text(64),buyerId:text(100)}):object({shopId:text(64)})},async req=>{
      const shop=authorizedShop(config.customer,req.context.workspaceId,req.body.shopId);
      await requireEnabledShop(db,req.context.workspaceId,shop.id);
      return write?pauseNativeReplies(shop,req.body.buyerId.trim()):activeHandoffs(shop);
    });
  }
  route(app, 'POST', '/v1/integrations/mcp-cn-commerce/report', { tags, feature:'operations.analysis', manager:true,
    summary:'Aggregate merchant-supplied order/refund records using the Core SDK',
    body: object({date:{type:'string',format:'date'},shops:array({type:'object',additionalProperties:true},20,1)}) }, async req => {
    if (runtimes.commerce.state !== 'ready') throw new ApiError(503,'INTEGRATION_UNAVAILABLE','经营 SDK 未就绪。');
    if (Buffer.byteLength(JSON.stringify(req.body)) > 512 * 1024) throw new ApiError(413,'PAYLOAD_TOO_LARGE','日报源文件上限为 512 KiB。');
    try { return await invoke(config.commerce,'commerce','report',req.body); }
    catch (err) {
      if (err.code === 'INVALID_UPSTREAM_PARAMETERS') throw new ApiError(422,err.code,'日报日期、店铺标识、记录或覆盖范围格式不正确。');
      throw new ApiError(502,'COMMERCE_REPORT_FAILED','经营 SDK 未能完成汇总。');
    }
  });
  route(app, 'POST', '/v1/integrations/mcp-cn-commerce/query', { tags, feature:'operations.analysis', manager:true,
    summary:'Call a documented read operation for one authorized shop',
    body:object({ shopId:text(64), operation:text(64), params:{ type:'object', maxProperties:32, additionalProperties:true } }) }, async req => {
    const shop = config.commerce?.shops.get(req.context.workspaceId.toLowerCase()+'/'+req.body.shopId) ??
      await managedCommerceShop(db,req.context.workspaceId,req.body.shopId,shopAuth);
    if (!shop) throw new ApiError(404,'NOT_FOUND','当前工作区没有这家店铺。');
    if (runtimes.commerce.state !== 'ready') throw new ApiError(503,'INTEGRATION_UNAVAILABLE','经营查询运行时未就绪。');
    if (!runtimes.commerce.capabilities[shop.platform]?.includes(req.body.operation)) throw new ApiError(422,'OPERATION_UNSUPPORTED','该版本未支持此平台操作。');
    if (!shop.credentials || (shop.expiresAt && Date.parse(shop.expiresAt) <= Date.now())) throw new ApiError(409,'SHOP_AUTH_REQUIRED','请配置或更新此店铺授权。');
    if (Buffer.byteLength(JSON.stringify(req.body.params)) > 16000) throw new ApiError(400,'INVALID_INPUT','查询参数过长。');
    await requireEnabledShop(db,req.context.workspaceId,shop.id);
    try {
      const data = await invoke(config.commerce, 'commerce', 'query', { platform:shop.platform, operation:req.body.operation,
        params:req.body.params, credentials:shop.credentials, advertiserId:shop.advertiserId });
      return { shop:shop.name, platform:shop.platform, operation:req.body.operation, data };
    } catch (error) {
      if (error.code === 'INVALID_UPSTREAM_PARAMETERS') throw new ApiError(422,error.code,'此平台不接受这些业务参数。');
      throw new ApiError(502,'COMMERCE_QUERY_FAILED','平台查询未完成，请核对店铺授权和业务参数。');
    }
  });
}
