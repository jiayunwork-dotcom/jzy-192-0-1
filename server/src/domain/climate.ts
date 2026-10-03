/**
 * 湿空气与木材平衡含水率计算。
 *
 * RH：通风干湿球法（psychrometric equation），湿球温度下饱和水汽压
 * 采用 Alduchov–Eskridge (1996) 的 Magnus 形式。
 *
 * EMC：Hailwood–Horrobin 吸湿模型（1946），系数取自
 *   Simpson, W. T. (1973). Predicting Equilibrium Moisture Content of Wood.
 *   USDA Forest Service Research Paper FPL 190.
 *   （亦见 Wood Handbook, FPL, Ch.4, Eq. 4-6 / Table 4-2）
 * 系数中的温度 T 为华氏度。
 */

export const STANDARD_PRESSURE_KPA = 101.325;
/** 通风干湿球常数（1/°C），冰水球取值，常压下约 0.000662 */
export const PSYCHROMETER_A = 0.000662;

/** Magnus 饱和水汽压（kPa），Alduchov–Eskridge */
export function saturationVaporPressure(tempC: number): number {
  return 0.61094 * Math.exp((17.625 * tempC) / (tempC + 243.04));
}

/**
 * 由干/湿球温度（°C）推相对湿度（百分数，0..100）。
 * 调用方必须先保证 0..120 且 wet <= dry；此处不再重复业务校验。
 */
export function relativeHumidity(
  dryBulbC: number,
  wetBulbC: number,
  pressureKpa: number = STANDARD_PRESSURE_KPA,
): number {
  const ew = saturationVaporPressure(wetBulbC);
  const es = saturationVaporPressure(dryBulbC);
  const e = ew - PSYCHROMETER_A * pressureKpa * (dryBulbC - wetBulbC);
  return (e / es) * 100;
}

const cToF = (t: number): number => (t * 9) / 5 + 32;

/**
 * Hailwood–Horrobin 平衡含水率（%）。
 * @param tempC 温度 °C
 * @param rhPercent 相对湿度百分数 (0..100)
 */
export function equilibriumMoistureContent(tempC: number, rhPercent: number): number {
  const t = cToF(tempC);
  const h = rhPercent;

  const w = 330 + 0.452 * t + 0.00415 * t * t;
  const k = 0.791 + 0.000463 * t - 0.000000844 * t * t;
  const k1 = 6.34 + 0.000775 * t - 0.0000935 * t * t;
  const k2 = 1.09 + 0.0284 * t - 0.0000904 * t * t;

  const kh = (k * h) / 100;
  const hydrate = kh / (1 - kh);
  const dissolvedWater =
    (k1 * kh + 2 * k1 * k2 * kh * kh) / (1 + k1 * kh + k1 * k2 * kh * kh);

  return (1800 / w) * (hydrate + dissolvedWater);
}
