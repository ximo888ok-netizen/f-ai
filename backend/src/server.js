
import { loadEnvFile } from 'node:process';
import { buildApp } from './app.js';
import { config } from './config.js';
import { postgres } from './db.js';
import { createProviders } from './providers.js';
import { installModels } from './models.js';
import { startWorker } from './worker.js';
import { createExaSearch } from './web-search.js';
import { createVideoArchive } from './video-archive.js';

try {
  loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const settings = config();
const db = postgres(settings.databaseUrl);
const providers = installModels(createProviders(settings.gateway), settings.models);
const dependencies = { db, providers, shops: settings.shops, videoArchive: createVideoArchive(settings.videoArchiveOrigins) };
const app = await buildApp({ ...dependencies, origins: settings.origins, webSearch:createExaSearch(process.env.EXA_API_KEY), logger: true });
await app.listen({ port: settings.port, host: settings.host });
const stopWorker = startWorker(dependencies, app.log);
async function shutdown() {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  await Promise.all([app.close(), stopWorker()]);
  await db.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
