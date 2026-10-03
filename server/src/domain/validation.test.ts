import { describe, expect, it } from 'vitest';
import { validateReading, validateStages } from './validation.js';

describe('基准表校验', () => {
  it('湿球高于干球 → 拒收并指出字段', () => {
    const errs = validateStages([
      { stageNo: 1, mcThresholdPct: null, dryBulbC: 60, wetBulbC: 61 },
    ]);
    expect(errs.some((e) => e.field.includes('湿球温度'))).toBe(true);
  });

  it('温度超出 0~120°C → 拒收', () => {
    const errs = validateStages([
      { stageNo: 1, mcThresholdPct: null, dryBulbC: 130, wetBulbC: 60 },
    ]);
    expect(errs.some((e) => e.field.includes('干球温度'))).toBe(true);
  });

  it('进入条件未逐行递减 → 拒收', () => {
    const errs = validateStages([
      { stageNo: 1, mcThresholdPct: null, dryBulbC: 50, wetBulbC: 45 },
      { stageNo: 2, mcThresholdPct: 40, dryBulbC: 60, wetBulbC: 50 },
      { stageNo: 3, mcThresholdPct: 40, dryBulbC: 70, wetBulbC: 55 },
    ]);
    expect(errs.some((e) => e.field.includes('进入条件'))).toBe(true);
  });

  it('合法表通过', () => {
    const errs = validateStages([
      { stageNo: 1, mcThresholdPct: null, dryBulbC: 50, wetBulbC: 45 },
      { stageNo: 2, mcThresholdPct: 40, dryBulbC: 60, wetBulbC: 50 },
      { stageNo: 3, mcThresholdPct: 12, dryBulbC: 70, wetBulbC: 55 },
    ]);
    expect(errs).toHaveLength(0);
  });
});

describe('读数校验', () => {
  it('湿球高于干球', () => {
    const errs = validateReading({
      recordNo: 1,
      kilnId: 1,
      recordedAt: '2026-01-01T00:00:00Z',
      dryBulbC: 50,
      wetBulbC: 51,
    });
    expect(errs.some((e) => e.field === 'wetBulbC')).toBe(true);
  });

  it('称重为负', () => {
    const errs = validateReading({
      recordNo: 1,
      kilnId: 1,
      recordedAt: '2026-01-01T00:00:00Z',
      weightG: -5,
    });
    expect(errs.some((e) => e.field === 'weightG')).toBe(true);
  });

  it('记录编号缺失', () => {
    const errs = validateReading({
      recordNo: 'abc' as unknown as number,
      kilnId: 1,
      recordedAt: '2026-01-01T00:00:00Z',
      weightG: 4000,
    });
    expect(errs.some((e) => e.field === 'recordNo')).toBe(true);
  });

  it('温度与称重不能同时出现', () => {
    const errs = validateReading({
      recordNo: 1,
      kilnId: 1,
      recordedAt: '2026-01-01T00:00:00Z',
      dryBulbC: 50,
      wetBulbC: 45,
      weightG: 4000,
    });
    expect(errs.some((e) => e.field === 'readings')).toBe(true);
  });
});
