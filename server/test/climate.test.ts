import { describe, expect, it } from "vitest";
import {
  equilibriumMoistureContent,
  relativeHumidity,
  saturationVaporPressure,
} from "../src/domain/climate.js";

describe("湿空气 RH 推导", () => {
  it("干球=湿球时 RH=100%", () => {
    expect(relativeHumidity(20, 20)).toBeCloseTo(100, 6);
    expect(relativeHumidity(60, 60)).toBeCloseTo(100, 6);
  });

  it("20°C 干湿球 20/13.7 给出合理 RH（约 49%）", () => {
    const rh = relativeHumidity(20, 13.7);
    expect(rh).toBeGreaterThan(45);
    expect(rh).toBeLessThan(52);
  });

  it("RH 随湿球降低单调下降", () => {
    const vals = [18, 15, 12, 9].map((wb) => relativeHumidity(25, wb));
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]!).toBeLessThan(vals[i - 1]!);
    }
    expect(vals.every((v) => v > 0 && v < 100)).toBe(true);
  });

  it("饱和水汽压 100°C 接近常压沸点量级（Magnus 式高温端约 3% 偏差，湿球区间 <1%）", () => {
    const es = saturationVaporPressure(100);
    expect(es).toBeGreaterThan(98);
    expect(es).toBeLessThan(105);
  });

  it("0..40°C 湿球区间内饱和压相对误差 <1%（对照标准值 0.611/1.228/7.384 kPa）", () => {
    const cases: [number, number][] = [[0, 0.611], [10, 1.228], [40, 7.384]];
    for (const [tc, ref] of cases) {
      expect(Math.abs(saturationVaporPressure(tc) - ref) / ref).toBeLessThan(0.01);
    }
  });
});

describe("Hailwood–Horrobin EMC（Simpson, FPL 190）", () => {
  it("20°C / 65% 时约 12.0%（±0.3）", () => {
    const emc = equilibriumMoistureContent(20, 65);
    expect(Math.abs(emc - 12.0)).toBeLessThanOrEqual(0.3);
    expect(emc).toBeCloseTo(12.0, 1);
  });

  it("60°C / 80% 时约 13.6%（±0.3）", () => {
    const emc = equilibriumMoistureContent(60, 80);
    expect(Math.abs(emc - 13.6)).toBeLessThanOrEqual(0.3);
  });

  it("EMC 随湿度单调上升且为正", () => {
    const hs = [30, 45, 65, 80].map((h) => equilibriumMoistureContent(50, h));
    for (let i = 1; i < hs.length; i++) {
      expect(hs[i]!).toBeGreaterThan(hs[i - 1]!);
    }
  });
});
