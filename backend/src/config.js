
import { readFileSync } from 'node:fs';
import { catalog } from './catalog.js';

export const isUuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);

export function config(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const origins = list(env.WEB_ORIGINS);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('WEB_ORIGINS entries must be exact HTTP(S) origins');
    }
  }
  const videoArchiveOrigins = list(env.VIDEO_ARCHIVE_ORIGINS);
  for (const origin of videoArchiveOrigins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) {
      throw new Error('VIDEO_ARCHIVE_ORIGINS entries must be exact HTTPS origins');
    }
  }
  if (env.MODEL_PROVIDERS_FILE && env.MODEL_PROVIDERS_JSON) throw new Error('Choose one model configuration source');
  const models = JSON.parse(env.MODEL_PROVIDERS_JSON || (env.MODEL_PROVIDERS_FILE ? readFileSync(env.MODEL_PROVIDERS_FILE, 'utf8').replace(/^\uFEFF/, '') : '[]'));
  const capabilities = list(env.GATEWAY_CAPABILITIES);
  if (capabilities.some(id => catalog.get(id)?.execution !== 'gateway')) {
    throw new Error('GATEWAY_CAPABILITIES contains an unsupported capability ID');
  }
  return {
    port, host: env.HOST || '127.0.0.1', databaseUrl: env.DATABASE_URL, origins,
    models, videoArchiveOrigins, dedicatedDatabases: loadDedicatedDatabases(env),
    gateway: { url: env.GATEWAY_URL, token: env.GATEWAY_TOKEN, capabilities },
    shops: loadShops(env.SHOP_BINDINGS_JSON),
  };
}

function loadDedicatedDatabases(env) {
  const entries = JSON.parse(env.DEDICATED_DATABASES_JSON || '{}');
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('DEDICATED_DATABASES_JSON must map database aliases to secret environment variable names');
  }
  const byAlias = new Map();
  if (!Object.keys(entries).length) return byAlias;
  const destination = url => [url.hostname.toLowerCase(), url.port || '5432', url.pathname].join('|');
  let control;
  try { control = new URL(env.DATABASE_URL); } catch { throw new Error('Invalid control database connection setting'); }
  const targets = new Set([destination(control)]);
  for (const [alias, name] of Object.entries(entries)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(alias) || typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
      throw new Error('Invalid dedicated database alias or secret variable name');
    }
    const secret = env[name];
    let parsed;
    try { parsed = new URL(secret); } catch { throw new Error('Missing or invalid dedicated database connection setting'); }
    if (!['postgresql:','postgres:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)
        || targets.has(destination(parsed))) {
      throw new Error('Dedicated connection settings must identify distinct PostgreSQL databases');
    }
    targets.add(destination(parsed));
    byAlias.set(alias,secret);
  }
  return byAlias;
}

function loadShops(value) {
  const entries = value ? JSON.parse(value) : [];
  if (!Array.isArray(entries)) throw new Error('SHOP_BINDINGS_JSON must contain an array');
  const shops = new Map();
  for (const shop of entries) {
    if (!shop || !isUuid(shop.id) || !isUuid(shop.workspaceId) || shops.has(shop.id)
      || typeof shop.name !== 'string' || !shop.name.trim() || shop.name.length > 120
      || typeof shop.gatewayReference !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(shop.gatewayReference)
      || !['taobao', 'pinduoduo', 'douyin'].includes(shop.platform)
      || !Array.isArray(shop.capabilities) || !shop.capabilities.length
      || shop.capabilities.some(id => catalog.get(id)?.pluginId !== 'operations' || catalog.get(id)?.execution !== 'gateway')) {
      throw new Error('SHOP_BINDINGS_JSON contains an invalid or duplicate shop binding');
    }
    shops.set(shop.id, shop);
  }
  return shops;
}
