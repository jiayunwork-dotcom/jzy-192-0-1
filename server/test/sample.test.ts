import { describe, expect, it } from "vitest";
import { dryMass, sampleMoistureContent } from "../src/domain/sample.js";

describe("样板绝干折算", () => {
  const spec = { initialWeightG: 5000, initialMcPercent: 60 };

  it("绝干质量 = 3125 克", () => {
    expect(dryMass(spec)).toBeCloseTo(3125, 6);
  });

  it("题面参考值：5000g@60% 初始，称得 4062.5g 时 MC=30%", () => {
    expect(sampleMoistureContent(spec, 4062.5)).toBeCloseTo(30, 6);
  });

  it("初称即 60%，烘到绝干为 0，继续降到负值前（称重<绝干）会被业务层拦截", () => {
    expect(sampleMoistureContent(spec, 5000)).toBeCloseTo(60, 6);
    expect(sampleMoistureContent(spec, 3125)).toBeCloseTo(0, 6);
  });
});
