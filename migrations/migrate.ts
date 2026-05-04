import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/lib/db.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = await pool.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         SERIAL PRIMARY KEY,
      filename   TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await client.query<{ filename: string }>('SELECT filename FROM migrations');
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const files = readdirSync(__dirname)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`skipped: ${file}`);
      continue;
    }

    const sql = readFileSync(join(__dirname, file), 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
    console.log(`applied: ${file}`);
  }

  console.log('\nDone. Applied migrations:');
  const result = await client.query('SELECT filename, applied_at FROM migrations ORDER BY id');
  console.table(result.rows);
} finally {
  client.release();
  await pool.end();
}
