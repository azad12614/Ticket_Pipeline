import 'dotenv/config';
import { pool } from './lib/db.ts';
import logger from './lib/logger.ts';

async function main() {
  const result = await pool.query('SELECT 1');
  logger.info({ message: 'DB connected', rows: result.rows });
  await pool.end();
}

main().catch(err => {
  logger.error('DB connection failed:', err);
  process.exit(1);
});
