/**
 * 样板含水率（绝干质量基准）。
 * MC = (m - m_dry) / m_dry * 100%
 * m_dry = m0 / (1 + MC0/100)
 */

export interface SampleSpec {
  initialWeightG: number;
  initialMcPercent: number;
}

/** 绝干质量（克） */
export function dryMass(spec: SampleSpec): number {
  return spec.initialWeightG / (1 + spec.initialMcPercent / 100);
}

/** 某次称重时的样板含水率（%） */
export function sampleMoistureContent(spec: SampleSpec, weightG: number): number {
  const md = dryMass(spec);
  return ((weightG - md) / md) * 100;
}
