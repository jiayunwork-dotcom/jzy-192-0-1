import type { DbClient } from './client.js';
import { dt, num } from './client.js';
import type { OverrideRow } from '../domain/merge.js';
import type { StageRow } from '../domain/types.js';

export interface SpeciesRow {
  id: number;
  name: string;
}

export interface VersionRow {
  id: number;
  speciesId: number;
  version: number;
  status: 'draft' | 'published';
  note: string | null;
  publishedAt: Date | null;
}

export interface StageDbRow extends StageRow {}

export interface GradeRow {
  id: number;
  speciesId: number;
  code: string;
  label: string;
}

export async function listSpecies(db: DbClient): Promise<SpeciesRow[]> {
  const { rows } = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM species ORDER BY id',
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

export async function createSpecies(db: DbClient, name: string): Promise<SpeciesRow> {
  const { rows } = await db.query<{ id: number; name: string }>(
    'INSERT INTO species (name) VALUES ($1) RETURNING id, name',
    [name],
  );
  return { id: Number(rows[0]!.id), name: rows[0]!.name };
}

export async function listVersions(
  db: DbClient,
  speciesId: number,
): Promise<VersionRow[]> {
  const { rows } = await db.query<{
    id: number;
    species_id: number;
    version: number;
    status: 'draft' | 'published';
    note: string | null;
    published_at: Date | string | null;
  }>(
    `SELECT id, species_id, version, status, note, published_at
       FROM schedule_versions WHERE species_id = $1 ORDER BY version`,
    [speciesId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    speciesId: Number(r.species_id),
    version: Number(r.version),
    status: r.status,
    note: r.note,
    publishedAt: r.published_at ? dt(r.published_at) : null,
  }));
}

/** 当前有效版本：已发布的最大版本号 */
export async function getEffectiveVersion(
  db: DbClient,
  speciesId: number,
): Promise<VersionRow | null> {
  const { rows } = await db.query<{
    id: number;
    species_id: number;
    version: number;
    status: 'draft' | 'published';
    note: string | null;
    published_at: Date | string | null;
  }>(
    `SELECT id, species_id, version, status, note, published_at
       FROM schedule_versions
      WHERE species_id = $1 AND status = 'published'
      ORDER BY version DESC LIMIT 1`,
    [speciesId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    speciesId: Number(r.species_id),
    version: Number(r.version),
    status: r.status,
    note: r.note,
    publishedAt: r.published_at ? dt(r.published_at) : null,
  };
}

/** 当前编辑稿：draft 版本唯一；没有则返回 null */
export async function getDraft(
  db: DbClient,
  speciesId: number,
): Promise<VersionRow | null> {
  const { rows } = await db.query<{
    id: number;
    species_id: number;
    version: number;
    status: 'draft' | 'published';
    note: string | null;
    published_at: Date | string | null;
  }>(
    `SELECT id, species_id, version, status, note, published_at
       FROM schedule_versions WHERE species_id = $1 AND status = 'draft'`,
    [speciesId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    speciesId: Number(r.species_id),
    version: Number(r.version),
    status: r.status,
    note: r.note,
    publishedAt: r.published_at ? dt(r.published_at) : null,
  };
}

export async function speciesExists(db: DbClient, speciesId: number): Promise<boolean> {
  const { rows } = await db.query<{ one: number }>(
    'SELECT 1 AS one FROM species WHERE id = $1',
    [speciesId],
  );
  return rows.length > 0;
}

/** 由“最新已发布版本（或指定版本）”整体复制出一份 draft，版本号 = max+1 */
export async function createDraftFromEffective(
  db: DbClient,
  speciesId: number,
  note: string | null,
): Promise<VersionRow> {
  return db.tx(async (tx) => {
    const existing = await getDraft(tx, speciesId);
    if (existing) throw new DraftExistsError(existing.id);

    const { rows: maxRows } = await tx.query<{ v: string | null }>(
      'SELECT max(version)::text AS v FROM schedule_versions WHERE species_id = $1',
      [speciesId],
    );
    const nextVersion = (maxRows[0]!.v === null ? 0 : Number(maxRows[0]!.v)) + 1;

    const { rows: ins } = await tx.query<{ id: number }>(
      `INSERT INTO schedule_versions (species_id, version, status, note)
       VALUES ($1,$2,'draft',$3) RETURNING id`,
      [speciesId, nextVersion, note],
    );
    const versionId = Number(ins[0]!.id);

    // 从最新已发布版本复制阶段行与覆盖；尚无已发布版本则得到空草稿
    const src = await getEffectiveVersion(tx, speciesId);
    if (src) {
      await tx.query(
        `INSERT INTO schedule_stages
            (version_id, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c)
         SELECT $1, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c
           FROM schedule_stages WHERE version_id = $2`,
        [versionId, src.id],
      );
      await tx.query(
        `INSERT INTO stage_overrides
            (grade_id, version_id, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c)
         SELECT grade_id, $1, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c
           FROM stage_overrides WHERE version_id = $2`,
        [versionId, src.id],
      );
    }
    return {
      id: versionId,
      speciesId,
      version: nextVersion,
      status: 'draft' as const,
      note,
      publishedAt: null,
    };
  });
}

export class DraftExistsError extends Error {
  constructor(public draftId: number) {
    super('该树种已有编辑稿，请直接编辑或发布后再新建');
    this.name = 'DraftExistsError';
  }
}

export async function getStages(
  db: DbClient,
  versionId: number,
): Promise<StageDbRow[]> {
  const { rows } = await db.query<{
    stage_no: number;
    mc_threshold: string | null;
    dry_bulb_c: string;
    wet_bulb_c: string;
  }>(
    `SELECT stage_no, mc_threshold, dry_bulb_c, wet_bulb_c
       FROM schedule_stages WHERE version_id = $1 ORDER BY stage_no`,
    [versionId],
  );
  return rows.map((r) => ({
    stageNo: Number(r.stage_no),
    mcThresholdPct: r.mc_threshold === null ? null : num(r.mc_threshold),
    dryBulbC: num(r.dry_bulb_c),
    wetBulbC: num(r.wet_bulb_c),
  }));
}

/** 整体替换草稿的阶段表（编辑保存） */
export async function replaceStages(
  db: DbClient,
  versionId: number,
  stages: StageRow[],
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query('DELETE FROM schedule_stages WHERE version_id = $1', [versionId]);
    for (const s of stages) {
      await tx.query(
        `INSERT INTO schedule_stages
             (version_id, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          versionId,
          s.stageNo,
          s.mcThresholdPct,
          s.dryBulbC,
          s.wetBulbC,
        ],
      );
    }
  });
}

export async function listGrades(
  db: DbClient,
  speciesId: number,
): Promise<GradeRow[]> {
  const { rows } = await db.query<{
    id: number;
    species_id: number;
    code: string;
    label: string;
  }>(
    'SELECT id, species_id, code, label FROM thickness_grades WHERE species_id = $1 ORDER BY id',
    [speciesId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    speciesId: Number(r.species_id),
    code: r.code,
    label: r.label,
  }));
}

export async function createGrade(
  db: DbClient,
  speciesId: number,
  code: string,
  label: string,
): Promise<GradeRow> {
  const { rows } = await db.query<{ id: number }>(
    'INSERT INTO thickness_grades (species_id, code, label) VALUES ($1,$2,$3) RETURNING id',
    [speciesId, code, label],
  );
  return { id: Number(rows[0]!.id), speciesId, code, label };
}

export async function getOverrides(
  db: DbClient,
  versionId: number,
  gradeId: number,
): Promise<(OverrideRow & { stageNo: number })[]> {
  const { rows } = await db.query<{
    stage_no: number;
    mc_threshold: string | null;
    dry_bulb_c: string | null;
    wet_bulb_c: string | null;
  }>(
    `SELECT stage_no, mc_threshold, dry_bulb_c, wet_bulb_c
       FROM stage_overrides WHERE version_id = $1 AND grade_id = $2 ORDER BY stage_no`,
    [versionId, gradeId],
  );
  return rows.map((r) => ({
    stageNo: Number(r.stage_no),
    mcThresholdPct: r.mc_threshold === null ? null : num(r.mc_threshold),
    dryBulbC: r.dry_bulb_c === null ? null : num(r.dry_bulb_c),
    wetBulbC: r.wet_bulb_c === null ? null : num(r.wet_bulb_c),
  }));
}

/**
 * 整体替换某草稿×厚度等级的覆盖。前端只提交“写了值”的格子；
 * 空覆盖集等价于全部继承基础表。
 */
export async function replaceOverrides(
  db: DbClient,
  versionId: number,
  gradeId: number,
  rows: OverrideRow[],
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      'DELETE FROM stage_overrides WHERE version_id = $1 AND grade_id = $2',
      [versionId, gradeId],
    );
    for (const o of rows) {
      const hasAny =
        (o.mcThresholdPct ?? null) !== null ||
        (o.dryBulbC ?? null) !== null ||
        (o.wetBulbC ?? null) !== null;
      if (!hasAny) continue;
      await tx.query(
        `INSERT INTO stage_overrides
             (grade_id, version_id, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          gradeId,
          versionId,
          o.stageNo,
          o.mcThresholdPct ?? null,
          o.dryBulbC ?? null,
          o.wetBulbC ?? null,
        ],
      );
    }
  });
}

export async function publishDraft(
  db: DbClient,
  versionId: number,
): Promise<VersionRow> {
  const { rows } = await db.query<{
    id: number;
    species_id: number;
    version: number;
    note: string | null;
    published_at: Date | string | null;
  }>(
    `UPDATE schedule_versions
        SET status='published', published_at=now()
      WHERE id=$1 AND status='draft'
   RETURNING id, species_id, version, note, published_at`,
    [versionId],
  );
  const r = rows[0];
  if (!r) throw new Error('草稿不存在或已发布');
  return {
    id: Number(r.id),
    speciesId: Number(r.species_id),
    version: Number(r.version),
    status: 'published',
    note: r.note,
    publishedAt: dt(r.published_at),
  };
}
