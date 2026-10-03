import { describe, expect, it } from "vitest";
import { replayRun, validateReading } from "../src/domain/run.js";
import type { MergedRow, ReadingInput } from "../src/domain/types.js";

// 绝干 3125g 样板；阈值 40 / 30 / 20
const spec = { initialWeightG: 5000, initialMcPercent: 60 };
const merged: MergedRow[] = [
  { stageNo: 1, enterBelow: null, dryBulb: 45, wetBulb: 42,
    sources: { enterBelow: "base", dryBulb: "base", wetBulb: "base" } },
  { stageNo: 2, enterBelow: 40, dryBulb: 50, wetBulb: 45,
    sources: { enterBelow: "base", dryBulb: "base", wetBulb: "base" } },
  { stageNo: 3, enterBelow: 30, dryBulb: 55, wetBulb: 45,
    sources: { enterBelow: "base", dryBulb: "base", wetBulb: "base" } },
  { stageNo: 4, enterBelow: 20, dryBulb: 65, wetBulb: 45,
    sources: { enterBelow: "base", dryBulb: "base", wetBulb: "base" } },
];

const t = (h: number) => new Date(Date.UTC(2026, 8, 1, 8 + h)).toISOString();

const w = (no: number, hour: number, grams: number): ReadingInput => ({
  recordNo: no, kilnNo: 1, takenAt: t(hour), weightG: grams,
});
const temp = (no: number, hour: number, db: number, wb: number): ReadingInput => ({
  recordNo: no, kilnNo: 1, takenAt: t(hour), dryBulb: db, wetBulb: wb,
});

describe("阶段重放：乱序/顺序/重启等价", () => {
  const inOrder: ReadingInput[] = [
    w(1, 0, 4900),
    temp(2, 1, 50, 45),
    w(3, 2, 4300), // MC = (4300-3125)/3125 = 37.6% → 进入阶段 2
    w(4, 4, 4062.5), // 30% —— 严格小于 30 才进 3，停留在 2
    w(5, 6, 3700), // 18.4% → 越过 30 和 20，一次进 3 和 4
  ];

  const expectedTransitions = [
    { stageNo: 2, at: t(2), recordNo: 3 },
    { stageNo: 3, at: t(6), recordNo: 5 },
    { stageNo: 4, at: t(6), recordNo: 5 },
  ];

  it("顺序上报：切换时刻正确，阈值用严格小于，跨多格逐格记录", () => {
    const r = replayRun(inOrder, merged, spec, new Date(t(0)));
    expect(r.currentStage).toBe(4);
    const tail = r.transitions.slice(1);
    expect(tail.map((x) => ({ stageNo: x.stageNo, at: x.at.toISOString(), recordNo: x.recordNo })))
      .toEqual(expectedTransitions);
  });

  it("乱序上报：晚到读数时刻更早，最终时间轴与顺序上报完全相同", () => {
    // 模拟实际到达顺序：先到 4 条较晚的，再补录 #3
    const arrivalOrder: ReadingInput[] = [w(1, 0, 4900), temp(2, 1, 50, 45), w(5, 6, 3700), w(4, 4, 4062.5), w(3, 2, 4300)];
    const r = replayRun(arrivalOrder, merged, spec, new Date(t(0)));
    const tail = r.transitions.slice(1);
    expect(tail.map((x) => ({ stageNo: x.stageNo, at: x.at.toISOString(), recordNo: x.recordNo })))
      .toEqual(expectedTransitions);
    expect(r.currentStage).toBe(4);
  });

  it("逐条到达（每来一条重放一次）与一次性重放结果一致", () => {
    let acc: ReadingInput[] = [];
    const arrival = [w(1, 0, 4900), w(5, 6, 3700), temp(2, 1, 50, 45), w(3, 2, 4300), w(4, 4, 4062.5)];
    let last = replayRun([], merged, spec, new Date(t(0)));
    for (const r of arrival) {
      acc = [...acc, r];
      last = replayRun(acc, merged, spec, new Date(t(0)));
    }
    const tail = last.transitions.slice(1);
    expect(tail.map((x) => ({ stageNo: x.stageNo, at: x.at.toISOString(), recordNo: x.recordNo })))
      .toEqual(expectedTransitions);
  });

  it("重启恢复：只靠读数集合重放，结果不变", () => {
    // 模拟从数据库读回（JSON 往返后时间字符串化）再重放
    const persisted = JSON.parse(JSON.stringify(inOrder)) as ReadingInput[];
    const r = replayRun(persisted, merged, spec, new Date(t(0)));
    const tail = r.transitions.slice(1);
    expect(tail.map((x) => ({ stageNo: x.stageNo, at: x.at.toISOString() })))
      .toEqual(expectedTransitions.map(({ stageNo, at }) => ({ stageNo, at })));
  });

  it("重复记录不改变结果（去重在入库层；同一集合含相同 record_no 不会产生双切换）", () => {
    const dup = [...inOrder, { ...w(3, 2, 4300) }];
    const r = replayRun(dup, merged, spec, new Date(t(0)));
    expect(r.transitions.filter((x) => x.stageNo === 2)).toHaveLength(1);
  });

  it("阶段只进不退：后期称重回升不回退阶段", () => {
    const readings = [w(1, 0, 3700), w(2, 2, 4300)]; // 先到 18.4%，再回到 37.6%
    const r = replayRun(readings, merged, spec, new Date(t(0)));
    expect(r.currentStage).toBe(4);
  });

  it("温度读数产出 RH/EMC 曲线点，且保持的含水率沿用上一称重值", () => {
    const r = replayRun([w(1, 0, 4300), temp(2, 1, 50, 45)], merged, spec, new Date(t(0)));
    const tempRow = r.readings.find((x) => x.recordNo === 2)!;
    expect(tempRow.rh).not.toBeNull();
    expect(tempRow.emc).not.toBeNull();
    expect(tempRow.sampleMc).toBeCloseTo(37.6, 1);
  });

  it("同时刻读数按 record_no 定序，结果确定", () => {
    const same = [
      { ...w(2, 2, 3700) },
      { ...w(1, 2, 4900) },
    ];
    const r = replayRun(same, merged, spec, new Date(t(0)));
    // 4900（先处理，recordNo 1）不切换；3700 后进 4，推进只看排序，无异常
    expect(r.currentStage).toBe(4);
    expect(r.transitions.slice(1).map((x) => x.recordNo)).toEqual([2, 2, 2]);
  });
});

describe("读数校验", () => {
  it("湿球高于干球拒收并指出 wetBulb", () => {
    const errs = validateReading({ dryBulb: 60, wetBulb: 62, takenAt: t(0) });
    expect(errs.map((e) => e.field)).toContain("wetBulb");
  });

  it("温度超界拒收", () => {
    expect(validateReading({ dryBulb: 121, wetBulb: 60, takenAt: t(0) }).some((e) => e.field === "dryBulb")).toBe(true);
    expect(validateReading({ dryBulb: 60, wetBulb: -1, takenAt: t(0) }).some((e) => e.field === "wetBulb")).toBe(true);
  });

  it("称重为负/零拒收并指出 weightG", () => {
    expect(validateReading({ weightG: -5, takenAt: t(0) }).map((e) => e.field)).toContain("weightG");
    expect(validateReading({ weightG: 0, takenAt: t(0) }).map((e) => e.field)).toContain("weightG");
  });

  it("温湿度必须成对", () => {
    expect(validateReading({ dryBulb: 60, takenAt: t(0) }).some((e) => e.field.includes("wetBulb"))).toBe(true);
  });

  it("空读数、坏时刻拒收", () => {
    expect(validateReading({ takenAt: t(0) }).some((e) => e.field === "content")).toBe(true);
    expect(validateReading({ weightG: 4000, takenAt: "not-a-date" }).some((e) => e.field === "takenAt")).toBe(true);
  });
});
