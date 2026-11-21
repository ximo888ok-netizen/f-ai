import { PGlite } from '@electric-sql/pglite';
import { buildApp } from './app.js';
import { migrate } from './db.js';
import { createProviders } from './providers.js';
import { startWorker } from './worker.js';

const port = Number(process.env.FAI_LOCAL_STUDIO_PORT ?? 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid FAI_LOCAL_STUDIO_PORT');

const db = new PGlite();
let app;
try {
  await migrate(db);
  const dependencies = { db, providers: createProviders(), shops: new Map() };
  app = await buildApp(dependencies);
  const location = await app.listen({ host: '127.0.0.1', port });
  const stopWorker = startWorker(dependencies, app.log);
  console.log('Studio demo ready at ' + location);
  async function shutdown() {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await Promise.all([app.close(), stopWorker()]);
    await db.close();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (err) {
  await app?.close();
  await db.close();
  throw err;
}
