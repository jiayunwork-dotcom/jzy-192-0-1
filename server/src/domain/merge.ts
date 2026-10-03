import type { MergedRow, OverrideRow, StageRow } from "./types.js";

/**
 * 两层基准合并：基础表 + 某厚度等级覆盖。
 * 覆盖行只写与基础表不同的格；未写的继承基础表。
 * 同一份算法同时用于页面“合并预览”与发布后跑批，保证两者一致。
 */
export function mergeSchedule(base: StageRow[], overrides: OverrideRow[] = []): MergedRow[] {
  const byStage = new Map<number, OverrideRow>();
  for (const o of overrides) byStage.set(o.stageNo, o);

  return base
    .map((row) => {
      const ov = byStage.get(row.stageNo);
      if (!ov) {
        return {
          stageNo: row.stageNo,
          enterBelow: row.enterBelow,
          dryBulb: row.dryBulb,
          wetBulb: row.wetBulb,
          sources: { enterBelow: "base", dryBulb: "base", wetBulb: "base" },
        } satisfies MergedRow;
      }
      const enterBelow =
        ov.enterBelow !== undefined ? ov.enterBelow : row.enterBelow;
      const dryBulb = ov.dryBulb ?? row.dryBulb;
      const wetBulb = ov.wetBulb ?? row.wetBulb;
      return {
        stageNo: row.stageNo,
        enterBelow,
        dryBulb,
        wetBulb,
        sources: {
          enterBelow: ov.enterBelow !== undefined ? "override" : "base",
          dryBulb: ov.dryBulb !== undefined ? "override" : "base",
          wetBulb: ov.wetBulb !== undefined ? "override" : "base",
        },
      } satisfies MergedRow;
    })
    .sort((a, b) => a.stageNo - b.stageNo);
}

/**
 * 校验一份基准内容（基础表 + 覆盖），返回字段级错误。
 * 温度范围 0..120；除第一行外进入条件必须逐行严格递减；
 * 覆盖行只能引用存在的阶段号；覆盖后的合并表同样必须递减。
 */
export function validateSchedule(base: StageRow[], overridesByGrade: Record<string, OverrideRow[]>):
  { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];

  if (!Array.isArray(base) || base.length === 0) {
    errors.push({ field: "base", message: "基础阶段表至少需要一行" });
    return errors;
  }

  const sorted = [...base].sort((a, b) => a.stageNo - b.stageNo);
  const stageNos = new Set<number>();

  sorted.forEach((row, i) => {
    const p = `base[${i}]`;
    stageNos.add(row.stageNo);

    if (!Number.isFinite(row.dryBulb) || row.dryBulb < 0 || row.dryBulb > 120) {
      errors.push({ field: `${p}.dryBulb`, message: "干球温度必须在 0 到 120°C 之间" });
    }
    if (!Number.isFinite(row.wetBulb) || row.wetBulb < 0 || row.wetBulb > 120) {
      errors.push({ field: `${p}.wetBulb`, message: "湿球温度必须在 0 到 120°C 之间" });
    }
    if (Number.isFinite(row.dryBulb) && Number.isFinite(row.wetBulb) && row.wetBulb > row.dryBulb) {
      errors.push({ field: `${p}.wetBulb`, message: "湿球温度不能高于干球温度" });
    }
    if (i === 0) {
      if (row.enterBelow !== null) {
        errors.push({ field: `${p}.enterBelow`, message: "第一阶段为起始阶段，进入条件必须留空" });
      }
    } else {
      if (row.enterBelow === null || !Number.isFinite(row.enterBelow)) {
        errors.push({ field: `${p}.enterBelow`, message: "进入条件不能为空" });
      } else {
        const prev = sorted[i - 1]!.enterBelow;
        // 第一行为 null（+∞），其后各行必须严格递减
        if (prev !== null && row.enterBelow >= prev) {
          errors.push({
            field: `${p}.enterBelow`,
            message: `进入条件必须逐行递减（第 ${i} 行之后应小于 ${prev}%）`,
          });
        }
      }
    }
  });

  for (const [grade, list] of Object.entries(overridesByGrade)) {
    list.forEach((ov, i) => {
      const p = `overridesByGrade.${grade}[${i}]`;
      if (!stageNos.has(ov.stageNo)) {
        errors.push({ field: `${p}.stageNo`, message: "覆盖了不存在的阶段号" });
      }
      if (ov.dryBulb !== undefined) {
        if (!Number.isFinite(ov.dryBulb) || ov.dryBulb < 0 || ov.dryBulb > 120) {
          errors.push({ field: `${p}.dryBulb`, message: "干球温度必须在 0 到 120°C 之间" });
        }
      }
      if (ov.wetBulb !== undefined) {
        if (!Number.isFinite(ov.wetBulb) || ov.wetBulb < 0 || ov.wetBulb > 120) {
          errors.push({ field: `${p}.wetBulb`, message: "湿球温度必须在 0 到 120°C 之间" });
        }
      }
    });

    // 合并后每个厚度等级的有效表也要逐行递减且湿球不高于干球
    const merged = mergeSchedule(sorted, list);
    for (let i = 1; i < merged.length; i++) {
      const cur = merged[i]!.enterBelow;
      const prev = merged[i - 1]!.enterBelow;
      if (cur !== null && prev !== null && cur >= prev) {
        errors.push({
          field: `overridesByGrade.${grade}`,
          message: `厚度等级「${grade}」覆盖后的进入条件不再逐行递减`,
        });
        break;
      }
      if (merged[i]!.wetBulb > merged[i]!.dryBulb) {
        errors.push({
          field: `overridesByGrade.${grade}`,
          message: `厚度等级「${grade}」覆盖后出现湿球高于干球`,
        });
        break;
      }
    }
  }

  return errors;
}
