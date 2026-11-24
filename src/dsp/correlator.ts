/**
 * 加权互相关漏点定位核心
 *
 * 流程：
 *  零相位 Butterworth 带通 → Welch 分段平均互谱/自谱（Hann 窗、50% 叠加）
 *  → 三种加权（standard / PHAT / SCOT）→ IFFT 得相关曲线
 *  → 物理时延范围内寻峰 + 抛物线亚采样插值
 *  → 相干性、有效带宽、峰锐度 → 综合可信度与中文提示
 */
import { FFT } from './fft';
import { hannWindow, windowGains } from './windows';
import { butterBandpass, zeroPhaseBandpass } from './filters';
import type {
  AnalysisConfig,
  ConfidenceLevel,
  MaterialId,
  WeightingMethod,
} from '../types';

export interface CorrelatorOutput {
  correlation: Float32Array;
  lagAxisSec: Float32Array;
  delaySec: number;
  delaySamples: number;
  peakHeight: number;
  peakSharpness: number;
  coherence: number;
  effectiveBandwidthHz: number;
  /** 时延 CRB 换算的距离不确定度（米） */
  distanceUncertaintyM: number;
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel;
  advisories: string[];
  spectrumA: Float32Array;
  spectrumB: Float32Array;
  spectrumFreqAxis: Float32Array;
  filteredA: Float32Array;
  filteredB: Float32Array;
}

const EPS = 1e-12;

/** 根据管长和声速自动选择能覆盖物理时延的最小 FFT 窗长 */
export function autoFftSize(spacingM: number, soundSpeed: number, sampleRate: number): number {
  const maxLagSec = spacingM / soundSpeed;
  const maxLagSamples = maxLagSec * sampleRate;
  let n = 512;
  while (n / 2 < maxLagSamples * 1.25) n <<= 1;
  return Math.min(n, 16384);
}

function applyWeight(
  pabRe: Float32Array,
  pabIm: Float32Array,
  paa: Float32Array,
  pbb: Float32Array,
  method: WeightingMethod,
): void {
  const n = pabRe.length;
  if (method === 'standard') return;
  for (let k = 0; k < n; k++) {
    if (method === 'phat') {
      const mag = Math.hypot(pabRe[k], pabIm[k]) + EPS;
      pabRe[k] /= mag;
      pabIm[k] /= mag;
    } else {
      // SCOT：用自谱几何平均白化
      const denom = Math.sqrt(paa[k] * pbb[k]) + EPS;
      pabRe[k] /= denom;
      pabIm[k] /= denom;
    }
  }
}

export function runCorrelation(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
  config: AnalysisConfig,
  material: MaterialId,
  spacingM: number,
  soundSpeed: number,
): CorrelatorOutput {
  if (a.length !== b.length) throw new Error('两路信号长度不一致');
  const advisories: string[] = [];

  // 1. 零相位带通滤波
  const sections = butterBandpass(config.bandLowHz, config.bandHighHz, sampleRate);
  const fa = zeroPhaseBandpass(a, sections);
  const fb = zeroPhaseBandpass(b, sections);

  // 2. Welch 分段互谱
  const n = config.fftSize;
  const half = n >>> 1;
  const hop = n >>> 1;
  const fft = new FFT(n);
  const win = hannWindow(n);
  const { energy: winEnergy } = windowGains(win);
  const norm = 1 / (winEnergy * n); // 功率谱归一化

  const pabRe = new Float32Array(n);
  const pabIm = new Float32Array(n);
  const paa = new Float32Array(n);
  const pbb = new Float32Array(n);
  const reA = new Float32Array(n);
  const imA = new Float32Array(n);
  const reB = new Float32Array(n);
  const imB = new Float32Array(n);

  let segmentCount = 0;
  for (let start = 0; start + n <= fa.length; start += hop) {
    for (let i = 0; i < n; i++) {
      reA[i] = fa[start + i] * win[i];
      reB[i] = fb[start + i] * win[i];
      imA[i] = 0;
      imB[i] = 0;
    }
    fft.forward(reA, imA);
    fft.forward(reB, imB);
    for (let k = 0; k < n; k++) {
      // 互谱 P_AB = A·conj(B)：使相关峰滞后 k 对应 B 相对 A 延迟 k 点，
      // 即 τ = t_B − t_A 为正（漏点靠近 A），与距离公式 d_A=(L-cτ)/2 一致。
      pabRe[k] += reA[k] * reB[k] + imA[k] * imB[k];
      pabIm[k] += reA[k] * imB[k] - imA[k] * reB[k];
      paa[k] += reA[k] * reA[k] + imA[k] * imA[k];
      pbb[k] += reB[k] * reB[k] + imB[k] * imB[k];
    }
    segmentCount++;
  }
  if (segmentCount < 2) throw new Error('信号太短，不足以完成 Welch 分段分析');
  const invSeg = 1 / segmentCount;
  for (let k = 0; k < n; k++) {
    pabRe[k] *= invSeg * norm;
    pabIm[k] *= invSeg * norm;
    paa[k] *= invSeg * norm;
    pbb[k] *= invSeg * norm;
  }

  // 3. 相干性 γ² 与有效带宽（只统计通带内、高于本底的频点）
  const kLow = Math.max(1, Math.floor((config.bandLowHz * n) / sampleRate));
  const kHigh = Math.min(half - 1, Math.ceil((config.bandHighHz * n) / sampleRate));
  let cohSum = 0;
  let cohCount = 0;
  let effectiveBins = 0;
  const binHz = sampleRate / n;
  for (let k = kLow; k <= kHigh; k++) {
    const denom = paa[k] * pbb[k];
    if (denom < EPS * 100) continue;
    const gamma2 = (pabRe[k] ** 2 + pabIm[k] ** 2) / denom;
    cohSum += Math.min(1, gamma2);
    cohCount++;
    if (gamma2 > 0.2) effectiveBins++;
  }
  const coherence = cohCount ? cohSum / cohCount : 0;
  const effectiveBandwidthHz = effectiveBins * binHz;

  // 4. 标准归一化相关（能量归一，峰值即相关系数，用于峰高指标）
  const stdRe = pabRe.slice();
  const stdIm = pabIm.slice();
  fft.inverse(stdRe, stdIm);
  // 用通带自谱总和做能量归一
  let bandPowerA = 0;
  let bandPowerB = 0;
  for (let k = kLow; k <= kHigh; k++) {
    bandPowerA += paa[k];
    bandPowerB += pbb[k];
  }
  const energyScale = 1 / Math.sqrt(bandPowerA * bandPowerB + EPS);
  const stdCorr = new Float32Array(n);
  for (let i = 0; i < n; i++) stdCorr[i] = stdRe[i] * energyScale * n;

  // 5. 选定加权方式 → IFFT 相关曲线
  applyWeight(pabRe, pabIm, paa, pbb, config.weighting);
  fft.inverse(pabRe, pabIm);
  const weightedRaw = pabRe;

  // 重排为滞后 -N/2 .. N/2-1 的顺序
  const correlation = new Float32Array(n);
  const lagAxisSec = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const signedLag = i < half ? i : i - n;
    const idx = signedLag + half;
    correlation[idx] = weightedRaw[i];
    lagAxisSec[idx] = signedLag / sampleRate;
  }
  // 显示归一化到 ±1
  let cMax = 0;
  for (const v of correlation) cMax = Math.max(cMax, Math.abs(v));
  if (cMax > EPS) for (let i = 0; i < n; i++) correlation[i] /= cMax;

  // 6. 物理时延窗内寻峰（±L/c，留 2% 余量）
  const maxLagSec = (spacingM / soundSpeed) * 1.02;
  let searchLo = half - Math.ceil(maxLagSec * sampleRate);
  let searchHi = half + Math.ceil(maxLagSec * sampleRate);
  searchLo = Math.max(1, searchLo);
  searchHi = Math.min(n - 2, searchHi);
  let peakIdx = searchLo;
  let peakAbs = 0;
  for (let i = searchLo; i <= searchHi; i++) {
    const v = Math.abs(correlation[i]);
    if (v > peakAbs) {
      peakAbs = v;
      peakIdx = i;
    }
  }
  const sign = correlation[peakIdx] >= 0 ? 1 : -1;
  // 抛物线亚采样插值（对带符号幅值）
  const y0 = correlation[peakIdx - 1] * sign;
  const y1 = correlation[peakIdx] * sign;
  const y2 = correlation[peakIdx + 1] * sign;
  const denom2 = y0 - 2 * y1 + y2;
  const delta = Math.abs(denom2) > EPS ? (0.5 * (y0 - y2)) / denom2 : 0;
  const refinedLagSamples = peakIdx - half + delta;
  const delaySamples = refinedLagSamples;
  const delaySec = refinedLagSamples / sampleRate;

  // 7. 峰高（标准相关系数）与峰锐度（主峰/次峰比）
  const stdPeakHeight = Math.abs(stdCorr[((peakIdx - half + n) % n + n) % n]);
  const peakHeight = Math.min(1, stdPeakHeight);
  let secondPeak = EPS;
  for (let i = searchLo + 1; i < searchHi; i++) {
    if (Math.abs(i - peakIdx) <= 3) continue;
    const v = Math.abs(correlation[i]);
    if (v > Math.abs(correlation[i - 1]) && v >= Math.abs(correlation[i + 1])) {
      secondPeak = Math.max(secondPeak, v);
    }
  }
  const peakSharpness = peakAbs / (secondPeak + EPS);

  // 8. 频谱（dB，供绘图）
  const spectrumA = new Float32Array(half + 1);
  const spectrumB = new Float32Array(half + 1);
  const spectrumFreqAxis = new Float32Array(half + 1);
  for (let k = 0; k <= half; k++) {
    spectrumFreqAxis[k] = (k * sampleRate) / n;
    spectrumA[k] = 10 * Math.log10(paa[k] + EPS);
    spectrumB[k] = 10 * Math.log10(pbb[k] + EPS);
  }

  // 9. 综合可信度
  // 时延标准差（Cramér–Rao 下界，GCC 时延估计的经典精度公式）：
  //   σ_τ ≈ 1 / (2π·√(2·T_eff·B)·f_rms·γ_mean)
  // 其中 T_eff 为有效观测时长、B 有效带宽、f_rms 有效频带均方根频率、
  // γ_mean 为有效频带平均相干性。σ_τ 经声速换算成距离不确定度 σ_d。
  let frmsNum = 0;
  let frmsDen = 0;
  let gammaEffSum = 0;
  let gammaEffCount = 0;
  for (let k = kLow; k <= kHigh; k++) {
    const denom = paa[k] * pbb[k];
    if (denom < EPS * 100) continue;
    const gamma2 = Math.min(1, (pabRe[k] ** 2 + pabIm[k] ** 2) / denom);
    const f = (k * sampleRate) / n;
    frmsNum += f * f * gamma2;
    frmsDen += gamma2;
    if (gamma2 > 0.2) {
      gammaEffSum += gamma2;
      gammaEffCount++;
    }
  }
  const fRms = frmsDen > 0 ? Math.sqrt(frmsNum / frmsDen) : 0;
  const gammaMean = gammaEffCount ? gammaEffSum / gammaEffCount : 0;
  const tEff = (segmentCount * n) / sampleRate;
  const crbTau =
    fRms > 0 && gammaMean > 0
      ? 1 / (2 * Math.PI * Math.sqrt(2 * tEff * effectiveBandwidthHz) * fRms * gammaMean)
      : Infinity;
  const crbDistanceM = Number.isFinite(crbTau) ? (crbTau * soundSpeed) / 2 : spacingM;

  const { confidenceScore, confidenceLevel } = scoreConfidence({
    peakHeight,
    peakSharpness,
    coherence,
    effectiveBandwidthHz,
    analysisBandwidthHz: (kHigh - kLow) * binHz,
    material,
    crbDistanceM,
    spacingM,
  });

  // 10. 中文诊断提示
  if (material === 'pe') {
    advisories.push('PE 管高频衰减快、相关峰偏钝，建议结合听音棒人工复核并缩短传感器间距复测。');
  }
  const relUnc = crbDistanceM / spacingM;
  if (relUnc > 0.015) {
    advisories.push(`距离不确定度约 ±${crbDistanceM.toFixed(1)}m（管长的 ${(relUnc * 100).toFixed(1)}%），已超出精确定位范围，开挖前必须复测。`);
  } else if (relUnc > 0.005) {
    advisories.push(`距离不确定度约 ±${crbDistanceM.toFixed(2)}m，建议在该范围内配合地面听音确认。`);
  }
  if (coherence < 0.25) {
    advisories.push('双通道相干性偏低，漏水信号可能被交通/水泵噪声淹没，建议更换低峰时段复测。');
  } else if (coherence < 0.45) {
    advisories.push('相干性一般，定位结果受现场干扰影响，可信度下调。');
  }
  if (peakSharpness < 2) {
    advisories.push('相关峰不尖锐（主峰/次峰比偏低），存在伪峰风险，可尝试调整滤波频带或改用 PHAT 加权。');
  }
  if (effectiveBandwidthHz < 120) {
    advisories.push('有效相干带宽过窄，时延分辨力不足，亚采样插值误差增大。');
  }
  if (peakIdx <= searchLo + 2 || peakIdx >= searchHi - 2) {
    advisories.push('相关峰贴近物理时延窗边界，漏点可能位于传感器外侧，请核对管长与传感器位置。');
  }
  if (peakHeight < 0.08) {
    advisories.push('相关系数过低，两通道同源信号弱，本次定位仅供参考。');
  }
  if (advisories.length === 0) {
    advisories.push('相关峰形态良好，各项指标正常，可按计算距离安排探挖。');
  }

  return {
    correlation,
    lagAxisSec,
    delaySec,
    delaySamples,
    peakHeight,
    peakSharpness,
    coherence,
    effectiveBandwidthHz,
    distanceUncertaintyM: crbDistanceM,
    confidenceScore,
    confidenceLevel,
    advisories,
    spectrumA,
    spectrumB,
    spectrumFreqAxis,
    filteredA: fa,
    filteredB: fb,
  };
}

interface ConfidenceInputs {
  peakHeight: number;
  peakSharpness: number;
  coherence: number;
  effectiveBandwidthHz: number;
  analysisBandwidthHz: number;
  material: MaterialId;
  /** 时延 CRB 换算的距离不确定度（米，越小越可信） */
  crbDistanceM: number;
  spacingM: number;
}

function scoreConfidence(x: ConfidenceInputs): {
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel;
} {
  // 现场经验标定（基于多工况仿真数据回归）：
  //  - 峰高（标准相关系数）是同源信号强弱的最直接指标，权重最高；
  //  - 相干性反映两路一致性，强干扰/耦合失配时明显下降；
  //  - 峰锐度区分 PHAT 白化后的伪峰；
  //  - 带宽与 CRB 精度作为辅助（长观测下 CRB 趋于乐观，仅小幅参与）。
  const sHeight = Math.max(0, Math.min(1, (x.peakHeight - 0.05) / 0.4));   // 0.05→0，0.45→1
  const sCoh = Math.max(0, Math.min(1, (x.coherence - 0.15) / 0.55));      // 0.15→0，0.70→1
  const sSharp = Math.max(0, Math.min(1, (x.peakSharpness - 1) / 4));      // 1→0，5→1
  const sBw = Math.min(1, x.effectiveBandwidthHz / Math.max(1, x.analysisBandwidthHz * 0.5));
  const relUnc = x.crbDistanceM / x.spacingM;
  const sPrec = Math.max(0, Math.min(1, 1 - (relUnc - 0.003) / 0.027));
  // PE 管高频衰减、天然钝峰：弱化峰锐度/带宽，强化峰高与相干性
  const w =
    x.material === 'pe'
      ? { h: 0.4, s: 0.1, c: 0.35, b: 0.05, p: 0.1 }
      : { h: 0.35, s: 0.2, c: 0.3, b: 0.1, p: 0.05 };
  let score =
    w.h * sHeight +
    w.s * sSharp +
    w.c * sCoh +
    w.b * sBw +
    w.p * sPrec;
  // 硬性降级闸门：任一关键指标越线即限制最高等级，防止单一指标虚高
  if (x.peakHeight < 0.2 || x.coherence < 0.3) score = Math.min(score, 0.38);
  else if (x.peakHeight < 0.35 || x.coherence < 0.5 || x.peakSharpness < 1.8) {
    score = Math.min(score, 0.65);
  }
  score = Math.max(0, Math.min(1, score));
  const level: ConfidenceLevel = score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low';
  return { confidenceScore: score, confidenceLevel: level };
}
