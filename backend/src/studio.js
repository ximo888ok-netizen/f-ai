
import { readFile } from 'node:fs/promises';
import { notFound } from './http.js';

const directory = new URL('../../前端设计审查/', import.meta.url);
const styles = ['studio.css', 'creation.css', 'commerce.css', 'glass.css', 'workspace.css', 'themes.css', 'theme-palettes.css', 'components.css', 'live.css', 'merchant.css', 'live-depth.css', 'live-spatial.css', 'live-light.css', 'live-agent.css', 'liquid-glass.css', 'liquid-layout.css', 'studio-wallpaper.css', 'workbench-layout.css'];
const scripts = ['live-light.js', 'live-spatial.js', 'live-navigation.js', 'live-home.js', 'live-agent-home.js', 'live-agent-dialogue.js', 'live-agent-tools.js', 'live-agent-model.js', 'live-asset-preview.js', 'live-task-fields.js', 'live-catalog.js', 'studio-session.js', 'studio-appearance.js', 'studio-errors.js', 'live-ui.js', 'merchant.js', 'merchant-ui.js', 'merchant-team.js', 'merchant-projects.js', 'merchant-settings.js', 'themes.js', 'glass.js', 'theme-motion.js', 'live.js', 'live-workspace.js', 'live-tasks.js', 'live-customer.js', 'live-products.js', 'live-drafts.js', 'live-operations.js', 'operations-file.js', 'live-psd.js', 'live-connectors.js',
  'live-popover.js', 'live-account-menu.js', 'live-capability-center.js', 'live-data-center.js', 'live-agent-controls.js',
  'live-rights.js', 'live-skills.js', 'live-copy-review.js', 'live-files.js', 'live-media.js', 'live-media-controls.js',
  'live-image-studio.js', 'live-storyboards.js', 'live-task-stream.js', 'live-knowledge-tools.js', 'live-experts.js', 'merchant-credit-limit.js', 'merchant-readiness.js', 'live-copy-suggestions.js', 'live-record-tools.js', 'live-task-intake.js', 'live-task-edit.js', 'live-onboarding.js', 'live-text-delivery.js', 'live-nav-search.js', 'live-commerce-report.js', 'live-settings.js', 'live-task-trace.js', 'live-voice.js', 'liquid-glass.js', 'studio-wallpaper.js'];
const types = new Map([
  ...styles.map(name => [name, 'text/css; charset=utf-8']),
  ...scripts.map(name => [name, 'text/javascript; charset=utf-8']),
]);
const security = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export function registerStudio(app) {
  const schema = { hide: true };
  const page = file => async (_request, reply) => reply
    .header('content-security-policy', security).header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8').send(await readFile(new URL(file, directory)));
  app.get('/', { schema }, page('打开设计稿.html'));
  app.get('/merchant', { schema }, page('商家管理后台.html'));
  app.get('/studio/assets/:name', { schema }, async (request, reply) => {
    const { name } = request.params;
    if (!['aurora.webp', 'optic-wave.webp', 'studio-wallpaper.webp'].includes(name)) throw notFound('Studio artwork');
    return reply.type('image/webp').send(await readFile(new URL('assets/' + name, directory)));
  });
  app.get('/studio/:name', { schema }, async (request, reply) => {
    const { name } = request.params;
    const type = types.get(name);
    if (!type) throw notFound('Studio resource');
    return reply.type(type).send(await readFile(new URL(name, directory)));
  });
}
