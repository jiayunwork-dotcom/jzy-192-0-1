import pg from 'pg';
import type { DbClient, QueryRow } from './client.js';

const { Pool } = pg;

export function createPgPool(connectionString: string): DbClient & { pool: pg.Pool } {
  const pool = new Pool({ connectionString, max: 10 });
  pool.on('error', (err) => {
    console.error('[pg] idle client error', err);
  });

  const db: DbClient = {
    async query<R extends QueryRow = QueryRow>(text: string, params?: unknown[]) {
      return pool.query<R>(text, params as never[]);
    },
    async tx<R>(fn: (tx: DbClient) => Promise<R>): Promise<R> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: DbClient = {
          query: (text, params) => client.query(text, params as never[]),
          tx: (inner) => inner(tx),
          close: async () => {},
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return { ...db, pool };
}
