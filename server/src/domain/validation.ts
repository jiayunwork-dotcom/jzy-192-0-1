/**
 * 业务校验。所有“拒收并指出字段”的规则集中在这里，供 API 与发布流程复用。
 * 错误结构：{ field: 字段路径, message: 中文说明 }
 */

export interface FieldError {
  field: string;
  message: string;
}

const TEMP_MIN = 0;
const TEMP_MAX = 120;

export function checkTemp(field: string, value: unknown): FieldError | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { field, message: '温度必须是数字' };
  }
  if (value < TEMP_MIN || value > TEMP_MAX) {
    return { field, message: `温度超出 ${TEMP_MIN}~${TEMP_MAX}°C 范围` };
  }
  return null;
}

/** 阶段行原始输入（基础表/覆盖编辑共用） */
export interface StageInput {
  stageNo: number;
  mcThresholdPct: number | null;
  dryBulbC: number;
  wetBulbC: number;
}

/** 校验一张完整阶段表（合并后的有效基准或基础表编辑稿） */
export function validateStages(
  stages: StageInput[],
  prefix = '',
): FieldError[] {
  const errors: FieldError[] = [];
  const f = (s: string) => (prefix ? `${prefix}.${s}` : s);

  if (stages.length === 0) {
    errors.push({ field: f('stages'), message: '阶段表不能为空' });
    return errors;
  }

  const sorted = stages.slice().sort((a, b) => a.stageNo - b.stageNo);
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]!;
    const p = `阶段${row.stageNo}`;
    const e1 = checkTemp(f(`${p}.干球温度`), row.dryBulbC);
    if (e1) errors.push(e1);
    const e2 = checkTemp(f(`${p}.湿球温度`), row.wetBulbC);
    if (e2) errors.push(e2);
    if (
      typeof row.wetBulbC === 'number' &&
      typeof row.dryBulbC === 'number' &&
      Number.isFinite(row.wetBulbC) &&
      Number.isFinite(row.dryBulbC) &&
      row.wetBulbC > row.dryBulbC
    ) {
      errors.push({
        field: f(`${p}.湿球温度`),
        message: '湿球温度不能高于干球温度',
      });
    }
    if (i === 0) {
      if (row.mcThresholdPct !== null) {
        errors.push({
          field: f(`${p}.进入条件`),
          message: '第 1 阶段为起始阶段，进入条件必须留空',
        });
      }
    } else if (
      typeof row.mcThresholdPct !== 'number' ||
      !Number.isFinite(row.mcThresholdPct) ||
      row.mcThresholdPct <= 0
    ) {
      errors.push({
        field: f(`${p}.进入条件`),
        message: '进入条件含水率必须为正数（%）',
      });
    }
  }

  // 进入条件必须逐行严格递减（按阶段顺序）
  let prev: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const thr = sorted[i]!.mcThresholdPct;
    if (typeof thr === 'number' && prev !== null && thr >= prev) {
      errors.push({
        field: f(`阶段${sorted[i]!.stageNo}.进入条件`),
        message: `进入条件含水率必须逐行递减（上一行为 ${prev}%）`,
      });
    }
    if (typeof thr === 'number') prev = thr;
  }
  return errors;
}

/** 读数提交入参 */
export interface ReadingInput {
  recordNo: unknown;
  kilnId: unknown;
  recordedAt: unknown;
  dryBulbC?: unknown;
  wetBulbC?: unknown;
  weightG?: unknown;
}

/**
 * 校验读数的“形状”。引用完整性（窑号是否存在、批次是否在跑）由路由层
 * 结合数据库再查，这里只校验字段本身。
 */
export function validateReading(input: ReadingInput): FieldError[] {
  const errors: FieldError[] = [];
  if (
    typeof input.recordNo !== 'number' ||
    !Number.isInteger(input.recordNo) ||
    input.recordNo <= 0
  ) {
    errors.push({ field: 'recordNo', message: '记录编号必须是正整数' });
  }
  if (
    typeof input.kilnId !== 'number' ||
    !Number.isInteger(input.kilnId) ||
    input.kilnId <= 0
  ) {
    errors.push({ field: 'kilnId', message: '窑号必须是正整数' });
  }
  const ts = input.recordedAt;
  if (
    (typeof ts !== 'string' && typeof ts !== 'number') ||
    !Number.isFinite(new Date(ts as string | number).getTime())
  ) {
    errors.push({ field: 'recordedAt', message: '时刻必须是合法的 ISO 时间' });
  }

  const hasT = input.dryBulbC !== undefined || input.wetBulbC !== undefined;
  const hasW = input.weightG !== undefined;
  if (!hasT && !hasW) {
    errors.push({
      field: 'readings',
      message: '读数必须含干湿球温度或样板称重之一',
    });
    return errors;
  }
  if (hasT && hasW) {
    errors.push({
      field: 'readings',
      message: '一条记录只能是温湿度读数或称重读数之一',
    });
  }
  if (hasT) {
    const d = checkTemp('dryBulbC', input.dryBulbC);
    if (d) errors.push(d);
    const w = checkTemp('wetBulbC', input.wetBulbC);
    if (w) errors.push(w);
    if (
      typeof input.dryBulbC === 'number' &&
      typeof input.wetBulbC === 'number' &&
      Number.isFinite(input.dryBulbC) &&
      Number.isFinite(input.wetBulbC) &&
      (input.wetBulbC as number) > (input.dryBulbC as number)
    ) {
      errors.push({
        field: 'wetBulbC',
        message: '湿球温度不能高于干球温度',
      });
    }
  }
  if (hasW) {
    const wgt = input.weightG;
    if (typeof wgt !== 'number' || !Number.isFinite(wgt)) {
      errors.push({ field: 'weightG', message: '称重必须是数字' });
    } else if (wgt < 0) {
      errors.push({ field: 'weightG', message: '称重不能为负' });
    }
  }
  return errors;
}

/** 开跑入参的样板参数校验 */
export function validateBatchStart(input: {
  initialWeightG: unknown;
  initialMcPct: unknown;
  thicknessGrade?: unknown;
}): FieldError[] {
  const errors: FieldError[] = [];
  if (
    typeof input.initialWeightG !== 'number' ||
    !Number.isFinite(input.initialWeightG) ||
    input.initialWeightG <= 0
  ) {
    errors.push({ field: 'initialWeightG', message: '样板初始称重必须为正数（克）' });
  }
  if (
    typeof input.initialMcPct !== 'number' ||
    !Number.isFinite(input.initialMcPct) ||
    input.initialMcPct <= 0
  ) {
    errors.push({ field: 'initialMcPct', message: '初始含水率必须为正数（%）' });
  }
  if (
    input.thicknessGrade !== undefined &&
    input.thicknessGrade !== null &&
    (typeof input.thicknessGrade !== 'string' ||
      input.thicknessGrade.trim() === '')
  ) {
    errors.push({ field: 'thicknessGrade', message: '厚度等级必须为非空字符串' });
  }
  return errors;
}
