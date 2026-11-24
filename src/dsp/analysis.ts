/**
 * 相关分析编排：调用相关器 → 距离解算 → 组装结果
 * 该模块同时被 Web Worker 与 Node 校验脚本复用，不依赖 DOM。
 */
import { runCorrelation, type CorrelatorOutput } from './correlator';
import { theoreticalSoundSpeed, speedVsTypicalPct } from './materials';
import { uid } from '../lib/id';
import type {
  AnalysisConfig,
  AnalysisResult,
  Capture,
  PipeSegment,
} from '../types';

export function buildAnalysisResult(
  capture: Capture,
  segment: PipeSegment,
  config: AnalysisConfig,
  elapsedMs: number,
): AnalysisResult {
  const sampleRate = capture.channels[0].sampleRate;
  if (capture.channels[1].sampleRate !== sampleRate) {
    throw new Error('两路采样率不一致，无法做同步相关');
  }
  const soundSpeed = theoreticalSoundSpeed(segment);
  const out: CorrelatorOutput = runCorrelation(
    capture.channels[0].samples,
    capture.channels[1].samples,
    sampleRate,
    config,
    segment.material,
    segment.sensorSpacingM,
    soundSpeed,
  );

  const L = segment.sensorSpacingM;
  const c = soundSpeed;
  // τ = t_B - t_A；d_A = (L - c·τ)/2
  let dA = (L - c * out.delaySec) / 2;
  let dB = L - dA;
  if (dA < 0 || dA > L) {
    out.advisories.unshift(
      '计算距离超出传感器间距范围，结果可能无效，请检查声速、管长参数与滤波设置。',
    );
    dA = Math.max(0, Math.min(L, dA));
    dB = L - dA;
  }

  return {
    id: uid('res'),
    captureId: capture.id,
    segmentId: segment.id,
    config,
    elapsedMs,
    soundSpeed: c,
    speedVsTypicalPct: speedVsTypicalPct(c, segment.material),
    delaySec: out.delaySec,
    delaySamples: out.delaySamples,
    correlation: out.correlation,
    lagAxisSec: out.lagAxisSec,
    distanceFromA: dA,
    distanceFromB: dB,
    spacing: L,
    peakHeight: out.peakHeight,
    peakSharpness: out.peakSharpness,
    coherence: out.coherence,
    effectiveBandwidthHz: out.effectiveBandwidthHz,
    distanceUncertaintyM: out.distanceUncertaintyM,
    confidenceScore: out.confidenceScore,
    confidenceLevel: out.confidenceLevel,
    advisories: out.advisories,
    spectrumA: out.spectrumA,
    spectrumB: out.spectrumB,
    spectrumFreqAxis: out.spectrumFreqAxis,
  };
}
