
import { loadEnvFile } from 'node:process';
import { config, isUuid } from './config.js';
import { backupDatabases, restoreDatabases } from './database-archive.js';
import { migrate, migrationFiles, postgres } from './db.js';
import { provisionCredits } from './wallet.js';
import { cutoverWorkspace } from './workspace-cutover.js';
import { assertControlDatabase, workspaceDatabaseRouter } from './workspace-database.js';

try {
  loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const [, , command, workspaceId, accountId, value, reference] = process.argv;
const settings = config();
if (command==='backup' || command==='restore-backup') {
  if (!workspaceId || (command==='backup'?accountId!==undefined:accountId!=='--confirm-empty-targets' || value!==undefined)) {
    throw new Error('Use backup <directory> or restore-backup <directory> --confirm-empty-targets');
  }
  const result=command==='backup'?await backupDatabases(settings,workspaceId):await restoreDatabases(settings,workspaceId);
  console.log(JSON.stringify(result));
} else {
  const db = postgres(settings.databaseUrl);
  const dedicatedDatabases = new Map([...settings.dedicatedDatabases].map(([key,url])=>[key,postgres(url)]));
  try {
    if (command === 'migrate') {
      await migrate(db);
      await assertControlDatabase(db);
      for (const pool of dedicatedDatabases.values()) await migrate(pool);
      console.log('Database migrations applied');
    } else if (command === 'workspace-cutover') {
      const target = dedicatedDatabases.get(accountId);
      if (!isUuid(workspaceId) || !target || value !== '--confirm') {
        throw new Error('Usage: npm run workspace:cutover -- <workspace-id> <database-alias> --confirm');
      }
      await assertControlDatabase(db);
      console.log(JSON.stringify(await cutoverWorkspace(db,target,workspaceId.toLowerCase(),accountId)));
    } else if (command === 'credits') {
      const amount = Number(value);
      if (!isUuid(workspaceId) || !isUuid(accountId) || !Number.isInteger(amount) || amount < 1 || amount > 1000000
        || typeof reference !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(reference)) {
        throw new Error('Usage: npm run credits -- <workspace-id> <account-id> <amount> <external-reference>');
      }
      await assertControlDatabase(db);
      const router = workspaceDatabaseRouter(db,dedicatedDatabases,await migrationFiles());
      const wallet = await provisionCredits(await router.forWorkspace(workspaceId), workspaceId, accountId, amount, reference);
      console.log(JSON.stringify(wallet));
    } else {
      throw new Error('Use npm run migrate, workspace:cutover or credits');
    }
  } finally {
    await Promise.all([db.close(), ...[...dedicatedDatabases.values()].map(pool=>pool.close())]);
  }
}
