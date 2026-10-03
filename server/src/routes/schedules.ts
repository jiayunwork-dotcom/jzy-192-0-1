import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db/client.js';
import {
  buildEffectiveStages,
  addGrade,
  createDraft,
  listSpeciesVersions,
  previewDraft,
  publish,
  saveDraftOverrides,
  saveDraftStages,
  species,
  ValidationFailedError,
} from '../services/schedules.service.js';
import { listGrades, getStages } from '../db/schedules.repo.js';
import type { StageRow } from '../domain/types.js';
import type { OverrideRow } from '../domain/merge.js';

interface BodyStage {
  stageNo: number;
  mcThresholdPct: number | null;
  dryBulbC: number;
  wetBulbC: number;
}

function coerceStages(raw: unknown): { stages?: StageRow[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'stages 必须是数组' };
  const stages: StageRow[] = [];
  for (const [i, item] of raw.entries()) {
    const r = item as Partial<BodyStage>;
    if (
      typeof r?.stageNo !== 'number' ||
      typeof r.dryBulbC !== 'number' ||
      typeof r.wetBulbC !== 'number' ||
      (r.mcThresholdPct !== null && typeof r.mcThresholdPct !== 'number')
    ) {
      return { error: `第 ${i + 1} 行字段类型不正确` };
    }
    stages.push({
      stageNo: r.stageNo,
      mcThresholdPct: r.mcThresholdPct,
      dryBulbC: r.dryBulbC,
      wetBulbC: r.wetBulbC,
    });
  }
  return { stages };
}

export function registerScheduleRoutes(app: FastifyInstance, db: DbClient): void {
  // 树种列表 / 新增
  app.get('/api/species', async () => species.list(db));
  app.post('/api/species', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || !name.trim()) {
      return reply.status(400).send({
        errors: [{ field: 'name', message: '树种名称不能为空' }],
      });
    }
    try {
      const row = await species.create(db, name.trim());
      return reply.status(201).send(row);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({
          errors: [{ field: 'name', message: '树种名称已存在' }],
        });
      }
      throw err;
    }
  });

  // 版本列表
  app.get('/api/species/:speciesId/versions', async (req, reply) => {
    const speciesId = Number((req.params as { speciesId: string }).speciesId);
    try {
      return await listSpeciesVersions(db, speciesId);
    } catch (err) {
      if (err instanceof ValidationFailedError) {
        return reply.status(404).send({ errors: err.errors });
      }
      throw err;
    }
  });

  // 某已发布版本的有效基准（含厚度层），发布后只读查看
  app.get(
    '/api/versions/:versionId/effective',
    async (req, reply) => {
      const versionId = Number((req.params as { versionId: string }).versionId);
      const gradeCode = (req.query as { grade?: string }).grade ?? null;
      let gradeId: number | null = null;
      if (gradeCode) {
        const { rows } = await db.query<{ id: number }>(
          'SELECT id FROM thickness_grades WHERE code=$1',
          [gradeCode],
        );
        if (!rows[0]) {
          return reply.status(404).send({
            errors: [{ field: 'grade', message: '厚度等级不存在' }],
          });
        }
        gradeId = Number(rows[0].id);
      }
      const baseStages = await getStages(db, versionId);
      if (baseStages.length === 0) {
        return reply.status(404).send({
          errors: [{ field: 'versionId', message: '版本不存在或没有阶段表' }],
        });
      }
      return { baseStages, effectiveStages: await buildEffectiveStages(db, versionId, gradeId) };
    },
  );

  // 新建编辑稿
  app.post('/api/species/:speciesId/draft', async (req, reply) => {
    const speciesId = Number((req.params as { speciesId: string }).speciesId);
    const note = ((req.body as { note?: string } | null)?.note ?? null) as
      | string
      | null;
    try {
      const draft = await createDraft(db, speciesId, note);
      return reply.status(201).send(draft);
    } catch (err) {
      if (err instanceof ValidationFailedError) {
        return reply.status(404).send({ errors: err.errors });
      }
      const name = (err as Error).name;
      if (name === 'DraftExistsError') {
        const e = err as { draftId: number; message: string };
        return reply.status(409).send({
          errors: [{ field: 'draft', message: e.message }],
          draftId: e.draftId,
        });
      }
      throw err;
    }
  });

  // 保存基础阶段表
  app.put('/api/species/:speciesId/draft/stages', async (req, reply) => {
    const speciesId = Number((req.params as { speciesId: string }).speciesId);
    const raw = (req.body as { stages?: unknown } | null)?.stages;
    const { stages, error } = coerceStages(raw);
    if (error || !stages) {
      return reply.status(400).send({
        errors: [{ field: 'stages', message: error ?? 'stages 缺失' }],
      });
    }
    try {
      const draft = await saveDraftStages(db, speciesId, stages);
      return { draft, baseStages: await getStages(db, draft.id) };
    } catch (err) {
      if (err instanceof ValidationFailedError) {
        return reply.status(422).send({ errors: err.errors });
      }
      throw err;
    }
  });

  // 厚度等级：列表与新增
  app.get('/api/species/:speciesId/grades', async (req) => {
    const speciesId = Number((req.params as { speciesId: string }).speciesId);
    return listGrades(db, speciesId);
  });
  app.post('/api/species/:speciesId/grades', async (req, reply) => {
    const speciesId = Number((req.params as { speciesId: string }).speciesId);
    const { code, label } = (req.body ?? {}) as { code?: string; label?: string };
    if (typeof code !== 'string' || !code.trim() || typeof label !== 'string' || !label.trim()) {
      return reply.status(400).send({
        errors: [{ field: 'code', message: '厚度等级编码与名称都不能为空' }],
      });
    }
    try {
      const g = await addGrade(db, speciesId, code.trim(), label.trim());
      return reply.status(201).send(g);
    } catch (err) {
      if (err instanceof ValidationFailedError) {
        return reply.status(404).send({ errors: err.errors });
      }
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({
          errors: [{ field: 'code', message: '厚度等级编码已存在' }],
        });
      }
      throw err;
    }
  });

  // 保存某厚度层覆盖
  app.put(
    '/api/species/:speciesId/draft/grades/:gradeCode/overrides',
    async (req, reply) => {
      const speciesId = Number((req.params as { speciesId: string }).speciesId);
      const gradeCode = (req.params as { gradeCode: string }).gradeCode;
      const raw = (req.body as { overrides?: unknown } | null)?.overrides;
      if (!Array.isArray(raw)) {
        return reply.status(400).send({
          errors: [{ field: 'overrides', message: 'overrides 必须是数组' }],
        });
      }
      const overrides: OverrideRow[] = [];
      for (const [i, item] of raw.entries()) {
        const o = item as Partial<OverrideRow>;
        if (typeof o?.stageNo !== 'number') {
          return reply.status(400).send({
            errors: [{ field: `overrides[${i}].stageNo`, message: '阶段号必须是数字' }],
          });
        }
        overrides.push({
          stageNo: o.stageNo,
          mcThresholdPct:
            o.mcThresholdPct === undefined ? undefined : o.mcThresholdPct,
          dryBulbC: o.dryBulbC === undefined ? undefined : o.dryBulbC,
          wetBulbC: o.wetBulbC === undefined ? undefined : o.wetBulbC,
        });
      }
      try {
        const draft = await saveDraftOverrides(db, speciesId, gradeCode, overrides);
        const preview = await previewDraft(db, speciesId, gradeCode);
        return { draft, effectiveStages: preview.effectiveStages };
      } catch (err) {
        if (err instanceof ValidationFailedError) {
          return reply.status(422).send({ errors: err.errors });
        }
        throw err;
      }
    },
  );

  // 合并预览（草稿；逐格带来源）
  app.get('/api/species/:speciesId/draft/preview', async (req, reply) => {
    const speciesId = Number((req.params as { speciesId: string }).speciesId);
    const gradeCode = (req.query as { grade?: string }).grade ?? null;
    try {
      return await previewDraft(db, speciesId, gradeCode);
    } catch (err) {
      if (err instanceof ValidationFailedError) {
        return reply.status(404).send({ errors: err.errors });
      }
      throw err;
    }
  });

  // 发布
  app.post('/api/species/:speciesId/publish', async (req, reply) => {
    const speciesId = Number((req.params as { speciesId: string }).speciesId);
    try {
      const v = await publish(db, speciesId);
      return {
        ...v,
        effectiveStages: await buildEffectiveStages(db, v.id, null),
      };
    } catch (err) {
      if (err instanceof ValidationFailedError) {
        return reply.status(422).send({ errors: err.errors });
      }
      throw err;
    }
  });
}
