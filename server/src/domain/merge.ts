/**
 * 两层基准合并：树种基础表 × 厚度等级覆盖。
 * 厚度层只写“与基础表不同”的格子；未写（null）的格子继承基础表。
 *
 * 覆盖以“阶段号”为行键对齐——厚度层不改变阶段结构与进入条件顺序，
 * 只覆盖同阶段行的温度（也允许覆盖进入条件）。
 */
import type {
  EffectiveStageRow,
  SourcedCell,
  StageRow,
} from './types.js';

export interface OverrideRow {
  stageNo: number;
  mcThresholdPct?: number | null;
  dryBulbC?: number | null;
  wetBulbC?: number | null;
}

function pick(
  base: number,
  override: number | null | undefined,
): SourcedCell<number> {
  if (override === null || override === undefined) {
    return { value: base, source: 'base' };
  }
  return { value: override, source: 'override' };
}

/**
 * 合并基础表与厚度覆盖，输出逐格带来源标注的有效基准（即合并预览）。
 * 预览/发布后有效基准用的是同一个函数，保证“所见即所发布”。
 */
export function mergeSchedule(
  base: StageRow[],
  overrides: OverrideRow[],
): EffectiveStageRow[] {
  const byStage = new Map<number, OverrideRow>();
  for (const o of overrides) byStage.set(o.stageNo, o);

  return base
    .slice()
    .sort((a, b) => a.stageNo - b.stageNo)
    .map((row) => {
      const ov = byStage.get(row.stageNo);
      const threshold: SourcedCell<number | null> =
        row.mcThresholdPct === null
          ? { value: null, source: null }
          : pick(row.mcThresholdPct, ov?.mcThresholdPct ?? undefined);
      return {
        stageNo: row.stageNo,
        mcThresholdPct: threshold,
        dryBulbC: pick(row.dryBulbC, ov?.dryBulbC),
        wetBulbC: pick(row.wetBulbC, ov?.wetBulbC),
      };
    });
}

/** 去掉来源标注，返回引擎使用的纯阶段行 */
export function toStageRows(effective: EffectiveStageRow[]): StageRow[] {
  return effective.map((r) => ({
    stageNo: r.stageNo,
    mcThresholdPct: r.mcThresholdPct.value,
    dryBulbC: r.dryBulbC.value,
    wetBulbC: r.wetBulbC.value,
  }));
}
