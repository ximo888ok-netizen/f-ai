
import { loadEnvFile } from 'node:process';
import { buildApp } from './app.js';
import { config } from './config.js';
import { postgres } from './db.js';
import { createProviders } from './providers.js';
import { startWorker } from './worker.js';

try {
  loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const settings = config();
const db = postgres(settings.databaseUrl);
const providers = createProviders(settings.gateway);
const dependencies = { db, providers, shops: settings.shops };
const app = await buildApp({ ...dependencies, origins: settings.origins, logger: true });
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
