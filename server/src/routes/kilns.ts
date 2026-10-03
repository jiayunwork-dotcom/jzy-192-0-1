import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DbClient } from '../db/client.js';
import { listReadings } from '../db/kilns.repo.js';
import {
  ApiValidationError,
  computeKilnState,
  ConflictError,
  NotFoundError,
  overview,
  startKilnBatch,
  stopKilnBatch,
  submitReading,
} from '../services/kilns.service.js';
import { ValidationFailedError as ScheduleValidationError } from '../services/schedules.service.js';
import { DraftExistsError } from '../db/schedules.repo.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof ApiValidationError) {
    return reply.status(400).send({ errors: err.errors });
  }
  if (err instanceof ScheduleValidationError) {
    // 引用的树种不存在 / 尚无已发布基准等，属于请求语义不可处理
    return reply.status(422).send({ errors: err.errors });
  }
  if (err instanceof NotFoundError) {
    return reply.status(404).send({ errors: [{ field: err.field, message: err.message }] });
  }
  if (err instanceof ConflictError || err instanceof DraftExistsError) {
    const field = err instanceof ConflictError ? err.field : 'draft';
    return reply.status(409).send({ errors: [{ field, message: err.message }] });
  }
  throw err;
}

export function registerKilnRoutes(app: FastifyInstance, db: DbClient): void {
  // 六座窑总览：当前阶段、含水率
  app.get('/api/kilns', async () => overview(db));

  // 单窑详情：含水率曲线 + 阶段时间轴 + 有效基准
  app.get('/api/kilns/:kilnId', async (req, reply) => {
    const kilnId = Number((req.params as { kilnId: string }).kilnId);
    if (!Number.isInteger(kilnId) || kilnId <= 0) {
      return reply.status(400).send({
        errors: [{ field: 'kilnId', message: '窑号必须是正整数' }],
      });
    }
    const state = await computeKilnState(db, kilnId);
    if (state.batch === null) {
      const { listKilns } = await import('../db/kilns.repo.js');
      const kilns = await listKilns(db);
      if (!kilns.some((k) => k.id === kilnId)) {
        return reply.status(404).send({
          errors: [{ field: 'kilnId', message: `窑 ${kilnId} 不存在` }],
        });
      }
      return { kilnId, running: false, batch: null, timeline: null, stages: null };
    }
    return {
      kilnId,
      running: true,
      batch: state.batch,
      timeline: state.timeline,
      stages: state.context?.stages ?? null,
    };
  });

  // 读数原始记录（便于页面补录后核对）
  app.get('/api/kilns/:kilnId/readings', async (req, reply) => {
    const kilnId = Number((req.params as { kilnId: string }).kilnId);
    const { kilnExists } = await import('../db/kilns.repo.js');
    if (!(await kilnExists(db, kilnId))) {
      return reply.status(404).send({
        errors: [{ field: 'kilnId', message: `窑 ${kilnId} 不存在` }],
      });
    }
    return { readings: await listReadings(db, kilnId) };
  });

  // 装料开跑：绑定当时有效版本
  app.post('/api/kilns/:kilnId/batches', async (req, reply) => {
    const kilnId = Number((req.params as { kilnId: string }).kilnId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const out = await startKilnBatch(db, {
        kilnId,
        speciesId: body.speciesId as number,
        thicknessGrade: (body.thicknessGrade as string | null | undefined) ?? null,
        initialWeightG: body.initialWeightG as number,
        initialMcPct: body.initialMcPct as number,
        dryingKPerHour:
          body.dryingKPerHour === undefined ? null : (body.dryingKPerHour as number),
        startedAt: (body.startedAt as string | undefined) ?? null,
      });
      return reply.status(201).send({ batchId: out.batchId, state: out.state });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 收料结束
  app.post('/api/kilns/:kilnId/finish', async (req, reply) => {
    const kilnId = Number((req.params as { kilnId: string }).kilnId);
    try {
      return await stopKilnBatch(db, kilnId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 读数上报 / 手工补录（同一入口，乱序由重放兜底）
  app.post('/api/readings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const state = await submitReading(db, {
        recordNo: body.recordNo as number,
        kilnId: body.kilnId as number,
        recordedAt: body.recordedAt as string,
        dryBulbC: body.dryBulbC as number | undefined,
        wetBulbC: body.wetBulbC as number | undefined,
        weightG: body.weightG as number | undefined,
      });
      return reply.status(201).send({ ok: true, state });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
