
import { readFile } from 'node:fs/promises';
import { notFound } from './http.js';

const directory = new URL('../../前端设计审查/', import.meta.url);
const styles = ['native-glass-design.css', 'studio.css', 'creation.css', 'glass.css', 'themes.css', 'theme-palettes.css', 'components.css', 'live.css', 'merchant.css', 'live-depth.css', 'live-spatial.css', 'live-light.css', 'live-agent.css', 'liquid-glass.css', 'liquid-layout.css', 'studio-wallpaper.css', 'workbench-layout.css', 'image-generation/style.css', 'live-video-prompt.css', 'live-video-quick.css', 'live-video-director.css', 'studio-foundation.css', 'studio-entry.css', 'studio-workflows.css', 'dot-matrix-switch.css'];
const scripts = ['live-agent-integrations.js', 'live-commerce-sdk.js', 'studio-icons.js', 'studio-entry.js', 'studio-workflows.js', 'live-spatial.js', 'live-navigation.js', 'live-home.js', 'live-agent-home.js', 'live-agent-dialogue.js', 'live-agent-tools.js', 'live-agent-model.js', 'live-asset-preview.js', 'live-task-fields.js', 'live-catalog.js', 'studio-session.js', 'studio-appearance.js', 'studio-errors.js', 'live-ui.js', 'merchant.js', 'merchant-ui.js', 'merchant-team.js', 'merchant-projects.js', 'merchant-settings.js', 'themes.js', 'glass.js', 'theme-motion.js', 'live.js', 'live-workspace.js', 'live-tasks.js', 'live-customer.js', 'live-products.js', 'live-drafts.js', 'live-operations.js', 'operations-file.js', 'live-psd.js', 'live-connectors.js',
  'live-popover.js', 'live-account-menu.js', 'live-capability-center.js', 'live-data-center.js', 'live-agent-controls.js',
  'image-generation/index.js', 'image-generation/files.js', 'image-generation/options.js',
  'image-generation/results.js', 'image-generation/prompt-favorites.js', 'image-generation/agent.js',
  'live-video-prompt.js', 'live-video-prompt-view.js', 'live-video-prompt-options.js', 'live-video-prompt-media.js',
  'live-video-quick.js', 'live-video-quick-view.js', 'live-video-quick-media.js',
  'live-video-workflow.js', 'live-video-director.js', 'live-video-director-view.js', 'live-video-director-plan.js',
  'live-rights.js', 'live-skills.js', 'live-copy-review.js', 'live-files.js', 'live-media.js', 'live-media-controls.js',
  'live-image-studio.js', 'live-storyboards.js', 'live-task-stream.js', 'live-knowledge-tools.js', 'live-experts.js', 'merchant-credit-limit.js', 'merchant-readiness.js', 'live-copy-suggestions.js', 'live-record-tools.js', 'live-task-intake.js', 'live-task-edit.js', 'live-onboarding.js', 'live-text-delivery.js', 'live-nav-search.js', 'live-commerce-report.js', 'live-settings.js', 'live-task-trace.js', 'live-voice.js', 'liquid-glass.js', 'studio-wallpaper.js', 'dot-matrix-switch.js'];
const types = new Map([
  ...[...styles, 'scene-desk.css','media-skills.css'].map(name => [name, 'text/css; charset=utf-8']),
  ...[...scripts, 'desk-shops.js', 'desk-inbox.js', 'desk-channel.js','media-skill-desk.js','media-skill-assets.js','media-skill-output.js'].map(name => [name, 'text/javascript; charset=utf-8']),
]);
const security = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export function registerStudio(app) {
  const schema = { hide: true };
  const textResource = { schema, compress: { threshold: 1024 } };
  const page = file => async (_request, reply) => reply
    .header('content-security-policy', security).header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8').send(await readFile(new URL(file, directory)));
  app.get('/', textResource, page('ai.html'));
  app.get('/ai.html', textResource, page('ai.html'));
  app.get('/merchant', textResource, page('商家管理后台.html'));
  app.get('/studio/assets/:name', { schema }, async (request, reply) => {
    const { name } = request.params;
    if (!['optic-wave.webp', 'leather.webp', 'citrus.webp', 'audio.webp'].includes(name)) throw notFound('Studio artwork');
    const bytes = await readFile(new URL('assets/' + name, directory));
    return reply.header('cache-control', 'public, max-age=86400').type('image/webp').send(bytes);
  });
  const resource = (prefix, fixedName) => async (request, reply) => {
    const name = fixedName ?? prefix + request.params.name;
    const type = types.get(name);
    if (!type) throw notFound('Studio resource');
    const bytes = await readFile(new URL(name, directory));
    return reply.header('cache-control', 'public, max-age=300').type(type).send(bytes);
  };
  app.get('/native-glass-design.css', textResource, resource('', 'native-glass-design.css'));
  app.get('/studio/:name', textResource, resource(''));
  app.get('/studio/image-generation/:name', textResource, resource('image-generation/'));
}
