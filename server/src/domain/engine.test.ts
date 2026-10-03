import { describe, expect, it } from 'vitest';
import { replay } from './engine.js';
import { equilibriumMoistureContentPct, relativeHumidityPct } from './physics.js';
import type { BatchContext, Reading } from './types.js';

const H = 3_600_000;
const start = new Date('2026-05-01T00:00:00Z').getTime();

const stages = [
  { stageNo: 1, mcThresholdPct: null, dryBulbC: 60, wetBulbC: 55 },
  { stageNo: 2, mcThresholdPct: 40, dryBulbC: 65, wetBulbC: 56 },
  { stageNo: 3, mcThresholdPct: 30, dryBulbC: 70, wetBulbC: 57 },
  { stageNo: 4, mcThresholdPct: 20, dryBulbC: 75, wetBulbC: 60 },
  { stageNo: 5, mcThresholdPct: 12, dryBulbC: 80, wetBulbC: 65 },
];

function batch(k = 0.05): BatchContext {
  return {
    kilnId: 1,
    startedAt: new Date(start),
    initialWeightG: 5000,
    initialMcPct: 60,
    dryingKPerHour: k,
    stages,
  };
}

// 60°C 干球、54°C 湿球 → RH≈73%，EMC≈11.7%，足以越过最后 12% 阈值
const DRY = 60;
const WET = 54;

function psychro(rec: number, hour: number): Reading {
  return {
    recordNo: rec,
    kilnId: 1,
    recordedAt: new Date(start + hour * H),
    kind: 'psychro',
    dryBulbC: DRY,
    wetBulbC: WET,
    weightG: null,
  };
}
function weight(rec: number, hour: number, grams: number): Reading {
  return {
    recordNo: rec,
    kilnId: 1,
    recordedAt: new Date(start + hour * H),
    kind: 'weight',
    dryBulbC: null,
    wetBulbC: null,
    weightG: grams,
  };
}

function shuffled<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('运行引擎', () => {
  it('初始在第1阶段，锚点 MC 为初始含水率', () => {
    const t = replay(batch(), []);
    expect(t.currentStageNo).toBe(1);
    expect(t.transitions).toEqual([
      { stageNo: 1, enteredAt: new Date(start), triggerRecordNo: null },
    ]);
    expect(t.currentMcPct).toBe(60);
  });

  it('干湿球推出 RH 与 EMC，模型向 EMC 单调逼近', () => {
    const readings: Reading[] = [];
    for (let h = 1; h <= 20; h++) readings.push(psychro(h, h));
    const t = replay(batch(), readings);
    const rh = relativeHumidityPct(DRY, WET);
    const me = equilibriumMoistureContentPct(DRY, rh);
    expect(t.latestRhPct).toBeCloseTo(rh, 8);
    expect(t.latestEmcPct).toBeCloseTo(me, 8);
    // MC 应在 60 与 Me 之间，且单调下降
    expect(t.currentMcPct).toBeGreaterThan(me);
    expect(t.currentMcPct).toBeLessThan(60);
    const mcs = t.points.map((p) => p.mcPct);
    for (let i = 1; i < mcs.length; i++) expect(mcs[i]).lte(mcs[i - 1]!);
  });

  it('乱序上报与顺序上报的阶段切换时刻完全相同', () => {
    const readings: Reading[] = [];
    for (let h = 1; h <= 400; h++) readings.push(psychro(h, h));

    const ordered = replay(batch(), readings);
    expect(ordered.currentStageNo).toBe(5); // Me≈10%，足够越过最后12%阈值
    const variants = [
      shuffled(readings, 1),
      shuffled(readings, 2),
      shuffled(readings, 42),
      [...readings].reverse(),
    ];
    for (const v of variants) {
      const got = replay(batch(), v);
      // 切换时刻（序列、阶段、触发读数）逐条一致
      expect(
        got.transitions.map((x) => [x.stageNo, x.enteredAt.toISOString(), x.triggerRecordNo]),
      ).toEqual(
        ordered.transitions.map((x) => [
          x.stageNo,
          x.enteredAt.toISOString(),
          x.triggerRecordNo,
        ]),
      );
      // 最终状态一致
      expect(got.currentStageNo).toBe(ordered.currentStageNo);
      expect(got.currentMcPct).toBeCloseTo(ordered.currentMcPct, 10);
      expect(got.points).toHaveLength(ordered.points.length);
    }
  });

  it('称重锚点：MC 恰为 30% 时停在阈值 30 的阶段（严格小于，等于不切换）', () => {
    const readings = [
      psychro(1, 1),
      weight(2, 2, 4062.5), // 绝干3125 → MC 30%
    ];
    const t = replay(batch(), readings);
    expect(t.currentMcPct).toBeCloseTo(30, 9);
    // 越过了 40%（进阶段2），但 30% 不 < 30%，不进阶段3
    expect(t.currentStageNo).toBe(2);
  });

  it('称重 29.9% 严格低于 30%，进入阶段3', () => {
    const dry = 3125;
    const readings = [
      psychro(1, 1),
      weight(2, 2, dry * 1.299), // 29.9%
    ];
    expect(replay(batch(), readings).currentStageNo).toBe(3);
  });

  it('称重骤降可一次跨越多阶段，全部切换记在称重时刻', () => {
    const readings = [
      psychro(1, 1),
      weight(2, 2, 3187.5), // MC≈2% → 越过所有阈值
    ];
    const t = replay(batch(), readings);
    expect(t.currentStageNo).toBe(5);
    const crossed = t.transitions.slice(1);
    expect(crossed.every((x) => x.enteredAt.getTime() === start + 2 * H)).toBe(true);
    expect(crossed.every((x) => x.triggerRecordNo === 2)).toBe(true);
  });

  it('晚到读数插在中间会重算，但结果等价于按时序上报', () => {
    // 先只给后半段，再“补”一条更早的关键读数；最终集合相同，结果必相同
    const full: Reading[] = [];
    for (let h = 1; h <= 100; h++) full.push(psychro(h, h));
    const tail = full.slice(50);
    const a = replay(batch(), tail);
    const b = replay(batch(), [...tail, ...full.slice(0, 50)]);
    const c = replay(batch(), full);
    expect(a.transitions.map((x) => x.enteredAt.toISOString())).not.toEqual(
      c.transitions.map((x) => x.enteredAt.toISOString()),
    );
    expect(b.transitions.map((x) => x.enteredAt.toISOString())).toEqual(
      c.transitions.map((x) => x.enteredAt.toISOString()),
    );
  });

  it('同刻读数按记录编号定序，结果确定', () => {
    const r1 = psychro(1, 5);
    const r2 = psychro(2, 5);
    const t1 = replay(batch(), [r1, r2]);
    const t2 = replay(batch(), [r2, r1]);
    expect(t1.points.map((p) => p.recordNo)).toEqual(
      t2.points.map((p) => p.recordNo),
    );
  });

  it('解析越界时刻落在相邻两个读数之间，且为秒级取整', () => {
    const readings: Reading[] = [];
    for (let h = 1; h <= 400; h++) readings.push(psychro(h, h));
    const t = replay(batch(), readings);
    const enter40 = t.transitions.find((x) => x.stageNo === 2)!;
    const ms = enter40.enteredAt.getTime();
    expect(ms % 1000).toBe(0);
    // 必然在开跑之后、某个整点读数附近；且严格大于开跑
    expect(ms).toBeGreaterThan(start);
    // 越过时刻之前重放，还停在阶段1；时刻上的下一条读数已在阶段2
    const before = replay(
      batch(),
      readings.filter((r) => r.recordedAt.getTime() < ms),
    );
    expect(before.currentStageNo).toBe(1);
  });
});
