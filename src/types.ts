/**
 * 全局类型定义：管材、管段、采集、分析、记录
 */

/** 管材种类 */
export type MaterialId = 'cast_iron' | 'steel' | 'pe';

/** 管道约束方式（影响波速公式中的约束因子 ψ） */
export type RestraintType = 'thin_open' | 'anchored' | 'one_end';

/** 管材声学/力学参数预设 */
export interface MaterialPreset {
  id: MaterialId;
  /** 中文名 */
  label: string;
  /** 管材弹性模量 E，单位 Pa */
  elasticModulus: number;
  /** 泊松比 ν */
  poissonRatio: number;
  /** 管壁密度 ρ_p，单位 kg/m³ */
  pipeDensity: number;
  /** 典型工程声速参考区间（用于与理论值对照），m/s */
  typicalSpeedRange: [number, number];
  /** 漏水噪声主频带参考，Hz */
  typicalLeakBand: [number, number];
  /** 漏水声高频参考衰减系数 α0，1/m（f0=1kHz 处） */
  attenuationAlpha0: number;
  /** 衰减频率指数 n：α(f)=α0·(f/f0)^n */
  attenuationExponent: number;
  /** 材料说明 */
  note: string;
}

/** 管段档案 */
export interface PipeSegment {
  id: string;
  /** 管段编号，如 DN200-CI-017 */
  code: string;
  material: MaterialId;
  /** 公称外径 D，mm */
  outerDiameterMm: number;
  /** 管壁厚度 e，mm */
  wallThicknessMm: number;
  /** 两传感器（阀门/消火栓）之间的管长 L，m */
  sensorSpacingM: number;
  /** 管道约束方式 */
  restraint: RestraintType;
  /** 安装地点描述 */
  location: string;
  createdAt: number;
}

/** 采集模式：仿真样本 或 真实麦克风 */
export type CaptureMode = 'simulated' | 'live';

/** 一路通道的采集缓冲 */
export interface ChannelBuffer {
  /** 采样率，Hz */
  sampleRate: number;
  /** 采样数据，Float32，归一化到 ±1 */
  samples: Float32Array;
}

/** 一次同步采集的完整数据 */
export interface Capture {
  id: string;
  segmentId: string;
  mode: CaptureMode;
  /** 仿真模式下使用的样本预设名 */
  samplePresetId?: string;
  startedAt: number;
  durationSec: number;
  channels: [ChannelBuffer, ChannelBuffer];
}

/** 加权互相关方法 */
export type WeightingMethod = 'standard' | 'phat' | 'scot';

/** 分析参数 */
export interface AnalysisConfig {
  /** 带通滤波低截止频率，Hz */
  bandLowHz: number;
  /** 带通滤波高截止频率，Hz */
  bandHighHz: number;
  /** 加权方法 */
  weighting: WeightingMethod;
  /** FFT 窗长（点） */
  fftSize: number;
}

/** 可信度评级 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** 相关分析结果 */
export interface AnalysisResult {
  id: string;
  captureId: string;
  segmentId: string;
  config: AnalysisConfig;
  /** 分析耗时（毫秒） */
  elapsedMs: number;
  /** 采用的管内声速 c，m/s（由弹性模量+壁厚理论公式计算） */
  soundSpeed: number;
  /** 理论声速与该管材典型参考值的偏差，百分比 */
  speedVsTypicalPct: number;
  /** 估计时延 τ = t_B - t_A，秒；正=漏点靠近 A，负=靠近 B */
  delaySec: number;
  /** 峰值滞后点数（亚采样，带符号） */
  delaySamples: number;
  /** 归一化相关曲线（滞后从 -N/2 到 N/2-1） */
  correlation: Float32Array;
  /** 相关曲线对应的滞后轴（秒） */
  lagAxisSec: Float32Array;
  /** 漏点距传感器 A 的管长，m */
  distanceFromA: number;
  /** 漏点距传感器 B 的管长，m */
  distanceFromB: number;
  /** 管段总长，m */
  spacing: number;
  /** 归一化主峰高度 0~1 */
  peakHeight: number;
  /** 峰锐度（主峰/次峰比） */
  peakSharpness: number;
  /** 双通道相干性 0~1（有效频带均值） */
  coherence: number;
  /** 有效带宽，Hz */
  effectiveBandwidthHz: number;
  /** 时延 CRB 换算的距离不确定度（米，越小越可信） */
  distanceUncertaintyM: number;
  /** 综合可信度 0~1 */
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel;
  /** 给班组看的中文提示信息 */
  advisories: string[];
  /** A 通道带通后频谱（dB），用于绘图 */
  spectrumA: Float32Array;
  /** B 通道带通后频谱（dB），用于绘图 */
  spectrumB: Float32Array;
  /** 频谱频率轴，Hz */
  spectrumFreqAxis: Float32Array;
}

/** 检漏记录（持久化到 IndexedDB） */
export interface LeakRecord {
  id: string;
  segmentId: string;
  segmentCode: string;
  location: string;
  material: MaterialId;
  captureId: string;
  resultId: string;
  /** 漏点距 A 距离，m */
  distanceFromA: number;
  /** 距 B 距离，m */
  distanceFromB: number;
  soundSpeed: number;
  delaySec: number;
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel;
  /** 处置状态 */
  status: 'pending' | 'excavated' | 'confirmed_leak' | 'false_alarm' | 'backfilled';
  /** 班组备注 */
  note: string;
  createdAt: number;
}

/** 仿真样本预设（编出来的管网/漏水噪声样本库） */
export interface SamplePreset {
  id: string;
  label: string;
  material: MaterialId;
  /** 漏点距 A 的真实距离，m（用于考核定位误差） */
  trueDistanceFromA: number;
  /** 传感器间距，m */
  spacing: number;
  /** 仿真采样率 */
  sampleRate: number;
  /** 仿真时长，秒 */
  durationSec: number;
  /** 漏水声源强度 0~1 */
  leakLevel: number;
  /** 交通噪声强度 0~1 */
  trafficLevel: number;
  /** 水泵噪声强度 0~1 */
  pumpLevel: number;
  /** 传感器本底噪声 0~1 */
  noiseFloor: number;
  /** 随机种子（可复现） */
  seed: number;
  description: string;
}
