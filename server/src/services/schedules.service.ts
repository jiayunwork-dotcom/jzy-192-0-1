import type { DbClient } from '../db/client.js';
import {
  createDraftFromEffective,
  createGrade,
  createSpecies,
  DraftExistsError,
  getDraft,
  getEffectiveVersion,
  getOverrides,
  getStages,
  listGrades,
  listSpecies,
  listVersions,
  publishDraft,
  replaceOverrides,
  replaceStages,
  speciesExists,
  type VersionRow,
} from '../db/schedules.repo.js';
import { mergeSchedule, toStageRows, type OverrideRow } from '../domain/merge.js';
import type { EffectiveStageRow, StageRow } from '../domain/types.js';
import { validateStages, type FieldError } from '../domain/validation.js';

export class ValidationFailedError extends Error {
  constructor(public errors: FieldError[]) {
    super('基准校验未通过');
    this.name = 'ValidationFailedError';
  }
}

export const species = {
  list: (db: DbClient) => listSpecies(db),
  create: (db: DbClient, name: string) => createSpecies(db, name),
};

/** 取一个版本（草稿或已发布）的基础阶段 + 覆盖，组装出有效基准（逐格带来源） */
export async function buildEffectiveStages(
  db: DbClient,
  versionId: number,
  gradeId: number | null,
): Promise<EffectiveStageRow[]> {
  const base = await getStages(db, versionId);
  const overrides = gradeId === null ? [] : await getOverrides(db, versionId, gradeId);
  return mergeSchedule(base, overrides);
}

export interface VersionSummary extends VersionRow {
  effectiveStages: EffectiveStageRow[] | null; // 无厚度层时为基础合并（全 base）
}

/** 列出某树种的全部版本（附带每个版本基础表的合并预览） */
export async function listSpeciesVersions(db: DbClient, speciesId: number) {
  if (!(await speciesExists(db, speciesId))) {
    const e: FieldError = { field: 'speciesId', message: '树种不存在' };
    throw new ValidationFailedError([e]);
  }
  const versions = await listVersions(db, speciesId);
  return Promise.all(
    versions.map(async (v) => ({
      ...v,
      baseStages: await getStages(db, v.id),
    })),
  );
}

/** 新建编辑稿：从当前有效版本复制 */
export async function createDraft(
  db: DbClient,
  speciesId: number,
  note: string | null,
): Promise<VersionRow> {
  if (!(await speciesExists(db, speciesId))) {
    throw new ValidationFailedError([
      { field: 'speciesId', message: '树种不存在' },
    ]);
  }
  try {
    return await createDraftFromEffective(db, speciesId, note);
  } catch (err) {
    if (err instanceof DraftExistsError) throw err;
    throw err;
  }
}

async function requireDraft(db: DbClient, speciesId: number): Promise<VersionRow> {
  const draft = await getDraft(db, speciesId);
  if (!draft) {
    throw new ValidationFailedError([
      { field: 'version', message: '该树种还没有编辑稿，请先新建编辑稿' },
    ]);
  }
  return draft;
}

/** 保存草稿的基础阶段表（先校验，通过才写库） */
export async function saveDraftStages(
  db: DbClient,
  speciesId: number,
  stages: StageRow[],
): Promise<VersionRow> {
  const draft = await requireDraft(db, speciesId);
  const errors = validateStages(stages, '基础表');
  if (errors.length) throw new ValidationFailedError(errors);
  await replaceStages(db, draft.id, stages);
  return draft;
}

/** 保存某厚度等级的覆盖（校验合并后的有效基准） */
export async function saveDraftOverrides(
  db: DbClient,
  speciesId: number,
  gradeCode: string,
  overrides: OverrideRow[],
): Promise<VersionRow> {
  const draft = await requireDraft(db, speciesId);
  const grades = await listGrades(db, speciesId);
  const grade = grades.find((g) => g.code === gradeCode);
  if (!grade) {
    throw new ValidationFailedError([
      { field: 'gradeCode', message: `厚度等级 ${gradeCode} 不存在` },
    ]);
  }
  // 阶段号必须落在基础表范围内
  const base = await getStages(db, draft.id);
  const stageNos = new Set(base.map((b) => b.stageNo));
  const bad = overrides.filter((o) => !stageNos.has(o.stageNo));
  if (bad.length) {
    throw new ValidationFailedError(
      bad.map((o) => ({
        field: `阶段${o.stageNo}`,
        message: '覆盖行的阶段号在基础表中不存在',
      })),
    );
  }
  // 以“合并后的有效基准”做整体校验（湿球≤干球、温度范围、进入条件递减）
  const merged = toStageRows(mergeSchedule(base, overrides));
  const errors = validateStages(merged, '合并预览');
  if (errors.length) throw new ValidationFailedError(errors);

  await replaceOverrides(db, draft.id, grade.id, overrides);
  return draft;
}

/** 合并预览（草稿；发布后查看用同一合并函数） */
export async function previewDraft(
  db: DbClient,
  speciesId: number,
  gradeCode: string | null,
): Promise<{
  draft: VersionRow;
  grades: { id: number; code: string; label: string }[];
  baseStages: StageRow[];
  effectiveStages: EffectiveStageRow[];
}> {
  const draft = await requireDraft(db, speciesId);
  const grades = await listGrades(db, speciesId);
  const base = await getStages(db, draft.id);
  let gradeId: number | null = null;
  if (gradeCode) {
    const g = grades.find((x) => x.code === gradeCode);
    if (!g) {
      throw new ValidationFailedError([
        { field: 'gradeCode', message: `厚度等级 ${gradeCode} 不存在` },
      ]);
    }
    gradeId = g.id;
  }
  const overrides = gradeId === null ? [] : await getOverrides(db, draft.id, gradeId);
  return {
    draft,
    grades,
    baseStages: base,
    effectiveStages: mergeSchedule(base, overrides),
  };
}

/** 发布前对所有厚度层逐一校验合并结果，然后置为 published（此后只读） */
export async function publish(
  db: DbClient,
  speciesId: number,
): Promise<VersionRow> {
  const draft = await requireDraft(db, speciesId);
  const base = await getStages(db, draft.id);
  const baseErrors = validateStages(base, '基础表');
  if (baseErrors.length) throw new ValidationFailedError(baseErrors);

  const grades = await listGrades(db, speciesId);
  const allErrors: FieldError[] = [];
  for (const g of grades) {
    const overrides = await getOverrides(db, draft.id, g.id);
    const merged = toStageRows(mergeSchedule(base, overrides));
    allErrors.push(...validateStages(merged, `厚度层[${g.code}]`));
  }
  if (allErrors.length) throw new ValidationFailedError(allErrors);

  return publishDraft(db, draft.id);
}

export async function addGrade(
  db: DbClient,
  speciesId: number,
  code: string,
  label: string,
) {
  if (!(await speciesExists(db, speciesId))) {
    throw new ValidationFailedError([
      { field: 'speciesId', message: '树种不存在' },
    ]);
  }
  return createGrade(db, speciesId, code, label);
}

/** 开跑时要绑定的“当时有效版本” */
export async function currentEffectiveVersion(db: DbClient, speciesId: number) {
  const v = await getEffectiveVersion(db, speciesId);
  if (!v) {
    throw new ValidationFailedError([
      { field: 'speciesId', message: '该树种还没有已发布基准' },
    ]);
  }
  return v;
}
