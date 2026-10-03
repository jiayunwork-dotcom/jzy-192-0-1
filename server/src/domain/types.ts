/** 领域层公共类型 —— 纯数据，不依赖任何运行时库。 */

/** 基础表/合并后的阶段行 */
export interface StageRow {
  stageNo: number;
  /** 进入条件：含水率降到该值以下（%）。第一阶段可为 null 表示开跑即进入。 */
  enterBelow: number | null;
  dryBulb: number;
  wetBulb: number;
}

/** 厚度覆盖行：只写与基础表不同的格，未写即继承 */
export interface OverrideRow {
  stageNo: number;
  enterBelow?: number | null;
  dryBulb?: number;
  wetBulb?: number;
}

export type CellSource = "base" | "override";

export interface MergedRow {
  stageNo: number;
  enterBelow: number | null;
  dryBulb: number;
  wetBulb: number;
  /** 每格来自哪一层 */
  sources: {
    enterBelow: CellSource;
    dryBulb: CellSource;
    wetBulb: CellSource;
  };
}

export interface ThicknessGrade {
  code: string;
  label: string;
  sortOrder: number;
}

export type VersionStatus = "draft" | "published";

/** 版本完整内容（草稿编辑对象） */
export interface ScheduleContent {
  base: StageRow[];
  overridesByGrade: Record<string, OverrideRow[]>;
}

/** 读数（输入温度组或称重组） */
export interface ReadingInput {
  recordNo: number;
  kilnNo: number;
  takenAt: string | Date;
  dryBulb?: number | null;
  wetBulb?: number | null;
  weightG?: number | null;
}

/** 持久化后的读数，带派生量 */
export interface ReadingRow {
  recordNo: number;
  kilnNo: number;
  takenAt: Date;
  dryBulb: number | null;
  wetBulb: number | null;
  weightG: number | null;
  /** 温度读数推出 */
  rh: number | null;
  emc: number | null;
  /** 称重读数推出（绝干折算）；温度读数沿用上一称重值 */
  sampleMc: number | null;
}

export interface StageTransition {
  stageNo: number;
  /** 首个观测到越过该阶段进入条件的称重读数时刻 */
  at: Date;
  recordNo: number;
}
