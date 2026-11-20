
import { loadEnvFile } from 'node:process';
import { config, isUuid } from './config.js';
import { migrate, postgres } from './db.js';
import { provisionCredits } from './wallet.js';

try {
  loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const [, , command, workspaceId, accountId, value, reference] = process.argv;
const settings = config();
const db = postgres(settings.databaseUrl);
try {
  if (command === 'migrate') {
    await migrate(db);
    console.log('Database migrations applied');
  } else if (command === 'credits') {
    const amount = Number(value);
    if (!isUuid(workspaceId) || !isUuid(accountId) || !Number.isInteger(amount) || amount < 1 || amount > 1000000
      || typeof reference !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(reference)) {
      throw new Error('Usage: npm run credits -- <workspace-id> <account-id> <amount> <external-reference>');
    }
    const wallet = await provisionCredits(db, workspaceId, accountId, amount, reference);
    console.log(JSON.stringify(wallet));
  } else {
    throw new Error('Use npm run migrate or npm run credits');
  }
} finally {
  await db.close();
}
