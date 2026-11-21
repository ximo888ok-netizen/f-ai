
import { createHash, randomUUID } from 'node:crypto';
import { row, rows } from './db.js';
import { ApiError, choice, invalid, notFound, object, page, paginate, route, text, uuid } from './http.js';

const tags = ['Assets'];
const mediaTypes = ['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'application/vnd.adobe.photoshop'];
const assetFields = 'id, name, media_type AS "mediaType", source, purpose, consent_reference AS "consentReference", consent_expires_at AS "consentExpiresAt", octet_length(data) AS "sizeBytes", created_at AS "createdAt"';
const maxBytes = 10 * 1024 * 1024;
const idParams = object({ id: uuid });

export function validMedia(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (mime === 'video/mp4' || mime === 'audio/mp4') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mime === 'audio/webm') return bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) &&
    bytes.subarray(4, 64).includes(Buffer.from('4282847765626d', 'hex'));
  if (mime === 'application/vnd.adobe.photoshop') return bytes.subarray(0, 4).toString('ascii') === '8BPS';
  return bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224);
}

export async function taskAssets(db, context, identifiers, capability) {
  const ids = [...new Set(identifiers)];
  if (ids.length < capability.minAssets) throw invalid('This capability requires ' + capability.minAssets + ' distinct assets');
  if (!ids.length) return [];
  const assets = await rows(db, 'SELECT id, media_type, consent_reference, consent_expires_at, octet_length(data) AS size FROM assets WHERE workspace_id = $1 AND account_id = $2 AND id = ANY($3::uuid[]) AND NOT rights_restricted', [context.workspaceId, context.accountId, ids]);
  if (assets.length !== ids.length) throw notFound('Asset');
  if (capability.requiresConsent && assets.some(asset => !asset.consent_reference || !asset.consent_expires_at || new Date(asset.consent_expires_at).getTime() <= Date.now())) {
    throw new ApiError(422, 'CONSENT_REQUIRED', 'A valid asset authorization and expiry are required');
  }
  if (assets.reduce((total, asset) => total + asset.size, 0) > 2 * maxBytes) {
    throw new ApiError(413, 'ASSET_LIMIT', 'Combined task assets exceed 20 MiB');
  }
  return ids;
}

export function registerAssets(app, db) {
  route(app, 'POST', '/v1/assets', {
    tags, summary: 'Explicitly upload media for a server-side task',
    body: object({
      name: text(200), mediaType: choice(...mediaTypes), source: text(200), purpose: text(200),
      consentReference: text(200), consentExpiresAt: { type: 'string', format: 'date-time' },
      dataBase64: { ...text(4 * Math.ceil(maxBytes / 3)), pattern: '^[A-Za-z0-9+/]+={0,2}$' },
    }, ['name', 'mediaType', 'source', 'purpose', 'dataBase64']),
  }, async (request, reply) => {
    const { name, mediaType, source, purpose, consentReference, consentExpiresAt, dataBase64 } = request.body;
    if (Boolean(consentReference?.trim()) !== Boolean(consentExpiresAt)) throw invalid('Supply both consentReference and consentExpiresAt');
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length > maxBytes) throw new ApiError(413, 'ASSET_LIMIT', 'Asset exceeds 10 MiB');
    if (!name.trim() || !source.trim() || !purpose.trim() || bytes.toString('base64') !== dataBase64 || !validMedia(bytes, mediaType)) {
      throw invalid('Invalid name, provenance, or media content');
    }
    const { workspaceId, accountId } = request.context;
    const asset = await row(db, 'INSERT INTO assets (id, workspace_id, account_id, name, media_type, source, purpose, consent_reference, consent_expires_at, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ' + assetFields, [randomUUID(), workspaceId, accountId, name.trim(), mediaType, source.trim(), purpose.trim(), consentReference?.trim() ?? null, consentExpiresAt ?? null, bytes]);
    reply.code(201);
    return asset;
  });

  route(app, 'GET', '/v1/assets', {
    tags, summary: 'List the current member’s uploaded assets', querystring: page,
  }, async request => ({
    items: await rows(db, 'SELECT ' + assetFields + ' FROM assets WHERE workspace_id = $1 AND account_id = $2 AND NOT rights_restricted ORDER BY created_at DESC, id LIMIT $3 OFFSET $4', [request.context.workspaceId, request.context.accountId, ...paginate(request.query)]),
  }));

  route(app, 'GET', '/v1/assets/:id', {
    tags, summary: 'Read metadata and SHA-256 for an owned asset', params: idParams,
  }, async request => {
    const asset = await row(db,`SELECT ${assetFields},encode(sha256(data),'hex') AS sha256
      FROM assets WHERE workspace_id=$1 AND account_id=$2 AND id=$3 AND NOT rights_restricted`,
      [request.context.workspaceId,request.context.accountId,request.params.id]);
    if (!asset) throw notFound('Asset');
    return asset;
  });

  route(app, 'GET', '/v1/assets/:id/content', {
    tags, summary: 'Download an owned asset', params: idParams,
  }, async (request, reply) => {
    const asset = await row(db, 'SELECT media_type, data FROM assets WHERE workspace_id = $1 AND account_id = $2 AND id = $3 AND NOT rights_restricted', [request.context.workspaceId, request.context.accountId, request.params.id]);
    if (!asset) throw notFound('Asset');
    const bytes = Buffer.from(asset.data);
    return reply.header('content-disposition','attachment')
      .header('x-content-sha256',createHash('sha256').update(bytes).digest('hex')).type(asset.media_type).send(bytes);
  });

  route(app, 'DELETE', '/v1/assets/:id', {
    tags, summary: 'Delete an uploaded asset', params: idParams,
  }, async (request, reply) => {
    try {
      const asset = await row(db, 'DELETE FROM assets WHERE workspace_id = $1 AND account_id = $2 AND id = $3 AND NOT rights_restricted RETURNING id', [request.context.workspaceId, request.context.accountId, request.params.id]);
      if (!asset) throw notFound('Asset');
    } catch (error) {
      if (['23001','23503'].includes(error.code) && ['studio_psd_documents_subject_asset_id_fkey','studio_psd_documents_background_asset_id_fkey'].includes(error.constraint)) {
        throw new ApiError(409,'ASSET_IN_PSD','The image is in use by a layered design');
      }
      if (['23001', '23503'].includes(error.code) && ['listing_draft_images_asset_id_fkey', 'listing_draft_variants_asset_id_fkey'].includes(error.constraint)) {
        throw new ApiError(409, 'ASSET_IN_DRAFT', 'The image is in use by a listing draft');
      }
      throw error;
    }
    reply.code(204).send();
  });
}
