
import { buildApp } from './app.js';

const app = await buildApp({ db: null });
try {
  await app.ready();
  process.stdout.write(JSON.stringify(app.swagger(), null, 2) + '\n');
} finally {
  await app.close();
}
