import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { mergeSchedule, validateSchedule } from "../domain/merge.js";
import type { Content } from "../domain/content.js";
import {
  badRequest,
  conflict,
  fieldErrors,
  notFound,
  parseContent,
} from "./common.js";

interface VersionRow {
  id: string;
  species_code: string;
  version_no: number;
  status: "draft" | "published";
  content: Content;
  published_at: Date | null;
  superseded_at: Date | null;
}

async function fetchVersion(id: number): Promise<VersionRow | null> {
  const { rows } = await pool.query(
    "SELECT * FROM schedule_versions WHERE id=$1",
    [id],
  );
  return (rows[0] as VersionRow) ?? null;
}

async function fetchGrades(): Promise<string[]> {
  const { rows } = await pool.query("SELECT code FROM thickness_grades");
  return rows.map((r: { code: string }) => r.code);
}

function shape(v: VersionRow, grades: string[]) {
  const mergedByGrade: Record<string, ReturnType<typeof mergeSchedule>> = {};
  for (const g of grades) {
    mergedByGrade[g] = mergeSchedule(v.content.base, v.content.overridesByGrade[g] ?? []);
  }
  return {
    id: Number(v.id),
    speciesCode: v.species_code,
    versionNo: v.version_no,
    status: v.status,
    publishedAt: v.published_at,
    supersededAt: v.superseded_at,
    content: v.content,
    mergedByGrade,
  };
}

export async function registerVersionRoutes(app: FastifyInstance) {
  /** 某树种的全部版本 */
  app.get("/api/species/:code/versions", async (req, reply) => {
    const { code } = req.params as { code: string };
    const species = await pool.query("SELECT 1 FROM species WHERE code=$1", [code]);
    if (!species.rowCount) return notFound(reply, "树种不存在");
    const { rows } = await pool.query(
      `SELECT id, version_no AS "versionNo", status, published_at AS "publishedAt",
              superseded_at AS "supersededAt"
         FROM schedule_versions WHERE species_code=$1
         ORDER BY version_no DESC`,
      [code],
    );
    return rows;
  });

  /** 版本详情：草稿内容 + 每个厚度等级的合并预览（标注每格来源） */
  app.get("/api/versions/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const v = await fetchVersion(id);
    if (!v) return notFound(reply, "版本不存在");
    return shape(v, await fetchGrades());
  });

  /** 在某树种下新建草稿（可从当前发布版复制） */
  app.post("/api/species/:code/versions", async (req, reply) => {
    const { code } = req.params as { code: string };
    const body = (req.body ?? {}) as { copyFromCurrent?: boolean };
    const species = await pool.query("SELECT 1 FROM species WHERE code=$1", [code]);
    if (!species.rowCount) return notFound(reply, "树种不存在");

    const client = await pool.connect();
    try {
      const draft = await client.query(
        "SELECT id FROM schedule_versions WHERE species_code=$1 AND status='draft'",
        [code],
      );
      if (draft.rowCount) return conflict(reply, "该树种已有草稿版本，请先编辑或发布它", ["status"]);

      let content: Content = { base: [], overridesByGrade: {} };
      if (body.copyFromCurrent) {
        const cur = await client.query(
          `SELECT content FROM schedule_versions
            WHERE species_code=$1 AND status='published' AND superseded_at IS NULL`,
          [code],
        );
        if (cur.rowCount) content = cur.rows[0].content as Content;
      }
      const { rows } = await client.query(
        `INSERT INTO schedule_versions(species_code, version_no, content)
         VALUES ($1,
           COALESCE((SELECT max(version_no)+1 FROM schedule_versions WHERE species_code=$1),1),
           $2)
         RETURNING id`,
        [code, JSON.stringify(content)],
      );
      return reply.code(201).send({ id: Number(rows[0].id) });
    } finally {
      client.release();
    }
  });

  /** 编辑草稿内容 */
  app.put("/api/versions/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const v = await fetchVersion(id);
    if (!v) return notFound(reply, "版本不存在");
    if (v.status === "published") return conflict(reply, "已发布版本只读", ["status"]);

    const parsed = parseContent(req.body);
    if (!parsed.ok) return fieldErrors(reply, parsed.errors);
    const { content } = parsed;

    const grades = await fetchGrades();
    for (const g of Object.keys(content.overridesByGrade)) {
      if (!grades.includes(g)) {
        return badRequest(reply, `引用了不存在的厚度等级「${g}」`, ["overridesByGrade"]);
      }
    }
    const errs = validateSchedule(content.base, content.overridesByGrade);
    if (errs.length) return fieldErrors(reply, errs);

    const { rows } = await pool.query(
      `UPDATE schedule_versions SET content=$2, updated_at=now()
        WHERE id=$1 RETURNING id`,
      [id, JSON.stringify(content)],
    );
    return shape((await fetchVersion(Number(rows[0].id)))!, grades);
  });

  /** 删除草稿 */
  app.delete("/api/versions/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const v = await fetchVersion(id);
    if (!v) return notFound(reply, "版本不存在");
    if (v.status === "published") return conflict(reply, "已发布版本不可删除（历史批次依赖它）", ["status"]);
    await pool.query("DELETE FROM schedule_versions WHERE id=$1", [id]);
    return reply.code(204).send();
  });

  /** 发布：冻结当前草稿；旧发布版标记 superseded（保留给在跑批次） */
  app.post("/api/versions/:id/publish", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const v = await fetchVersion(id);
    if (!v) return notFound(reply, "版本不存在");
    if (v.status === "published") return conflict(reply, "该版本已发布", ["status"]);

    const errs = validateSchedule(v.content.base, v.content.overridesByGrade);
    if (errs.length) return fieldErrors(reply, errs);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE schedule_versions SET superseded_at=now()
          WHERE species_code=$1 AND status='published' AND superseded_at IS NULL`,
        [v.species_code],
      );
      await client.query(
        `UPDATE schedule_versions
           SET status='published', published_at=now(), updated_at=now()
         WHERE id=$1`,
        [id],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return shape((await fetchVersion(id))!, await fetchGrades());
  });
}
