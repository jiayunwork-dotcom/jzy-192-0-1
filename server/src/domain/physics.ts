/**
 * 湿空气与木材吸湿模型（纯函数，不做任何 I/O）
 *
 * 1) 干湿球 → 相对湿度
 *    采用世界气象组织地面气象观测手册（WMO, Guide to Instruments and Methods
 *    of Observation, CIMO Guide, WMO-No. 8）通风干湿表（阿斯曼）公式：
 *      e = e_s(Tw) − A·p·(T − Tw)
 *      RH = e / e_s(T)
 *    A = 6.62e-4 /°C（通风、液面，T ≥ 0°C），p 取标准大气压 1013.25 hPa。
 *    e_s 用 WMO 推荐的 Magnus 式（Buck, 1981, 水面）：
 *      e_s(T) = 6.112 · exp(17.62 T / (243.12 + T))   [hPa, °C]
 *
 * 2) 相对湿度 → 木材平衡含水率（EMC）
 *    采用 Simpson (1973) 的 Hailwood–Horrobin 吸湿方程，出处：
 *      Simpson, W.T. (1973). "Predicting Equilibrium Moisture Content of Wood".
 *      Wood and Fiber, 5(2): 148–163.
 *      并见 USDA Forest Service, Wood Handbook: Wood as an Engineering Material,
 *      第 13 章 Table 13-4（该书列华氏温度的吸附 sorption 系数）。
 *    下面使用的是该方程的“摄氏温度变换系数集”（K、K1 含温度二次项），
 *    也是国内木材干燥教材中通行的写法。
 *
 *    令 W, K, K1, K2 为温度 T(°C) 的函数，h = RH/100：
 *      W  = 349 + 1.29T + 0.0135T²
 *      K  = 0.805 + 7.36e-4·T − 2.73e-7·T²
 *      K1 = 6.27 − 0.00938T − 3.03e-4·T²
 *      K2 = 1.91 + 0.0407T − 2.93e-4·T²
 *      M  = (1800/W)·[ Kh/(1−Kh) + (K1·Kh + 2·K1·K2·K²h²)/
 *                      (1 + K1·Kh + K1·K2·K²h²) ]   [%]
 *
 * 参考值校验：20°C/65% → 12.00%；60°C/80% → 13.56%（即 13.6±0.3）。
 * 本方程给出的是吸附平衡含水率；干燥（解吸）状态实际平衡含水率略高，
 * 这一偏差在 docs 中讨论。
 */

/** 标准海平面大气压 hPa（车间常压，不做海拔修正） */
export const STANDARD_PRESSURE_HPA = 1013.25;
/** WMO CIMO 通风干湿表系数（液面、0°C 以上） */
export const PSYCHROMETER_A = 0.000662;

/** Magnus 饱和水汽压，单位 hPa，T 为摄氏度（Buck 1981，水面） */
export function saturationVaporPressureHpa(tempC: number): number {
  return 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
}

/**
 * 由干球、湿球温度推算相对湿度(%)。
 * 调用方须先保证 0 <= wet <= dry <= 120；此处仅做数值兜底，不做业务校验。
 */
export function relativeHumidityPct(
  dryBulbC: number,
  wetBulbC: number,
  pressureHpa: number = STANDARD_PRESSURE_HPA,
): number {
  const esDry = saturationVaporPressureHpa(dryBulbC);
  const esWet = saturationVaporPressureHpa(wetBulbC);
  const e = esWet - PSYCHROMETER_A * pressureHpa * (dryBulbC - wetBulbC);
  const rh = (e / esDry) * 100;
  // 物理上 RH 落在 [0,100]；极端输入下数值可能越界，夹紧后返回。
  return Math.min(100, Math.max(0, rh));
}

/**
 * Simpson (1973) Hailwood–Horrobin 吸附方程，温度 °C、相对湿度 %，返回 EMC %。
 */
export function equilibriumMoistureContentPct(tempC: number, rhPct: number): number {
  const T = tempC;
  const h = rhPct / 100;
  const W = 349 + 1.29 * T + 0.0135 * T * T;
  const K = 0.805 + 736e-6 * T - 273e-8 * T * T;
  const K1 = 6.27 - 0.00938 * T - 303e-6 * T * T;
  const K2 = 1.91 + 0.0407 * T - 293e-6 * T * T;
  const Kh = K * h;
  const term1 = Kh / (1 - Kh);
  const term2 =
    (K1 * Kh + 2 * K1 * K2 * Kh * Kh) /
    (1 + K1 * Kh + K1 * K2 * Kh * Kh);
  return (1800 / W) * (term1 + term2);
}

/**
 * 样板含水率（绝干基）。
 * @param dryMassG 绝干质量，或首次称重按初始含水率折算：m0/(1+MC0)
 * @param currentWeightG 当前称重（克）
 * @returns 含水率 %
 *
 * 例：初称 5000g、初始 MC 60%，绝干质量 = 5000/1.6 = 3125g；
 * 称得 4062.5g 时 MC = 4062.5/3125 − 1 = 30%。
 */
export function sampleMoistureContentPct(dryMassG: number, currentWeightG: number): number {
  return (currentWeightG / dryMassG - 1) * 100;
}

/** 由“初始称重 + 初始含水率”求绝干质量 */
export function ovenDryMassG(initialWeightG: number, initialMcPct: number): number {
  return initialWeightG / (1 + initialMcPct / 100);
}
