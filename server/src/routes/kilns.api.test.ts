import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createPglite } from '../db/pglite.js';
import { runMigrations } from '../db/migrate.js';
import type { DbClient } from '../db/client.js';
import { computeKilnState } from '../services/kilns.service.js';

const H = 3_600_000;
const T0 = Date.parse('2026-06-01T00:00:00Z');

let app: FastifyInstance;
let db: DbClient;

beforeAll(async () => {
  const pg = createPglite();
  db = pg.db;
  await runMigrations(db);
  app = await buildApp(db);
});

async function startKiln2() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/kilns/2/batches',
    payload: {
      speciesId: 1, // 橡木 v1
      initialWeightG: 5000,
      initialMcPct: 60,
      startedAt: new Date(T0).toISOString(),
    },
  });
  expect(res.statusCode).toBe(201);
}

function psychro(recordNo: number, hour: number, dry = 60, wet = 53) {
  return {
    recordNo,
    kilnId: 2,
    recordedAt: new Date(T0 + hour * H).toISOString(),
    dryBulbC: dry,
    wetBulbC: wet,
  };
}
function weighing(recordNo: number, hour: number, grams: number) {
  return {
    recordNo,
    kilnId: 2,
    recordedAt: new Date(T0 + hour * H).toISOString(),
    weightG: grams,
  };
}

describe('窑运行 HTTP 集成', () => {
  it('引用不存在的窑开跑 → 404 指出 kilnId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kilns/99/batches',
      payload: { speciesId: 1, initialWeightG: 5000, initialMcPct: 60 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().errors[0].field).toBe('kilnId');
  });

  it('引用不存在的树种 → 422 指出 speciesId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kilns/3/batches',
      payload: { speciesId: 99, initialWeightG: 5000, initialMcPct: 60 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].field).toBe('speciesId');
  });

  it('湿球高于干球 → 400 指出 wetBulbC', async () => {
    await startKiln2();
    const res = await app.inject({
      method: 'POST',
      url: '/api/readings',
      payload: psychro(1, 1, 60, 61),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.map((e: { field: string }) => e.field)).toContain(
      'wetBulbC',
    );
  });

  it('称重为负 → 400 指出 weightG', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/readings',
      payload: weighing(2, 1, -100),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].field).toBe('weightG');
  });

  it('样板折算参考值：称到 4062.5g 时 MC=30%（严格小于语义停在阶段2）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/readings',
      payload: weighing(10, 1, 4062.5),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      state: { timeline: { currentMcPct: number; currentStageNo: number } };
    };
    expect(body.state.timeline.currentMcPct).toBeCloseTo(30, 6);
    expect(body.state.timeline.currentStageNo).toBe(2);
  });

  it('乱序上报与顺序上报的切换时刻相同', async () => {
    // 用独立的 4 号窑顺序上报；5 号窑乱序上报同一批读数
    const mk = (kilnId: number) => async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/api/kilns/${kilnId}/batches`,
        payload: {
          speciesId: 1,
          initialWeightG: 5000,
          initialMcPct: 60,
          startedAt: new Date(T0).toISOString(),
        },
      });
      expect(r.statusCode).toBe(201);
    };
    await mk(4)();
    await mk(5)();

    const readings = [];
    for (let h = 1; h <= 200; h++) {
      readings.push({ ...psychro(1000 + h, h), kilnId: 0 });
    }
    const ordered = readings.map((r) => ({ ...r, kilnId: 4 }));
    // 记录编号全局唯一：5 号窑使用独立编号段（时序等价性在引擎层已按时刻验证）
    const shuffled = shuffle(readings.slice()).map((r, i) => ({
      ...r,
      kilnId: 5,
      recordNo: 3001 + i,
    }));

    for (const r of ordered) {
      const res = await app.inject({ method: 'POST', url: '/api/readings', payload: r });
      expect(res.statusCode).toBe(201);
    }
    for (const r of shuffled) {
      const res = await app.inject({ method: 'POST', url: '/api/readings', payload: r });
      // 全部为新记录编号
      expect(res.statusCode).toBe(201);
    }

    const s4 = await computeKilnState(db, 4);
    const s5 = await computeKilnState(db, 5);
    // 编号段不同，但阶段序列与切换时刻必须完全一致
    const times = (tl: typeof s5.timeline) =>
      tl!.transitions.map((t) => [t.stageNo, t.enteredAt.toISOString()]);
    expect(times(s5.timeline)).toEqual(times(s4.timeline));
    expect(s5.timeline!.currentStageNo).toBe(s4.timeline!.currentStageNo);
  });

  it('同一记录编号重复上报只算一次（409，结果不变）', async () => {
    const before = await computeKilnState(db, 2);
    const first = await app.inject({
      method: 'POST',
      url: '/api/readings',
      payload: psychro(500, 50),
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: 'POST',
      url: '/api/readings',
      payload: psychro(500, 99), // 即使内容/时刻不同也拒绝
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().errors[0].field).toBe('recordNo');
    const after = await computeKilnState(db, 2);
    // 库里该编号仍是第一次的时刻
    const { rows } = await db.query<{ recorded_at: Date }>(
      'SELECT recorded_at FROM readings WHERE record_no=500',
    );
    expect(new Date(rows[0]!.recorded_at).getTime()).toBe(T0 + 50 * H);
    expect(after.timeline!.points.length).toBe(before.timeline!.points.length + 1);
  });

  it('晚到读数：先报晚的、再补早的，最终切换时刻与顺序上报一致', async () => {
    // 6 号窑：先按 100..200，再补 1..99
    const start = await app.inject({
      method: 'POST',
      url: '/api/kilns/6/batches',
      payload: {
        speciesId: 1,
        initialWeightG: 5000,
        initialMcPct: 60,
        startedAt: new Date(T0).toISOString(),
      },
    });
    expect(start.statusCode).toBe(201);
    for (let h = 100; h <= 200; h++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/readings',
        payload: { ...psychro(2000 + h, h), kilnId: 6 },
      });
      expect(res.statusCode).toBe(201);
    }
    for (let h = 1; h < 100; h++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/readings',
        payload: { ...psychro(2000 + h, h), kilnId: 6 },
      });
      expect(res.statusCode).toBe(201);
    }
    const s6 = await computeKilnState(db, 6);
    const s4 = await computeKilnState(db, 4); // 顺序上报的参照窑
    expect(s6.timeline!.transitions.map((t) => [t.stageNo, t.enteredAt.toISOString()])).toEqual(
      s4.timeline!.transitions.map((t) => [t.stageNo, t.enteredAt.toISOString()]),
    );
  });

  it('服务重启等价：新建 app/db 连接重放，状态不丢不重', async () => {
    // 同一个底层 PGlite 数据（模拟磁盘），重新 buildApp 后重算
    const app2 = await buildApp(db);
    const res = await app2.inject({ method: 'GET', url: '/api/kilns/4' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      timeline: { transitions: unknown[]; currentStageNo: number };
    };
    const s4 = await computeKilnState(db, 4);
    const norm = (
      ts: ReadonlyArray<{ stageNo: number; enteredAt: unknown; triggerRecordNo: number | null }>,
    ) =>
      ts.map((t) => [t.stageNo, new Date(t.enteredAt as string).toISOString(), t.triggerRecordNo]);
    expect(norm(body.timeline.transitions as never[])).toEqual(
      norm(s4.timeline!.transitions),
    );
    expect(body.timeline.currentStageNo).toBe(s4.timeline!.currentStageNo);
  });

  it('温度超出 0~120°C → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/readings',
      payload: { ...psychro(700, 3, 121, 50) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].field).toBe('dryBulbC');
  });
});

function shuffle<T>(arr: T[]): T[] {
  let s = 1234;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
