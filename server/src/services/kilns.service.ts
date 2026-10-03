import type { DbClient } from '../db/client.js';
import {
  finishBatch,
  getActiveBatch,
  kilnExists,
  listKilns,
  listReadings,
  loadBatchContext,
  startBatch,
} from '../db/kilns.repo.js';
import { listGrades } from '../db/schedules.repo.js';
import { replay } from '../domain/engine.js';
import type { BatchContext, KilnTimeline } from '../domain/types.js';
import {
  validateBatchStart,
  validateReading,
  type FieldError,
} from '../domain/validation.js';

export class ApiValidationError extends Error {
  constructor(public errors: FieldError[]) {
    super('参数校验未通过');
    this.name = 'ApiValidationError';
  }
}

export class ConflictError extends Error {
  constructor(
    message: string,
    public field: string,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(
    message: string,
    public field: string,
  ) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** 重算一座窑：服务重启、补录、乱序插入后调用，状态完全由读数重放得到 */
export async function computeKilnState(
  db: DbClient,
  kilnId: number,
): Promise<{
  batch: {
    id: number;
    startedAt: Date;
    speciesId: number;
    versionId: number;
    thicknessGradeId: number | null;
    initialWeightG: number;
    initialMcPct: number;
  } | null;
  timeline: KilnTimeline | null;
  context: BatchContext | null;
}> {
  const active = await getActiveBatch(db, kilnId);
  if (!active) return { batch: null, timeline: null, context: null };
  const context = await loadBatchContext(db, active);
  const readings = await listReadings(db, kilnId);
  const timeline = replay(context, readings);
  return {
    batch: {
      id: active.id,
      startedAt: active.startedAt,
      speciesId: active.speciesId,
      versionId: active.versionId,
      thicknessGradeId: active.thicknessGradeId,
      initialWeightG: active.initialWeightG,
      initialMcPct: active.initialMcPct,
    },
    timeline,
    context,
  };
}

export async function overview(db: DbClient) {
  const kilns = await listKilns(db);
  return Promise.all(
    kilns.map(async (k) => {
      const state = await computeKilnState(db, k.id);
      return {
        id: k.id,
        name: k.name,
        running: state.batch !== null,
        batch: state.batch
          ? {
              id: state.batch.id,
              startedAt: state.batch.startedAt,
              speciesId: state.batch.speciesId,
              versionId: state.batch.versionId,
            }
          : null,
        currentStageNo: state.timeline?.currentStageNo ?? null,
        currentMcPct:
          state.timeline === null ? null : round2(state.timeline.currentMcPct),
        latestEmcPct:
          state.timeline?.latestEmcPct === null ||
          state.timeline?.latestEmcPct === undefined
            ? null
            : round2(state.timeline.latestEmcPct),
        latestRhPct:
          state.timeline?.latestRhPct === null ||
          state.timeline?.latestRhPct === undefined
            ? null
            : round2(state.timeline.latestRhPct),
        stageCount: state.context?.stages.length ?? 0,
      };
    }),
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface StartInput {
  kilnId: number;
  speciesId: number;
  thicknessGrade?: string | null;
  initialWeightG: number;
  initialMcPct: number;
  dryingKPerHour?: number | null;
  startedAt?: string | null;
}

export async function startKilnBatch(db: DbClient, input: StartInput) {
  const errors = validateBatchStart(input);
  if (typeof input.kilnId !== 'number' || input.kilnId <= 0) {
    errors.push({ field: 'kilnId', message: '窑号必须是正整数' });
  }
  if (typeof input.speciesId !== 'number' || input.speciesId <= 0) {
    errors.push({ field: 'speciesId', message: '树种必须是正整数编号' });
  }
  if (
    input.dryingKPerHour !== undefined &&
    input.dryingKPerHour !== null &&
    (typeof input.dryingKPerHour !== 'number' ||
      !Number.isFinite(input.dryingKPerHour) ||
      input.dryingKPerHour <= 0)
  ) {
    errors.push({ field: 'dryingKPerHour', message: '干燥常数 k 必须为正数（1/小时）' });
  }
  if (errors.length) throw new ApiValidationError(errors);

  if (!(await kilnExists(db, input.kilnId))) {
    throw new NotFoundError(`窑 ${input.kilnId} 不存在`, 'kilnId');
  }
  const active = await getActiveBatch(db, input.kilnId);
  if (active) {
    throw new ConflictError(`窑 ${input.kilnId} 已有一批料在跑（批次 ${active.id}）`, 'kilnId');
  }

  // 延迟引入，避免与 schedules.service 的校验错误类型混淆
  const { currentEffectiveVersion } = await import('./schedules.service.js');
  const version = await currentEffectiveVersion(db, input.speciesId);

  let gradeId: number | null = null;
  if (input.thicknessGrade) {
    const grades = await listGrades(db, input.speciesId);
    const g = grades.find((x) => x.code === input.thicknessGrade);
    if (!g) {
      throw new NotFoundError(
        `树种下不存在厚度等级 ${input.thicknessGrade}`,
        'thicknessGrade',
      );
    }
    gradeId = g.id;
  }

  const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
  if (Number.isNaN(startedAt.getTime())) {
    throw new ApiValidationError([
      { field: 'startedAt', message: '开跑时刻必须是合法 ISO 时间' },
    ]);
  }

  const id = await startBatch(db, {
    kilnId: input.kilnId,
    speciesId: input.speciesId,
    versionId: version.id,
    thicknessGradeId: gradeId,
    initialWeightG: input.initialWeightG,
    initialMcPct: input.initialMcPct,
    dryingKPerHour: input.dryingKPerHour ?? null,
    startedAt,
  });
  return computeKilnState(db, input.kilnId).then((s) => ({ batchId: id, state: s }));
}

export async function stopKilnBatch(db: DbClient, kilnId: number) {
  if (!(await kilnExists(db, kilnId))) {
    throw new NotFoundError(`窑 ${kilnId} 不存在`, 'kilnId');
  }
  const ok = await finishBatch(db, kilnId);
  if (!ok) {
    throw new ConflictError(`窑 ${kilnId} 当前没有在跑的批次`, 'kilnId');
  }
  return { ok: true };
}

export interface ReadingApiInput {
  recordNo: number;
  kilnId: number;
  recordedAt: string;
  dryBulbC?: number;
  wetBulbC?: number;
  weightG?: number;
}

/** 上报/补录读数。返回重算后的窑状态。 */
export async function submitReading(db: DbClient, input: ReadingApiInput) {
  const errors = validateReading(input);
  if (errors.length) throw new ApiValidationError(errors);

  const recordedAt = new Date(input.recordedAt);
  const active = await getActiveBatch(db, input.kilnId);
  if (!active) {
    // 窑存在但没在跑也视为引用错误
    if (await kilnExists(db, input.kilnId)) {
      throw new ConflictError(`窑 ${input.kilnId} 当前没有在跑的批次，读数拒收`, 'kilnId');
    }
    throw new NotFoundError(`窑 ${input.kilnId} 不存在`, 'kilnId');
  }
  if (recordedAt.getTime() < active.startedAt.getTime()) {
    throw new ApiValidationError([
      { field: 'recordedAt', message: '读数时刻早于本批料开跑时刻' },
    ]);
  }

  const kind: 'psychro' | 'weight' = input.weightG === undefined ? 'psychro' : 'weight';
  try {
    const { insertReading } = await import('../db/kilns.repo.js');
    await insertReading(db, {
      recordNo: input.recordNo,
      kilnId: input.kilnId,
      recordedAt,
      kind,
      dryBulbC: input.dryBulbC ?? null,
      wetBulbC: input.wetBulbC ?? null,
      weightG: input.weightG ?? null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`记录编号 ${input.recordNo} 已存在，重复上报只算一次`, 'recordNo');
    }
    throw err;
  }
  return computeKilnState(db, input.kilnId);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505';
}
