import { createPgPool } from './db/pg.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgres://kiln:kiln@localhost:5432/kiln';
  const db = createPgPool(connectionString);

  await db.query('SELECT 1');
  await runMigrations(db);

  const app = await buildApp(db);
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });

  const shutdown = async () => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
