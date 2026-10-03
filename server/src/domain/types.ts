/**
 * 领域层公共类型
 */

/** 阶段行（合并后的有效基准或编辑用数据） */
export interface StageRow {
  stageNo: number;
  /** 进入条件：含水率(%)降到该值以下进入本阶段；第 1 行为 null（装料即进入） */
  mcThresholdPct: number | null;
  dryBulbC: number;
  wetBulbC: number;
}

/** 带层级来源标注的单元格（用于合并预览） */
export interface SourcedCell<T> {
  value: T;
  /** base=树种基础表；override=厚度等级覆盖；第 1 阶段进入条件无值时为 null */
  source: 'base' | 'override' | null;
}

/** 合并预览中的一个有效阶段行，逐格标注来源 */
export interface EffectiveStageRow {
  stageNo: number;
  mcThresholdPct: SourcedCell<number | null>;
  dryBulbC: SourcedCell<number>;
  wetBulbC: SourcedCell<number>;
}

export type ReadingKind = 'psychro' | 'weight';

/** 一条已入库读数（引擎输入） */
export interface Reading {
  recordNo: number;
  kilnId: number;
  recordedAt: Date;
  kind: ReadingKind;
  dryBulbC: number | null;
  wetBulbC: number | null;
  weightG: number | null;
}

/** 引擎运行所需的批次信息 */
export interface BatchContext {
  kilnId: number;
  startedAt: Date;
  initialWeightG: number;
  initialMcPct: number;
  /** 干燥速率常数 k（每小时），缺省 0.05 */
  dryingKPerHour: number;
  stages: StageRow[];
}

export interface McPoint {
  recordNo: number | null;
  recordedAt: Date;
  kind: ReadingKind | 'anchor';
  mcPct: number;
  emcPct: number | null;
  rhPct: number | null;
  dryBulbC: number | null;
  wetBulbC: number | null;
  weightG: number | null;
  /** 本读数处理后所处的阶段号 */
  stageNo: number;
}

export interface StageTransition {
  stageNo: number;
  enteredAt: Date;
  /** 触发切换的读数记录编号；第 1 阶段为 null（开跑即进入） */
  triggerRecordNo: number | null;
}

export interface KilnTimeline {
  currentStageNo: number;
  currentMcPct: number;
  latestEmcPct: number | null;
  latestRhPct: number | null;
  transitions: StageTransition[];
  points: McPoint[];
}
