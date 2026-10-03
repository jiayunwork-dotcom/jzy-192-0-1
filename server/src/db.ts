import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool, types } = pg;

// 本系统所有 BIGINT（记录编号、版本/批次 id）量级远小于 2^53，
// 统一按 number 返回，保证前端拿到数字类型、等值比较可靠。
types.setTypeParser(20 /* int8 */, (v) => (v === null ? null : Number(v)));

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://kiln:kilnsecret@localhost:5432/kiln",
  max: 10,
});

/** 极简前向迁移：migrations/*.sql 按文件名顺序执行，已执行的记入 schema_migrations。 */
export async function runMigrations(): Promise<void> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const name of files) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        "INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING",
        [name],
      );
      if (rowCount && rowCount > 0) {
        // 整个迁移文件作为一条 simple query 发送（无参数），PG 将其包在同一隐式事务中，
        // 与外层显式事务一起保证 DDL 原子性。
        const sql = await readFile(join(dir, name), "utf8");
        await client.query(sql);
        console.info(`[migrate] applied ${name}`);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
