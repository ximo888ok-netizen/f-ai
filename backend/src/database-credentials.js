import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const databaseAlias = /^[a-z][a-z0-9_-]{0,63}$/;
const keyIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const maxUrlBytes = 16384;
const unavailable = () => new Error('Dedicated database credential unavailable or invalid');
const validVersion = value => Number.isSafeInteger(value) && value > 0;

function filename(env, alias, version) {
  if (!databaseAlias.test(alias) || !validVersion(version) || !isAbsolute(env.DEDICATED_CREDENTIAL_DIR || '')) throw unavailable();
  return join(env.DEDICATED_CREDENTIAL_DIR, 'db-' + alias + '.v' + version + '.dbcred');
}

function base64(value, length) {
  if (typeof value !== 'string' || !value || value.length > maxUrlBytes * 2) throw unavailable();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw unavailable();
  return bytes;
}

function readKey(env, keyId) {
  if (!keyIdPattern.test(keyId) || typeof keyId !== 'string' || !isAbsolute(env.DEDICATED_CREDENTIAL_KEYS_FILE || '')) throw unavailable();
  const keys = JSON.parse(readFileSync(env.DEDICATED_CREDENTIAL_KEYS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  if (!Object.hasOwn(keys, keyId)) throw unavailable();
  return base64(keys[keyId], 32);
}

function context(alias, version, keyId) {
  return Buffer.from(JSON.stringify(['f-ai.dbcred', 1, alias, version, keyId]));
}

// Only connection options understood by both the service and its archive utilities.
const options = new Set(['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslcrl', 'sslcrldir', 'channel_binding', 'application_name']);
function checkUrl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxUrlBytes || /\s|[\x00-\x1f\x7f]/u.test(value)) throw unavailable();
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => !options.has(key))) throw unavailable();
  for (const part of [url.hostname, url.username, url.password, url.pathname]) {
    if (/[\x00-\x1f\x7f]/u.test(decodeURIComponent(part))) throw unavailable();
  }
  return value;
}

export function openCredential(env, alias, version) {
  try {
    const { format, keyId, iv, tag, data } = JSON.parse(readFileSync(filename(env, alias, version), 'utf8'));
    if (format !== 1) throw unavailable();
    const decipher = createDecipheriv('aes-256-gcm', readKey(env, keyId), base64(iv, 12), { authTagLength: 16 });
    decipher.setAAD(context(alias, version, keyId));
    decipher.setAuthTag(base64(tag, 16));
    return checkUrl(Buffer.concat([decipher.update(base64(data)), decipher.final()]).toString('utf8'));
  } catch { throw unavailable(); }
}

export function sealCredential(env, alias, version, keyId, value) {
  try {
    const target = filename(env, alias, version);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', readKey(env, keyId), iv, { authTagLength: 16 });
    cipher.setAAD(context(alias, version, keyId));
    const data = Buffer.concat([cipher.update(checkUrl(value), 'utf8'), cipher.final()]);
    const record = { format: 1, keyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const temporary = target + '.' + randomBytes(16).toString('hex') + '.tmp';
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(record));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // Publish a complete, immutable revision. A concurrent writer cannot overwrite it.
      linkSync(temporary, target);
    } finally { unlinkSync(temporary); }
  } catch { throw new Error('Cannot create dedicated credential revision. Check configuration and use an unused version.'); }
}

async function stdinUrl() {
  if (process.stdin.isTTY) throw unavailable();
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxUrlBytes + 2) throw unavailable();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

if (import.meta.main) {
  try {
    try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const [command, alias, ...args] = process.argv.slice(2);
    if (command === 'seal' && args.length === 2) {
      sealCredential(process.env, alias, Number(args[0]), args[1], await stdinUrl());
    } else if (command === 'rewrap' && args.length === 3) {
      const value = openCredential(process.env, alias, Number(args[0]));
      sealCredential(process.env, alias, Number(args[1]), args[2], value);
    } else {
      throw unavailable();
    }
    console.log('Dedicated credential revision created');
  } catch {
    console.error('Credential operation failed. Check the command, key file, input and revision.');
    process.exitCode = 1;
  }
}
