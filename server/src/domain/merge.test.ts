import { describe, expect, it } from 'vitest';
import { mergeSchedule, toStageRows } from './merge.js';
import type { StageRow } from './types.js';

const base: StageRow[] = [
  { stageNo: 1, mcThresholdPct: null, dryBulbC: 60, wetBulbC: 56 },
  { stageNo: 2, mcThresholdPct: 40, dryBulbC: 65, wetBulbC: 57 },
  { stageNo: 3, mcThresholdPct: 30, dryBulbC: 70, wetBulbC: 58 },
];

describe('两层基准合并', () => {
  it('无覆盖时所有格子来自基础表', () => {
    const eff = mergeSchedule(base, []);
    expect(eff).toHaveLength(3);
    expect(eff[1]!.dryBulbC).toEqual({ value: 65, source: 'base' });
    expect(eff[0]!.mcThresholdPct).toEqual({ value: null, source: null });
  });

  it('厚度层只写不同的格子：覆盖的标 override，未写的继承 base', () => {
    const eff = mergeSchedule(base, [
      { stageNo: 2, dryBulbC: 60 },
      { stageNo: 3, dryBulbC: 65, wetBulbC: 55 },
    ]);
    expect(eff[1]!.dryBulbC).toEqual({ value: 60, source: 'override' });
    // 湿球未写 → 继承
    expect(eff[1]!.wetBulbC).toEqual({ value: 57, source: 'base' });
    expect(eff[1]!.mcThresholdPct).toEqual({ value: 40, source: 'base' });
    expect(eff[2]!.wetBulbC).toEqual({ value: 55, source: 'override' });
  });

  it('toStageRows 去掉标注后的有效基准与预览数值一致', () => {
    const eff = mergeSchedule(base, [{ stageNo: 3, dryBulbC: 66 }]);
    const rows = toStageRows(eff);
    expect(rows[2]).toEqual({
      stageNo: 3,
      mcThresholdPct: 30,
      dryBulbC: 66,
      wetBulbC: 58,
    });
  });
});
