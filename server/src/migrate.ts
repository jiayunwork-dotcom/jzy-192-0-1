import { createPgPool } from './db/pg.js';
import { runMigrations } from './db/migrate.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://kiln:kiln@localhost:5432/kiln';
const db = createPgPool(connectionString);
runMigrations(db)
  .then(async () => {
    console.log('[migrate] done');
    await db.close();
  })
  .catch(async (err) => {
    console.error(err);
    await db.close();
    process.exit(1);
  });
