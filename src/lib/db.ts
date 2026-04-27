import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env['DATABASE_URL'];

if (!connectionString && process.env['NODE_ENV'] !== 'test') {
  throw new Error('DATABASE_URL environment variable is required');
}

export const pool = connectionString ? new Pool({ connectionString }) : new Pool();
