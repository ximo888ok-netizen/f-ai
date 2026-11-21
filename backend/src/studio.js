
import { readFile } from 'node:fs/promises';
import { notFound } from './http.js';

const directory = new URL('../../前端设计审查/', import.meta.url);
const styles = ['studio.css', 'creation.css', 'commerce.css', 'glass.css', 'workspace.css', 'themes.css', 'components.css', 'live.css'];
const scripts = ['themes.js', 'glass.js', 'live.js', 'live-workspace.js', 'live-tasks.js', 'live-customer.js', 'live-products.js', 'live-drafts.js', 'live-operations.js', 'operations-file.js'];
const types = new Map([
  ...styles.map(name => [name, 'text/css; charset=utf-8']),
  ...scripts.map(name => [name, 'text/javascript; charset=utf-8']),
]);
const security = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export function registerStudio(app) {
  const schema = { hide: true };
  app.get('/', { schema }, async (_request, reply) => {
    const page = await readFile(new URL('打开设计稿.html', directory));
    return reply.header('content-security-policy', security).header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8').send(page);
  });
  app.get('/studio/assets/:name', { schema }, async (request, reply) => {
    const { name } = request.params;
    if (!['aurora.webp', 'optic-wave.webp'].includes(name)) throw notFound('Studio artwork');
    return reply.type('image/webp').send(await readFile(new URL('assets/' + name, directory)));
  });
  app.get('/studio/:name', { schema }, async (request, reply) => {
    const { name } = request.params;
    const type = types.get(name);
    if (!type) throw notFound('Studio resource');
    return reply.type(type).send(await readFile(new URL(name, directory)));
  });
}
