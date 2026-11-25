import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isUuid } from './config.js';

export const commercePlatforms = ['taobao', 'doudian', 'jd', 'kuaishou', 'xiaohongshu', 'weixin_store', 'oceanengine', 'youzan', 'pinduoduo'];

function shopCredentials(platform, value) {
  if (!value) return null;
  const fields = JSON.parse(value);
  const tokenOnly = ['weixin_store','oceanengine','youzan'].includes(platform);
  const required = tokenOnly ? ['access_token'] : ['access_token','app_key','app_secret'];
  if (platform === 'doudian') required.push('shop_id');
  if (platform === 'kuaishou') required.push('sign_secret');
  const allowed = new Set([...required,'app_key','app_secret']);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
      Object.keys(fields).some(k => !allowed.has(k))) throw new Error('Invalid shop credential snapshot');
  return required.every(k => typeof fields[k] === 'string' && fields[k].trim()) &&
    Object.values(fields).every(v => typeof v === 'string') ? fields : null;
}

function absolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(name + ' must be an absolute path');
  return value;
}

function secretName(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value)) throw new Error('Invalid integration secret reference');
  return value;
}

function settings(entry, kind, env) {
  if (!entry) return null;
  const python = absolute(entry.python, kind + '.python');
  const source = kind === 'customer' ? absolute(entry.source, 'customer.source') : undefined;
  let model;
  if (entry.model) {
    const url = new URL(entry.model.baseUrl);
    const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if ((!loopback || url.protocol !== 'http:') && url.protocol !== 'https:') throw new Error('Invalid model endpoint scheme');
    if (url.search || url.hash || url.username || url.password || !entry.model.name?.trim()) throw new Error('Invalid integration model configuration');
    const key = entry.model.keyEnv ? env[secretName(entry.model.keyEnv)] : null;
    model = { baseUrl: url.href.replace(/\/$/, ''), name: entry.model.name, key: key || (loopback && !entry.model.keyEnv ? 'local' : null),
      provider: entry.model.provider ?? 'openai_compatible' };
  }
  const shops = new Map();
  for (const item of entry.shops ?? []) {
    if (!isUuid(item.workspaceId) || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) throw new Error('Invalid integration shop binding');
    const key = item.workspaceId.toLowerCase() + '/' + item.id;
    if (shops.has(key)) throw new Error('Duplicate integration shop binding');
    const shop = { id: item.id, workspaceId: item.workspaceId.toLowerCase(), name: item.name, platform: item.platform };
    if (kind === 'customer') {
      if (!['pinduoduo','douyin'].includes(item.platform) || ![item.shopId,item.accountId].every(v => typeof v === 'string' && /^[^|\x00]{1,100}$/.test(v))) throw new Error('Invalid Customer-Agent shop or account ID');
      Object.assign(shop, { database: absolute(item.database,'customer database'), shopId: item.shopId, accountId: item.accountId,
        allowHandoff:item.allowHandoff===true && item.platform==='douyin',
        historyDatabase: absolute(item.historyDatabase ?? item.database,'customer history database') });
    } else if (kind === 'commerce') {
      if (!commercePlatforms.includes(item.platform)) throw new Error('Invalid commerce platform');
      const value = env[secretName(item.credentialsEnv)];
      const credentials = shopCredentials(item.platform, value);
      if (item.platform === 'oceanengine' && !/^\d+$/.test(item.advertiserId ?? '')) throw new Error('A bound advertiser ID is required');
      if (item.expiresAt && !Number.isFinite(Date.parse(item.expiresAt))) throw new Error('Invalid shop authorization expiry');
      Object.assign(shop, { credentials, advertiserId: item.advertiserId, expiresAt: item.expiresAt });
    } else throw new Error('Content Agent does not take merchant credentials');
    shops.set(key, shop);
  }
  return { python, source, model, shops };
}

export function loadIntegrations(env = process.env) {
  if (!env.FAI_PLUGIN_INTEGRATIONS_FILE) return {};
  const input = JSON.parse(readFileSync(env.FAI_PLUGIN_INTEGRATIONS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  return Object.fromEntries(['customer','commerce','content'].map(kind => [kind, settings(input[kind], kind, env)]));
}
