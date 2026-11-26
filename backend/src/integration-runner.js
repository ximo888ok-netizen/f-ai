import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ProviderError } from './providers.js';

const script = fileURLToPath(new URL('../integrations/bridge.py', import.meta.url));
export const generationTimeout = { customer: 90000, content: 300000 };
const allowedErrors = new Set(['INTEGRATION_DEPENDENCY_MISSING','OPERATION_UNSUPPORTED','SHOP_AUTH_REQUIRED','INVALID_UPSTREAM_PARAMETERS',
  'UPSTREAM_REJECTED','INVALID_PROVIDER_RESULT','UPSTREAM_UNAVAILABLE','MODEL_NOT_CONFIGURED']);

export function runIntegration(config, kind, action, input = {}) {
  const env = { LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' };
  for (const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','LANG','SSL_CERT_FILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = execFile(config.python, ['-I','-X','utf8',script], {
      env, cwd: tmpdir(), windowsHide: true, timeout: action === 'generate' ? generationTimeout[kind] : 45000,
      maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) return reject(new ProviderError(error.code === 'ENOENT' ? 'INTEGRATION_DEPENDENCY_MISSING' : 'UPSTREAM_UNAVAILABLE'));
      try {
        const result = JSON.parse(stdout);
        if (!result.ok) throw new ProviderError(allowedErrors.has(result.error) ? result.error : 'UPSTREAM_REJECTED');
        resolve(result.data);
      } catch (failure) {
        reject(failure instanceof ProviderError ? failure : new ProviderError('INVALID_PROVIDER_RESULT'));
      }
    });
    child.stdin.on('error', () => {}); // Process startup and early exits are reported by the callback.
    child.stdin.end(JSON.stringify({ kind, action, source: config.source, ...input }));
  });
}
