import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { mergeSchedule } from "../domain/merge.js";
import { replayRun, validateReading } from "../domain/run.js";
import type { Content } from "../domain/content.js";
import type { ReadingInput } from "../domain/types.js";
import { badRequest, conflict, fieldErrors, notFound } from "./common.js";

interface RunRow {
  id: string;
  kiln_no: number;
  version_id: string;
  thickness_grade: string;
  initial_weight_g: number;
  initial_mc: number;
  current_stage: number;
  status: "active" | "finished";
  started_at: Date;
  finished_at: Date | null;
}

const numOrNull = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * 用某批次的全部读数重放，重写派生数据：
 * readings 的 rh/emc/sample_mc、stage_transitions、runs.current_stage。
 * 纯集合运算 —— 无论读数以何种顺序插入、是否刚重启，结果一致。
 */
async function recomputeRun(client: PoolClient, run: RunRow): Promise<void> {
  const [verRes, rdRes] = await Promise.all([
    client.query("SELECT content FROM schedule_versions WHERE id=$1", [run.version_id]),
    client.query(
      `SELECT record_no AS "recordNo", kiln_no AS "kilnNo", taken_at AS "takenAt",
              dry_bulb AS "dryBulb", wet_bulb AS "wetBulb", weight_g AS "weightG"
         FROM readings WHERE run_id=$1`,
      [run.id],
    ),
  ]);
  const content = verRes.rows[0].content as Content;
  const merged = mergeSchedule(content.base, content.overridesByGrade[run.thickness_grade] ?? []);

  const raw = rdRes.rows as ReadingInput[];
  const result = replayRun(
    raw,
    merged,
    { initialWeightG: run.initial_weight_g, initialMcPercent: run.initial_mc },
    new Date(run.started_at),
  );

  await client.query("DELETE FROM stage_transitions WHERE run_id=$1", [run.id]);
  for (const tr of result.transitions) {
    await client.query(
      `INSERT INTO stage_transitions(run_id, stage_no, record_no, at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (run_id, stage_no) DO UPDATE
         SET record_no=EXCLUDED.record_no, at=EXCLUDED.at`,
      [run.id, tr.stageNo, tr.recordNo, tr.at],
    );
  }
  for (const r of result.readings) {
    await client.query(
      "UPDATE readings SET rh=$2, emc=$3, sample_mc=$4 WHERE record_no=$1",
      [r.recordNo, r.rh, r.emc, r.sampleMc],
    );
  }
  await client.query("UPDATE runs SET current_stage=$2 WHERE id=$1", [
    run.id,
    result.currentStage,
  ]);
}

/** 导出供启动恢复复用：从已存读数重放全部批次的派生状态。 */
export async function recomputeAllFromReadings(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM runs ORDER BY id");
    for (const r of rows as RunRow[]) {
      await recomputeRun(client, r);
    }
  } finally {
    client.release();
  }
}

async function getActiveRun(client: PoolClient, kilnNo: number): Promise<RunRow | null> {
  const { rows } = await client.query(
    "SELECT * FROM runs WHERE kiln_no=$1 AND status='active' ORDER BY started_at DESC LIMIT 1",
    [kilnNo],
  );
  return (rows[0] as RunRow) ?? null;
}

export async function registerKilnRoutes(app: FastifyInstance) {
  /** 六座窑总览：当前在跑批次、阶段、绑定版本 */
  app.get("/api/kilns", async () => {
    const { rows } = await pool.query(`
      SELECT k.no, k.name,
        r.id AS run_id, r.status AS run_status, r.current_stage,
        r.thickness_grade, r.version_id, r.started_at, r.finished_at,
        r.initial_weight_g, r.initial_mc
      FROM kilns k
      LEFT JOIN LATERAL (
        SELECT * FROM runs WHERE kiln_no=k.no
        ORDER BY (status='active') DESC, started_at DESC LIMIT 1
      ) r ON true
      ORDER BY k.no`);
    return rows.map((r) => ({
      no: r.no,
      name: r.name,
      latestRun: r.run_id
        ? {
            id: Number(r.run_id),
            status: r.run_status,
            currentStage: r.current_stage,
            thicknessGrade: r.thickness_grade,
            versionId: Number(r.version_id),
            startedAt: r.started_at,
            finishedAt: r.finished_at,
            initialWeightG: Number(r.initial_weight_g),
            initialMc: Number(r.initial_mc),
          }
        : null,
    }));
  });

  /** 装料开跑：绑定“当时的有效（当前发布）版本”，之后不变 */
  app.post("/api/kilns/:no/start", async (req, reply) => {
    const kilnNo = Number((req.params as { no: string }).no);
    const body = (req.body ?? {}) as {
      speciesCode?: string;
      thicknessGrade?: string;
      initialWeightG?: number;
      initialMc?: number;
      startedAt?: string;
    };
    const errors: { field: string; message: string }[] = [];
    if (!body.speciesCode) errors.push({ field: "speciesCode", message: "必填" });
    if (!body.thicknessGrade) errors.push({ field: "thicknessGrade", message: "必填" });
    const iw = Number(body.initialWeightG);
    const im = Number(body.initialMc);
    if (!Number.isFinite(iw) || iw <= 0) errors.push({ field: "initialWeightG", message: "样板初称必须为正数（克）" });
    if (!Number.isFinite(im) || im <= 0) errors.push({ field: "initialMc", message: "样板初始含水率必须为正数（%）" });
    let startedAt: Date | null = null;
    if (body.startedAt !== undefined) {
      startedAt = new Date(body.startedAt);
      if (Number.isNaN(startedAt.getTime())) errors.push({ field: "startedAt", message: "开跑时刻格式无效" });
    }
    if (errors.length) return fieldErrors(reply, errors);

    const client = await pool.connect();
    try {
      const kiln = await client.query("SELECT no FROM kilns WHERE no=$1", [kilnNo]);
      if (!kiln.rowCount) return notFound(reply, "窑号不存在（共 6 座，编号 1-6）");

      const grade = await client.query("SELECT code FROM thickness_grades WHERE code=$1", [body.thicknessGrade]);
      if (!grade.rowCount) {
        return badRequest(reply, `厚度等级「${body.thicknessGrade}」不存在`, ["thicknessGrade"]);
      }
      const ver = await client.query(
        `SELECT v.id FROM schedule_versions v
           JOIN species s ON s.code=v.species_code
          WHERE s.code=$1 AND v.status='published' AND v.superseded_at IS NULL`,
        [body.speciesCode],
      );
      if (!ver.rowCount) return badRequest(reply, `树种「${body.speciesCode}」没有已发布基准`, ["speciesCode"]);

      const active = await getActiveRun(client, kilnNo);
      if (active) return conflict(reply, "该窑已有在跑批次，请先结束", ["kilnNo"]);

      const { rows } = await client.query(
        `INSERT INTO runs(kiln_no, version_id, thickness_grade, initial_weight_g, initial_mc, started_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6, now())) RETURNING id, started_at`,
        [kilnNo, ver.rows[0].id, body.thicknessGrade, iw, im, startedAt],
      );
      const newRun: RunRow = {
        id: rows[0].id,
        kiln_no: kilnNo,
        version_id: String(ver.rows[0].id),
        thickness_grade: body.thicknessGrade!,
        initial_weight_g: iw,
        initial_mc: im,
        current_stage: 1,
        status: "active",
        started_at: rows[0].started_at,
        finished_at: null,
      };
      await recomputeRun(client, newRun);
      return reply.code(201).send({ runId: Number(rows[0].id), startedAt: rows[0].started_at });
    } finally {
      client.release();
    }
  });

  /** 结束批次 */
  app.post("/api/kilns/:no/finish", async (req, reply) => {
    const kilnNo = Number((req.params as { no: string }).no);
    const client = await pool.connect();
    try {
      const run = await getActiveRun(client, kilnNo);
      if (!run) return conflict(reply, "该窑没有在跑批次", ["kilnNo"]);
      await client.query("UPDATE runs SET status='finished', finished_at=now() WHERE id=$1", [run.id]);
      return { ok: true };
    } finally {
      client.release();
    }
  });

  /** 窑状态：有效基准、曲线点、阶段时间轴 */
  app.get("/api/kilns/:no/state", async (req, reply) => {
    const kilnNo = Number((req.params as { no: string }).no);
    const client = await pool.connect();
    try {
      const kiln = await client.query("SELECT no, name FROM kilns WHERE no=$1", [kilnNo]);
      if (!kiln.rowCount) return notFound(reply, "窑号不存在");

      const run = await getActiveRun(client, kilnNo);
      if (!run) return { kiln: kiln.rows[0], run: null };

      const [verRes, rdRes, trRes] = await Promise.all([
        client.query(
          `SELECT v.*, s.code AS species_code, s.name AS species_name
             FROM schedule_versions v JOIN species s ON s.code=v.species_code
            WHERE v.id=$1`,
          [run.version_id],
        ),
        client.query(
          `SELECT record_no AS "recordNo", taken_at AS "takenAt",
                  dry_bulb AS "dryBulb", wet_bulb AS "wetBulb", weight_g AS "weightG",
                  rh, emc, sample_mc AS "sampleMc"
             FROM readings WHERE run_id=$1
             ORDER BY taken_at, record_no`,
          [run.id],
        ),
        client.query(
          `SELECT stage_no AS "stageNo", record_no AS "recordNo", at
             FROM stage_transitions WHERE run_id=$1 ORDER BY stage_no`,
          [run.id],
        ),
      ]);
      const v = verRes.rows[0];
      const content = v.content as Content;
      const merged = mergeSchedule(content.base, content.overridesByGrade[run.thickness_grade] ?? []);

      return {
        kiln: kiln.rows[0],
        run: {
          id: Number(run.id),
          status: run.status,
          currentStage: run.current_stage,
          thicknessGrade: run.thickness_grade,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          initialWeightG: run.initial_weight_g,
          initialMc: run.initial_mc,
        },
        schedule: {
          speciesCode: v.species_code,
          speciesName: v.species_name,
          versionId: Number(v.id),
          versionNo: v.version_no,
          publishedAt: v.published_at,
          merged,
        },
        readings: rdRes.rows,
        transitions: trRes.rows,
      };
    } finally {
      client.release();
    }
  });

  /** 某窑读数列表 */
  app.get("/api/kilns/:no/readings", async (req, reply) => {
    const kilnNo = Number((req.params as { no: string }).no);
    const kiln = await pool.query("SELECT 1 FROM kilns WHERE no=$1", [kilnNo]);
    if (!kiln.rowCount) return notFound(reply, "窑号不存在");
    const { rows } = await pool.query(
      `SELECT record_no AS "recordNo", kiln_no AS "kilnNo", run_id AS "runId",
              taken_at AS "takenAt", dry_bulb AS "dryBulb", wet_bulb AS "wetBulb",
              weight_g AS "weightG", rh, emc, sample_mc AS "sampleMc", created_at
         FROM readings WHERE kiln_no=$1 ORDER BY taken_at, record_no`,
      [kilnNo],
    );
    return rows;
  });
}

/**
 * 上报读数（同时用于现场两小时一次的上报与页面手工补录）。
 * 乱序安全：入库后按批次全量重放；重复 record_no 幂等返回 409。
 */
export async function registerReadingRoutes(app: FastifyInstance) {
  app.post("/api/readings", async (req, reply) => {
    const body = (req.body ?? {}) as {
      recordNo?: number | string;
      kilnNo?: number | string;
      takenAt?: string;
      dryBulb?: number | null;
      wetBulb?: number | null;
      weightG?: number | null;
    };

    const recordNo = Number(body.recordNo);
    const kilnNo = Number(body.kilnNo);
    if (!Number.isInteger(recordNo) || recordNo <= 0) {
      return badRequest(reply, "记录编号必须是正整数", ["recordNo"]);
    }
    if (!Number.isInteger(kilnNo) || kilnNo < 1 || kilnNo > 6) {
      return badRequest(reply, "窑号必须是 1-6", ["kilnNo"]);
    }
    if (!body.takenAt || Number.isNaN(new Date(body.takenAt).getTime())) {
      return badRequest(reply, "读数时刻格式无效", ["takenAt"]);
    }
    const db = numOrNull(body.dryBulb);
    const wb = numOrNull(body.wetBulb);
    const wg = numOrNull(body.weightG);
    const errs = validateReading({
      dryBulb: db,
      wetBulb: wb,
      weightG: wg,
      takenAt: body.takenAt,
    });
    if (errs.length) return fieldErrors(reply, errs);

    const client = await pool.connect();
    try {
      const dup = await client.query("SELECT 1 FROM readings WHERE record_no=$1", [recordNo]);
      if (dup.rowCount) return conflict(reply, `记录编号 ${recordNo} 已存在，重复上报忽略`, ["recordNo"]);

      const run = await getActiveRun(client, kilnNo);
      if (!run) return conflict(reply, "该窑没有在跑批次，无法记录读数", ["kilnNo"]);

      const takenAt = new Date(body.takenAt!);
      if (takenAt.getTime() < new Date(run.started_at).getTime()) {
        return badRequest(reply, "读数时刻早于本批次开跑时刻", ["takenAt"]);
      }

      await client.query(
        `INSERT INTO readings(record_no, kiln_no, run_id, taken_at, dry_bulb, wet_bulb, weight_g)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [recordNo, kilnNo, run.id, takenAt, db, wb, wg],
      );
      await recomputeRun(client, run);
      const refreshed = await getActiveRun(client, kilnNo);
      return reply.code(201).send({ ok: true, currentStage: refreshed?.current_stage });
    } finally {
      client.release();
    }
  });

  /** 运维/验收用：从已存读数重放全部批次（重启恢复的显式版本） */
  app.post("/api/admin/replay-all", async () => {
    await recomputeAllFromReadings();
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM runs");
    return { ok: true, runs: rows[0].n };
  });
}
