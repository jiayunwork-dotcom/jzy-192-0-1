import type { DbClient } from './client.js';
import { dt, num } from './client.js';
import type { BatchContext, Reading } from '../domain/types.js';
import { mergeSchedule, toStageRows } from '../domain/merge.js';
import type { OverrideRow } from '../domain/merge.js';

export interface KilnRow {
  id: number;
  name: string;
}

export interface ActiveBatchRow {
  id: number;
  kilnId: number;
  speciesId: number;
  versionId: number;
  thicknessGradeId: number | null;
  initialWeightG: number;
  initialMcPct: number;
  dryingKPerHour: number;
  startedAt: Date;
}

export async function listKilns(db: DbClient): Promise<KilnRow[]> {
  const { rows } = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM kilns ORDER BY id',
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

export async function kilnExists(db: DbClient, kilnId: number): Promise<boolean> {
  const { rows } = await db.query<{ one: number }>(
    'SELECT 1 AS one FROM kilns WHERE id=$1',
    [kilnId],
  );
  return rows.length > 0;
}

export async function getActiveBatch(
  db: DbClient,
  kilnId: number,
): Promise<ActiveBatchRow | null> {
  const { rows } = await db.query<{
    id: number;
    kiln_id: number;
    species_id: number;
    version_id: number;
    thickness_grade_id: number | null;
    initial_weight_g: string;
    initial_mc_pct: string;
    drying_k_per_hour: string;
    started_at: Date | string;
  }>(
    `SELECT id, kiln_id, species_id, version_id, thickness_grade_id,
            initial_weight_g, initial_mc_pct, drying_k_per_hour, started_at
       FROM batches WHERE kiln_id=$1 AND finished_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [kilnId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    kilnId: Number(r.kiln_id),
    speciesId: Number(r.species_id),
    versionId: Number(r.version_id),
    thicknessGradeId:
      r.thickness_grade_id === null ? null : Number(r.thickness_grade_id),
    initialWeightG: num(r.initial_weight_g),
    initialMcPct: num(r.initial_mc_pct),
    dryingKPerHour: num(r.drying_k_per_hour),
    startedAt: dt(r.started_at),
  };
}

/** 组装引擎所需批次上下文（基础表 × 厚度覆盖合并为有效基准） */
export async function loadBatchContext(
  db: DbClient,
  batch: ActiveBatchRow,
): Promise<BatchContext> {
  const { rows: stageRows } = await db.query<{
    stage_no: number;
    mc_threshold: string | null;
    dry_bulb_c: string;
    wet_bulb_c: string;
  }>(
    `SELECT stage_no, mc_threshold, dry_bulb_c, wet_bulb_c
       FROM schedule_stages WHERE version_id=$1 ORDER BY stage_no`,
    [batch.versionId],
  );
  const base = stageRows.map((r) => ({
    stageNo: Number(r.stage_no),
    mcThresholdPct: r.mc_threshold === null ? null : num(r.mc_threshold),
    dryBulbC: num(r.dry_bulb_c),
    wetBulbC: num(r.wet_bulb_c),
  }));

  let overrides: OverrideRow[] = [];
  if (batch.thicknessGradeId !== null) {
    const { rows: ovRows } = await db.query<{
      stage_no: number;
      mc_threshold: string | null;
      dry_bulb_c: string | null;
      wet_bulb_c: string | null;
    }>(
      `SELECT stage_no, mc_threshold, dry_bulb_c, wet_bulb_c
         FROM stage_overrides
        WHERE version_id=$1 AND grade_id=$2 ORDER BY stage_no`,
      [batch.versionId, batch.thicknessGradeId],
    );
    overrides = ovRows.map((r) => ({
      stageNo: Number(r.stage_no),
      mcThresholdPct: r.mc_threshold === null ? null : num(r.mc_threshold),
      dryBulbC: r.dry_bulb_c === null ? null : num(r.dry_bulb_c),
      wetBulbC: r.wet_bulb_c === null ? null : num(r.wet_bulb_c),
    }));
  }

  return {
    kilnId: batch.kilnId,
    startedAt: batch.startedAt,
    initialWeightG: batch.initialWeightG,
    initialMcPct: batch.initialMcPct,
    dryingKPerHour: batch.dryingKPerHour,
    stages: toStageRows(mergeSchedule(base, overrides)),
  };
}

export interface StartBatchParams {
  kilnId: number;
  speciesId: number;
  versionId: number;
  thicknessGradeId: number | null;
  initialWeightG: number;
  initialMcPct: number;
  dryingKPerHour: number | null;
  startedAt: Date;
}

export async function startBatch(
  db: DbClient,
  p: StartBatchParams,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO batches
       (kiln_id, species_id, version_id, thickness_grade_id,
        initial_weight_g, initial_mc_pct, drying_k_per_hour, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0.05),$8)
     RETURNING id`,
    [
      p.kilnId,
      p.speciesId,
      p.versionId,
      p.thicknessGradeId,
      p.initialWeightG,
      p.initialMcPct,
      p.dryingKPerHour,
      p.startedAt,
    ],
  );
  return Number(rows[0]!.id);
}

export async function finishBatch(db: DbClient, kilnId: number): Promise<boolean> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE batches SET finished_at=now()
      WHERE kiln_id=$1 AND finished_at IS NULL
     RETURNING id`,
    [kilnId],
  );
  return rows.length > 0;
}

/** 读数落库。record_no 主键冲突交给上层转 409。 */
export async function insertReading(
  db: DbClient,
  r: {
    recordNo: number;
    kilnId: number;
    recordedAt: Date;
    kind: 'psychro' | 'weight';
    dryBulbC: number | null;
    wetBulbC: number | null;
    weightG: number | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO readings
       (record_no, kiln_id, recorded_at, kind, dry_bulb_c, wet_bulb_c, weight_g)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      r.recordNo,
      r.kilnId,
      r.recordedAt,
      r.kind,
      r.dryBulbC,
      r.wetBulbC,
      r.weightG,
    ],
  );
}

export async function listReadings(
  db: DbClient,
  kilnId: number,
): Promise<Reading[]> {
  const { rows } = await db.query<{
    record_no: number;
    kiln_id: number;
    recorded_at: Date | string;
    kind: 'psychro' | 'weight';
    dry_bulb_c: string | null;
    wet_bulb_c: string | null;
    weight_g: string | null;
  }>(
    `SELECT record_no, kiln_id, recorded_at, kind, dry_bulb_c, wet_bulb_c, weight_g
       FROM readings WHERE kiln_id=$1 ORDER BY recorded_at, record_no`,
    [kilnId],
  );
  return rows.map((r) => ({
    recordNo: Number(r.record_no),
    kilnId: Number(r.kiln_id),
    recordedAt: dt(r.recorded_at),
    kind: r.kind,
    dryBulbC: r.dry_bulb_c === null ? null : num(r.dry_bulb_c),
    wetBulbC: r.wet_bulb_c === null ? null : num(r.wet_bulb_c),
    weightG: r.weight_g === null ? null : num(r.weight_g),
  }));
}

/** 所有有在跑批次的窑（重启恢复时用） */
export async function listAllActiveBatches(
  db: DbClient,
): Promise<ActiveBatchRow[]> {
  const { rows } = await db.query<{
    id: number;
    kiln_id: number;
    species_id: number;
    version_id: number;
    thickness_grade_id: number | null;
    initial_weight_g: string;
    initial_mc_pct: string;
    drying_k_per_hour: string;
    started_at: Date | string;
  }>(
    `SELECT id, kiln_id, species_id, version_id, thickness_grade_id,
            initial_weight_g, initial_mc_pct, drying_k_per_hour, started_at
       FROM batches WHERE finished_at IS NULL ORDER BY kiln_id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kilnId: Number(r.kiln_id),
    speciesId: Number(r.species_id),
    versionId: Number(r.version_id),
    thicknessGradeId:
      r.thickness_grade_id === null ? null : Number(r.thickness_grade_id),
    initialWeightG: num(r.initial_weight_g),
    initialMcPct: num(r.initial_mc_pct),
    dryingKPerHour: num(r.drying_k_per_hour),
    startedAt: dt(r.started_at),
  }));
}
