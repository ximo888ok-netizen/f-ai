import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from './app.js';
import { migrate } from './db.js';
import { createProviders } from './providers.js';
import { startWorker } from './worker.js';
import { createVideoDelivery } from './video-delivery.js';
import { createRealtimeBindings } from './realtime-provider.js';
import { createSmsBindings } from './tencent-sms.js';

const port = Number(process.env.FAI_LOCAL_STUDIO_PORT ?? 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid FAI_LOCAL_STUDIO_PORT');

const stateDir = process.env.FAI_DESKTOP_STATE_DIR;
if (stateDir) {
  if (!isAbsolute(stateDir)) throw new Error('FAI_DESKTOP_STATE_DIR must be an absolute path');
  await mkdir(stateDir,{recursive:true});
}
const db = new PGlite(stateDir ? join(stateDir,'database') : undefined);
let app;
try {
  await migrate(db);
  const dependencies = { db, providers: createProviders(), shops: new Map(), realtimeVoice:createRealtimeBindings(),sms:createSmsBindings() };
  app = await buildApp({...dependencies,videoDelivery:createVideoDelivery(),loopbackOnly:Boolean(stateDir)});
  const location = await app.listen({ host: '127.0.0.1', port });
  const stopWorker = startWorker(dependencies, app.log);
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    process.stdin.pause();
    await Promise.all([app.close(), stopWorker()]);
    await db.close();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (stateDir) {
    process.stdin.once('end', shutdown);
    process.stdin.resume();
  }
  console.log('Studio ' + (stateDir ? 'desktop' : 'demo') + ' ready at ' + location);
} catch (err) {
  await app?.close();
  await db.close();
  throw err;
}
