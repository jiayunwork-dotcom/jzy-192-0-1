import type { DbClient } from './client.js';
import { MIGRATIONS } from './migrations.js';

export async function runMigrations(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await db.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.tx(async (tx) => {
      for (const stmt of m.sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)) {
        await tx.query(stmt);
      }

      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        m.version,
      ]);
    });
    console.log(`[migrate] applied v${m.version}`);
  }
}
