import { describe, expect, it } from "vitest";
import { mergeSchedule, validateSchedule } from "../src/domain/merge.js";
import type { OverrideRow, StageRow } from "../src/domain/types.js";

const oak: StageRow[] = [
  { stageNo: 1, enterBelow: null, dryBulb: 45, wetBulb: 42 },
  { stageNo: 2, enterBelow: 40, dryBulb: 50, wetBulb: 45 },
  { stageNo: 3, enterBelow: 30, dryBulb: 55, wetBulb: 45 },
  { stageNo: 4, enterBelow: 20, dryBulb: 65, wetBulb: 45 },
];

describe("两层基准合并", () => {
  it("无覆盖时全部继承基础表，来源标 base", () => {
    const m = mergeSchedule(oak, []);
    expect(m).toHaveLength(4);
    for (const row of m) {
      expect(row.sources).toEqual({
        enterBelow: "base",
        dryBulb: "base",
        wetBulb: "base",
      });
    }
    expect(m[0]!.enterBelow).toBeNull();
  });

  it("厚度层只写不同的格：写了的标 override，没写的继承 base", () => {
    const thick: OverrideRow[] = [
      { stageNo: 3, dryBulb: 60 },
      { stageNo: 4, dryBulb: 72, wetBulb: 48 },
    ];
    const m = mergeSchedule(oak, thick);

    expect(m[2]!.dryBulb).toBe(60);
    expect(m[2]!.sources.dryBulb).toBe("override");
    expect(m[2]!.wetBulb).toBe(45);
    expect(m[2]!.sources.wetBulb).toBe("base");
    expect(m[2]!.enterBelow).toBe(30);
    expect(m[2]!.sources.enterBelow).toBe("base");

    expect(m[3]!.dryBulb).toBe(72);
    expect(m[3]!.wetBulb).toBe(48);
    expect(m[3]!.sources.dryBulb).toBe("override");
    expect(m[3]!.sources.wetBulb).toBe("override");
  });

  it("覆盖进入条件后合并表数值同步变化", () => {
    const m = mergeSchedule(oak, [{ stageNo: 4, enterBelow: 18 }]);
    expect(m[3]!.enterBelow).toBe(18);
    expect(m[3]!.sources.enterBelow).toBe("override");
  });
});

describe("基准校验", () => {
  it("进入条件不逐行递减被拒并指出字段", () => {
    const bad: StageRow[] = [
      { stageNo: 1, enterBelow: null, dryBulb: 45, wetBulb: 42 },
      { stageNo: 2, enterBelow: 30, dryBulb: 50, wetBulb: 45 },
      { stageNo: 3, enterBelow: 30, dryBulb: 55, wetBulb: 45 },
    ];
    const errs = validateSchedule(bad, {});
    expect(errs.some((e) => e.field.includes("enterBelow"))).toBe(true);
  });

  it("升温反序（本行 40 比上行 30 大）被拒", () => {
    const bad: StageRow[] = [
      { stageNo: 1, enterBelow: null, dryBulb: 45, wetBulb: 42 },
      { stageNo: 2, enterBelow: 30, dryBulb: 50, wetBulb: 45 },
      { stageNo: 3, enterBelow: 40, dryBulb: 55, wetBulb: 45 },
    ];
    expect(validateSchedule(bad, {}).some((e) => e.field.includes("enterBelow"))).toBe(true);
  });

  it("湿球高于干球被拒", () => {
    const bad: StageRow[] = [
      { stageNo: 1, enterBelow: null, dryBulb: 40, wetBulb: 42 },
    ];
    expect(validateSchedule(bad, {}).map((e) => e.field)).toContain("base[0].wetBulb");
  });

  it("温度超出 0-120 被拒", () => {
    const bad: StageRow[] = [
      { stageNo: 1, enterBelow: null, dryBulb: 130, wetBulb: 42 },
    ];
    expect(validateSchedule(bad, {}).map((e) => e.field)).toContain("base[0].dryBulb");
    const bad2: StageRow[] = [
      { stageNo: 1, enterBelow: null, dryBulb: 45, wetBulb: -1 },
    ];
    expect(validateSchedule(bad2, {}).map((e) => e.field)).toContain("base[0].wetBulb");
  });

  it("覆盖后破坏递减/湿球>干球也被拒", () => {
    const errs = validateSchedule(oak, {
      thick: [{ stageNo: 4, enterBelow: 35 }], // 35 > 上一行 30
    });
    expect(errs.some((e) => e.field.startsWith("overridesByGrade.thick"))).toBe(true);

    const errs2 = validateSchedule(oak, {
      thick: [{ stageNo: 2, dryBulb: 40, wetBulb: 45 }],
    });
    expect(errs2.some((e) => e.field.startsWith("overridesByGrade.thick"))).toBe(true);
  });

  it("合法表通过", () => {
    expect(validateSchedule(oak, { thick: [{ stageNo: 3, dryBulb: 60 }] })).toEqual([]);
  });
});
