
import { loadEnvFile } from 'node:process';
import { buildApp } from './app.js';
import { config } from './config.js';
import { postgres } from './db.js';
import { createProviders } from './providers.js';
import { installModels } from './models.js';
import { startWorker } from './worker.js';
import { createExaSearch } from './web-search.js';
import { createVideoArchive } from './video-archive.js';
import { assertControlDatabase } from './workspace-database.js';
import { createFeishuBindings } from './feishu.js';
import { createWebdavBindings } from './webdav.js';

try {
  loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const settings = config();
const feishu=createFeishuBindings();
const cloudAssets=createWebdavBindings();
const db = postgres(settings.databaseUrl);
await assertControlDatabase(db);
const dedicatedDatabases = new Map([...settings.dedicatedDatabases].map(([key,url])=>[key,postgres(url)]));
const providers = installModels(createProviders(settings.gateway), settings.models);
const dependencies = { db, providers, shops: settings.shops, feishu, videoArchive: createVideoArchive(settings.videoArchiveOrigins) };
const app = await buildApp({ ...dependencies, dedicatedDatabases, cloudAssets, origins: settings.origins, webSearch:createExaSearch(process.env.EXA_API_KEY), logger: true });
await app.listen({ port: settings.port, host: settings.host });
const workers = [startWorker(dependencies,app.log), ...[...dedicatedDatabases.keys()].map(key =>
  startWorker({...dependencies,identityDb:db,resolveDatabase:()=>app.workspaceDatabaseRouter.workerDatabase(key)},app.log))];
async function shutdown() {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  await Promise.all([app.close(), ...workers.map(stop=>stop())]);
  await Promise.all([db.close(), ...[...dedicatedDatabases.values()].map(pool=>pool.close())]);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
