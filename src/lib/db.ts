import pg from 'pg';
import { config } from './config.ts';

const { Pool } = pg;

export const pool = config.databaseUrl
  ? new Pool({ connectionString: config.databaseUrl })
  : new Pool();
