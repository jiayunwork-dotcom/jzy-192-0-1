import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { badRequest, conflict, fieldErrors, notFound } from "./common.js";

export async function registerSpeciesRoutes(app: FastifyInstance) {
  /** 厚度等级字典 */
  app.get("/api/thickness-grades", async () => {
    const { rows } = await pool.query(
      "SELECT code, label, sort_order AS \"sortOrder\" FROM thickness_grades ORDER BY sort_order",
    );
    return rows;
  });

  /** 树种列表 */
  app.get("/api/species", async () => {
    const { rows } = await pool.query(`
      SELECT s.code, s.name,
        (SELECT id FROM schedule_versions v
          WHERE v.species_code=s.code AND v.status='published' AND v.superseded_at IS NULL
          LIMIT 1) AS current_version_id,
        (SELECT id FROM schedule_versions v
          WHERE v.species_code=s.code AND v.status='draft' LIMIT 1) AS draft_id
      FROM species s ORDER BY s.code`);
    return rows;
  });

  /** 新建树种 */
  app.post("/api/species", async (req, reply) => {
    const { code, name } = (req.body ?? {}) as { code?: string; name?: string };
    const errors: { field: string; message: string }[] = [];
    if (!code || !/^[a-z0-9_-]{1,32}$/.test(code)) {
      errors.push({ field: "code", message: "树种代码需为 1-32 位小写字母/数字/-/_" });
    }
    if (!name || !name.trim()) errors.push({ field: "name", message: "树种名称必填" });
    if (errors.length) return fieldErrors(reply, errors);

    try {
      const { rows } = await pool.query(
        "INSERT INTO species(code,name) VALUES ($1,$2) RETURNING code,name",
        [code, name!.trim()],
      );
      return reply.code(201).send(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        return conflict(reply, "树种代码已存在", ["code"]);
      }
      throw e;
    }
  });

  /** 改名 */
  app.put("/api/species/:code", async (req, reply) => {
    const { code } = req.params as { code: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name || !name.trim()) return badRequest(reply, "树种名称必填", ["name"]);
    const { rows } = await pool.query(
      "UPDATE species SET name=$2 WHERE code=$1 RETURNING code,name",
      [code, name.trim()],
    );
    if (!rows.length) return notFound(reply, "树种不存在");
    return rows[0];
  });
}
