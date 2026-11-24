/**
 * 管内水锤波速（Korteweg 薄壁弹性管理论公式）与管材预设
 *
 *   c = sqrt( (K/ρ) / (1 + ψ·K·D / (E·e)) )
 *
 * K：水的体积模量；ρ：水的密度；E：管材弹性模量；D：管径；e：壁厚；
 * ψ：管道约束因子（与泊松比、锚固方式有关）。
 */
import type { MaterialPreset, MaterialId, RestraintType, PipeSegment } from '../types';

/** 水的体积模量 K，Pa（常温清水） */
export const WATER_BULK_MODULUS = 2.18e9;
/** 水的密度 ρ，kg/m³ */
export const WATER_DENSITY = 998;

export const MATERIAL_PRESETS: Record<MaterialId, MaterialPreset> = {
  cast_iron: {
    id: 'cast_iron',
    label: '铸铁管',
    elasticModulus: 1.1e11,
    poissonRatio: 0.27,
    pipeDensity: 7200,
    typicalSpeedRange: [1200, 1450],
    typicalLeakBand: [300, 2500],
    attenuationAlpha0: 0.0025,
    attenuationExponent: 1.0,
    note: '灰口铸铁 E≈100~130 GPa，老管网常见，接口处声衰减偏大',
  },
  steel: {
    id: 'steel',
    label: '钢管',
    elasticModulus: 2.06e11,
    poissonRatio: 0.3,
    pipeDensity: 7850,
    typicalSpeedRange: [1300, 1500],
    typicalLeakBand: [500, 3500],
    attenuationAlpha0: 0.0012,
    attenuationExponent: 1.0,
    note: '钢制管道 E≈206 GPa，声传播衰减小，相关峰最尖锐',
  },
  pe: {
    id: 'pe',
    label: 'PE 管',
    elasticModulus: 9.0e8,
    poissonRatio: 0.45,
    pipeDensity: 950,
    typicalSpeedRange: [300, 600],
    typicalLeakBand: [80, 900],
    attenuationAlpha0: 0.018,
    attenuationExponent: 1.3,
    note: 'HDPE 弹性模量低且随温度变化，声速低、高频衰减快，峰钝、可信度低',
  },
};

/**
 * 约束因子 ψ：
 * - thin_open  薄壁自由管：ψ = 1 - ν²/2
 * - one_end    一端固定：ψ = 1 - ν/2
 * - anchored   全线锚固：ψ = 1 - ν²
 */
export function restraintFactor(restraint: RestraintType, poisson: number): number {
  switch (restraint) {
    case 'thin_open':
      return 1 - (poisson * poisson) / 2;
    case 'one_end':
      return 1 - poisson / 2;
    case 'anchored':
      return 1 - poisson * poisson;
  }
}

/** 计算管段理论声速 c，m/s。D/e 均为米，同单位比值即可 */
export function theoreticalSoundSpeed(segment: PipeSegment): number {
  const mat = MATERIAL_PRESETS[segment.material];
  const psi = restraintFactor(segment.restraint, mat.poissonRatio);
  const dOverE = segment.outerDiameterMm / segment.wallThicknessMm;
  const cFree = Math.sqrt(WATER_BULK_MODULUS / WATER_DENSITY);
  const compliance = 1 + (psi * WATER_BULK_MODULUS * dOverE) / mat.elasticModulus;
  return cFree / Math.sqrt(compliance);
}

/** 理论声速与管材典型工程参考值的相对偏差（%，取与最近边界的偏差） */
export function speedVsTypicalPct(speed: number, material: MaterialId): number {
  const [lo, hi] = MATERIAL_PRESETS[material].typicalSpeedRange;
  if (speed >= lo && speed <= hi) return 0;
  const ref = speed < lo ? lo : hi;
  return Math.abs((speed - ref) / ref) * 100;
}

/**
 * 按材料的频变衰减系数：α(f) = α0 · (f / f0)^n，单位 1/m
 * PE 管 n>1，高频衰减明显加快。
 */
export function attenuationCoeff(
  material: MaterialId,
  freqHz: number,
  f0 = 1000,
): number {
  const m = MATERIAL_PRESETS[material];
  return m.attenuationAlpha0 * Math.pow(freqHz / f0, m.attenuationExponent);
}
