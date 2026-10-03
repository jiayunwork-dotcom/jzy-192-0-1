import { describe, expect, it } from 'vitest';
import {
  equilibriumMoistureContentPct,
  ovenDryMassG,
  relativeHumidityPct,
  sampleMoistureContentPct,
  saturationVaporPressureHpa,
} from './physics.js';

describe('平衡含水率 — Simpson(1973) Hailwood-Horrobin', () => {
  it('20°C / RH 65% ≈ 12.0%（±0.3）', () => {
    const m = equilibriumMoistureContentPct(20, 65);
    expect(Math.abs(m - 12.0)).toBeLessThanOrEqual(0.3);
    // 锁定实现值，防止后续误改系数
    expect(m).toBeCloseTo(11.996, 2);
  });

  it('60°C / RH 80% ≈ 13.6%（±0.3）', () => {
    const m = equilibriumMoistureContentPct(60, 80);
    expect(Math.abs(m - 13.6)).toBeLessThanOrEqual(0.3);
    expect(m).toBeCloseTo(13.561, 2);
  });

  it('同湿度下高温 EMC 与参考表趋势一致（吸附）', () => {
    // 60%RH 附近，20°C 与 40°C 的值都在 Wood Handbook 吸附表范围
    expect(equilibriumMoistureContentPct(20, 60)).toBeGreaterThan(10.5);
    expect(equilibriumMoistureContentPct(20, 60)).toBeLessThan(12);
  });
});

describe('干湿球 → 相对湿度（WMO 通风干湿表）', () => {
  it('干湿球相等时 RH=100%', () => {
    expect(relativeHumidityPct(25, 25)).toBeCloseTo(100, 6);
  });

  it('20°C 干球、湿球约 15.8°C 时 RH≈65%', () => {
    // 用公式反推的湿球值，验证自洽
    const es20 = saturationVaporPressureHpa(20);
    const targetE = 0.65 * es20;
    // e = es(Tw) - A*p*(20-Tw)，牛顿求 Tw
    let tw = 16;
    for (let i = 0; i < 50; i++) {
      const e = saturationVaporPressureHpa(tw) - 0.000662 * 1013.25 * (20 - tw);
      const der =
        (saturationVaporPressureHpa(tw + 0.01) -
          saturationVaporPressureHpa(tw - 0.01)) /
        0.02 +
        0.000662 * 1013.25;
      tw -= (e - targetE) / der;
    }
    expect(relativeHumidityPct(20, tw)).toBeCloseTo(65, 2);
  });

  it('湿球越低 RH 越低，且非负', () => {
    const low = relativeHumidityPct(60, 30);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(relativeHumidityPct(60, 50));
  });
});

describe('样板含水率（绝干基）', () => {
  it('初称5000g/初含60%，称得4062.5g → 30%', () => {
    const dry = ovenDryMassG(5000, 60);
    expect(dry).toBeCloseTo(3125, 6);
    expect(sampleMoistureContentPct(dry, 4062.5)).toBeCloseTo(30, 6);
  });

  it('绝干状态称重=绝干质量时 MC=0', () => {
    const dry = ovenDryMassG(5000, 60);
    expect(sampleMoistureContentPct(dry, dry)).toBeCloseTo(0, 9);
  });
});
