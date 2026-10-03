/**
 * 窑运行引擎：由一批已接收读数重放出整条含水率轨迹与阶段时间轴。
 *
 * 设计要点：
 * - 引擎是纯函数。状态不单独落库，任何时刻都由“批次 + 该窑全部读数”重放得到。
 *   因此晚到读数、重复处理、服务重启，结果都不变：输入集合相同，输出必相同。
 * - 读数按 (时刻升序, 记录编号升序) 规范排序后处理，与上报先后无关。
 *
 * 两次称重之间的含水率估计（详见 docs/干燥模型说明.md）：
 * - 称重值是绝对锚点：MC = m/m_绝干 − 1（绝干基），收到称重即把估计值钉到实测值。
 * - 称重之间用一阶松弛（集总参数）干燥模型向当前平衡含水率逼近：
 *     M(t+Δt) = Me + (M(t) − Me)·e^(−kΔt)
 *   Me 由最近一次干湿球读数经 RH→Simpson EMC 得到，k 为干燥速率常数（默认 0.05/h）。
 * - 湿球/干球读数只更新 Me，不改变当前 M（连续）。
 * - 相对“保持上次值”，该模型在两次称重之间也会朝 Me 下降，阶段切换更及时，
 *   代价是切换时刻依赖 k 与 Me，属于模型估计值；每次称重会被实测校正。
 *
 * 切换时刻：模型在一个干湿球区间内越过阈值时，解析解求越界时刻（秒级）；
 * 称重导致的越界记在称重时刻。一批读数连续越过多个阈值时逐阶段记录。
 */
import {
  equilibriumMoistureContentPct,
  ovenDryMassG,
  relativeHumidityPct,
  sampleMoistureContentPct,
} from './physics.js';
import type {
  BatchContext,
  KilnTimeline,
  McPoint,
  Reading,
  StageRow,
  StageTransition,
} from './types.js';

const MS_PER_HOUR = 3_600_000;

/** 越界时刻取整到秒，保证展示与存储稳定 */
function roundToSeconds(d: Date): Date {
  return new Date(Math.round(d.getTime() / 1000) * 1000);
}

export function replay(batch: BatchContext, readings: Reading[]): KilnTimeline {
  const stages = batch.stages.slice().sort((a, b) => a.stageNo - b.stageNo);
  const dryMass = ovenDryMassG(batch.initialWeightG, batch.initialMcPct);

  const ordered = readings
    .filter((r) => r.recordedAt.getTime() >= batch.startedAt.getTime())
    .sort((a, b) => {
      const t = a.recordedAt.getTime() - b.recordedAt.getTime();
      return t !== 0 ? t : a.recordNo - b.recordNo;
    });

  const t0 = batch.startedAt.getTime();
  let m = batch.initialMcPct; // 当前估计含水率 %
  let me: number | null = null; // 当前平衡含水率 %
  let lastT = t0;
  let stageIdx = 0;

  const transitions: StageTransition[] = [
    { stageNo: stages[0]!.stageNo, enteredAt: batch.startedAt, triggerRecordNo: null },
  ];
  const points: McPoint[] = [
    {
      recordNo: null,
      recordedAt: batch.startedAt,
      kind: 'anchor',
      mcPct: m,
      emcPct: null,
      rhPct: null,
      dryBulbC: null,
      wetBulbC: null,
      weightG: batch.initialWeightG,
      stageNo: stages[0]!.stageNo,
    },
  ];

  const advanceTo = (timeMs: number, triggerRecordNo: number | null) => {
    // 推进 M；若在区间内越过若干阈值，逐阶段登记切换。
    const dtH = Math.max(0, (timeMs - lastT)) / MS_PER_HOUR;
    const mStart = m;
    if (me !== null && dtH > 0) {
      m = me + (m - me) * Math.exp(-batch.dryingKPerHour * dtH);
    }
    // 检查本区间内的越界（只可能朝 Me 单调移动）
    while (stageIdx + 1 < stages.length) {
      const next = stages[stageIdx + 1]!;
      const thr = next.mcThresholdPct;
      if (thr === null || !(m < thr)) break; // 未越过
      // 越界时刻求解：M(τ)=Me+(mStart-Me)e^{-k(τ-t0int)} = thr
      let enteredAt: Date;
      if (me !== null && mStart > thr && thr > me) {
        const elapsedH =
          Math.log((mStart - me) / (thr - me)) / batch.dryingKPerHour;
        enteredAt = roundToSeconds(
          new Date(lastT + Math.min(elapsedH, dtH) * MS_PER_HOUR),
        );
      } else {
        enteredAt = roundToSeconds(new Date(timeMs));
      }
      stageIdx += 1;
      transitions.push({ stageNo: next.stageNo, enteredAt, triggerRecordNo });
    }
    lastT = timeMs;
  };

  for (const r of ordered) {
    advanceTo(r.recordedAt.getTime(), r.recordNo);

    let rh: number | null = null;
    if (r.kind === 'psychro' && r.dryBulbC !== null && r.wetBulbC !== null) {
      rh = relativeHumidityPct(r.dryBulbC, r.wetBulbC);
      me = equilibriumMoistureContentPct(r.dryBulbC, rh);
    } else if (r.kind === 'weight' && r.weightG !== null) {
      const measured = sampleMoistureContentPct(dryMass, r.weightG);
      m = measured; // 称重锚点：估计值钉到实测值
      // 称重可一次越过多个阈值，全部记在称重时刻
      while (stageIdx + 1 < stages.length) {
        const next = stages[stageIdx + 1]!;
        const thr = next.mcThresholdPct;
        if (thr === null || !(m < thr)) break;
        stageIdx += 1;
        transitions.push({
          stageNo: next.stageNo,
          enteredAt: roundToSeconds(r.recordedAt),
          triggerRecordNo: r.recordNo,
        });
      }
    }

    points.push({
      recordNo: r.recordNo,
      recordedAt: r.recordedAt,
      kind: r.kind,
      mcPct: m,
      emcPct: me,
      rhPct: rh,
      dryBulbC: r.dryBulbC,
      wetBulbC: r.wetBulbC,
      weightG: r.weightG,
      stageNo: stages[stageIdx]!.stageNo,
    });
  }

  return {
    currentStageNo: stages[stageIdx]!.stageNo,
    currentMcPct: m,
    latestEmcPct: me,
    latestRhPct: rhOfLast(points),
    transitions,
    points,
  };
}

function rhOfLast(points: McPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]!.rhPct !== null) return points[i]!.rhPct;
  }
  return null;
}

/** 供 API 复用：越界判定“严格小于”，即含水率降到阈值以下才进入下一阶段 */
export function isThresholdCrossed(mcPct: number, thresholdPct: number): boolean {
  return mcPct < thresholdPct;
}
