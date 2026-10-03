import { PGlite } from '@electric-sql/pglite';
import type { DbClient, QueryRow } from './client.js';

/** 测试/零依赖启动用：单文件内存 PostgreSQL（WASM） */
export function createPglite(dataDir?: string): {
  db: DbClient;
  raw: PGlite;
} {
  const raw = new PGlite(dataDir);

  const makeClient = (
    runner: <R extends QueryRow>(q: string, p?: unknown[]) => Promise<R[]>,
  ): DbClient => ({
    async query<R extends QueryRow = QueryRow>(text: string, params?: unknown[]) {
      const rows = await runner<R>(text, params);
      return { rows };
    },
    async tx<R>(fn: (tx: DbClient) => Promise<R>): Promise<R> {
      // PGlite 单连接串行，BEGIN/COMMIT 即可
      await runner('BEGIN');
      try {
        const result = await fn(makeClient(runner));
        await runner('COMMIT');
        return result;
      } catch (err) {
        await runner('ROLLBACK');
        throw err;
      }
    },
    close: async () => {
      await raw.close();
    },
  });

  const runner = async <R extends QueryRow>(q: string, p?: unknown[]): Promise<R[]> =>
    (await raw.query<R>(q, p as never[])).rows;
  const db = makeClient(runner);
  return { db, raw };
}
