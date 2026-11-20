
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

const directory = new URL('../migrations/', import.meta.url);

export async function migrationFiles() {
  return (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
}

export function postgres(url) {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  pool.on('error', error => console.error('Idle database connection failed', error.code ?? 'UNKNOWN'));
  return {
    query: (sql, args) => pool.query(sql, args),
    async transaction(run) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await run(connection);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function migrate(db) {
  const files = await migrationFiles();
  await db.transaction(async connection => {
    await connection.query('SELECT pg_advisory_xact_lock(159421085)');
    await connection.query('CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = await connection.query('SELECT name FROM migrations');
    const names = new Set(applied.rows.map(row => row.name));
    for (const file of files) {
      if (names.has(file)) continue;
      // Each statement in these migrations is SQL DDL without embedded semicolons.
      const statements = (await readFile(new URL(file, directory), 'utf8')).split(';');
      for (const statement of statements) {
        if (statement.trim()) await connection.query(statement);
      }
      await connection.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
    }
  });
}

export async function row(db, sql, args = []) {
  return (await db.query(sql, args)).rows[0];
}

export async function rows(db, sql, args = []) {
  return (await db.query(sql, args)).rows;
}
