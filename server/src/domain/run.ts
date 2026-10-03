import { equilibriumMoistureContent, relativeHumidity } from "./climate.js";
import { sampleMoistureContent, type SampleSpec } from "./sample.js";
import type {
  MergedRow,
  ReadingInput,
  ReadingRow,
  StageTransition,
} from "./types.js";

export interface ReadingValidationError {
  field: string;
  message: string;
}

/** 校验单条读数内容（不含引用存在性，那是路由层/数据库的事） */
export function validateReading(r: {
  dryBulb?: number | null;
  wetBulb?: number | null;
  weightG?: number | null;
  takenAt?: string | Date;
}): ReadingValidationError[] {
  const errors: ReadingValidationError[] = [];
  const hasTemp = r.dryBulb !== null && r.dryBulb !== undefined;
  const hasWet = r.wetBulb !== null && r.wetBulb !== undefined;
  const hasWeight = r.weightG !== null && r.weightG !== undefined;

  if (!hasTemp && !hasWet && !hasWeight) {
    errors.push({ field: "content", message: "读数必须包含干湿球温度或样板称重中的至少一项" });
  }
  if (hasTemp !== hasWet) {
    errors.push({ field: "dryBulb/wetBulb", message: "干球和湿球温度必须成对出现" });
  }
  if (hasTemp && hasWet) {
    const db = r.dryBulb as number;
    const wb = r.wetBulb as number;
    if (!Number.isFinite(db) || db < 0 || db > 120) {
      errors.push({ field: "dryBulb", message: "干球温度必须在 0 到 120°C 之间" });
    }
    if (!Number.isFinite(wb) || wb < 0 || wb > 120) {
      errors.push({ field: "wetBulb", message: "湿球温度必须在 0 到 120°C 之间" });
    }
    if (
      Number.isFinite(db) && Number.isFinite(wb) && wb > db
    ) {
      errors.push({ field: "wetBulb", message: "湿球温度不能高于干球温度" });
    }
  }
  if (hasWeight) {
    const w = r.weightG as number;
    if (!Number.isFinite(w) || w <= 0) {
      errors.push({ field: "weightG", message: "称重必须为正数（克）" });
    }
  }
  const ts = r.takenAt === undefined ? null : new Date(r.takenAt as string);
  if (ts === null || Number.isNaN(ts.getTime())) {
    errors.push({ field: "takenAt", message: "读数时刻格式无效" });
  }
  return errors;
}

export interface ReplayResult {
  readings: ReadingRow[];
  transitions: StageTransition[];
  currentStage: number;
}

/**
 * 按时刻顺序重放一条批次的全部读数，重建含水率序列与阶段时间轴。
 *
 * 纯函数：结果只取决于读数集合，与插入先后无关 —— 这是“乱序上报与顺序上报
 * 切换时刻相同 / 重启恢复”的保证。
 *
 * 含水率在两次称重之间保持上次称重折算值（zero-order hold，见 docs/DESIGN.md 2.4），
 * 因此只有称重读数能触发阶段切换；温度读数只贡献 RH/EMC 曲线。
 */
export function replayRun(
  rawReadings: ReadingInput[],
  merged: MergedRow[],
  spec: SampleSpec,
  startedAt: Date,
): ReplayResult {
  const rows = [...rawReadings]
    .map((r) => ({ ...r, at: new Date(r.takenAt) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.recordNo - b.recordNo);

  const transitions: StageTransition[] = [
    { stageNo: 1, at: new Date(startedAt), recordNo: -1 },
  ];
  let currentStage = 1;
  let heldMc: number | null = null;

  const out: ReadingRow[] = rows.map((r) => {
    let rh: number | null = null;
    let emc: number | null = null;
    if (
      r.dryBulb !== null && r.dryBulb !== undefined &&
      r.wetBulb !== null && r.wetBulb !== undefined
    ) {
      rh = relativeHumidity(r.dryBulb, r.wetBulb);
      emc = equilibriumMoistureContent(r.dryBulb, rh);
    }
    if (r.weightG !== null && r.weightG !== undefined) {
      heldMc = sampleMoistureContent(spec, r.weightG);
      // 越过当前阶段进入条件即推进；一条读数跨越多格时逐格记录，
      // 各格切换时刻统一为该读数时刻（首个观测时刻）。
      while (currentStage < merged.length) {
        const next = merged[currentStage]!;
        if (next.enterBelow === null || heldMc < next.enterBelow) {
          currentStage += 1;
          transitions.push({ stageNo: currentStage, at: r.at, recordNo: r.recordNo });
        } else {
          break;
        }
      }
    }
    return {
      recordNo: r.recordNo,
      kilnNo: r.kilnNo,
      takenAt: r.at,
      dryBulb: r.dryBulb ?? null,
      wetBulb: r.wetBulb ?? null,
      weightG: r.weightG ?? null,
      rh,
      emc,
      sampleMc: heldMc,
    };
  });

  return { readings: out, transitions, currentStage };
}
