/**
 * 双传感器管网噪声仿真合成器
 *
 * 物理模型：
 *  1. 漏水声源 s(t)：频域生成的宽带随机噪声，谱形按管材漏声带整形；
 *  2. 两条传播路径：漏点 → 传感器 A/B，各自施加
 *     - 分数延迟 exp(-j2πf·d/c)（亚采样精度，无需整数采样近似）
 *     - 频变衰减 exp(-α(f)·d)，PE 管高频衰减快、峰变钝即源于此；
 *  3. 干扰（两通道独立，模拟现场本地噪声）：
 *     - 交通噪声：低频 brown 轰鸣 + 随机过车事件（发动机低频线谱）
 *     - 水泵噪声：低频线谱谐波簇 + 轻微颤频
 *     - 传感器本底白噪、水流粉噪；
 *  4. tanh 软限幅模拟 ADC 饱和。
 */
import { FFT, nextPow2 } from './fft';
import { gaussianNoise, mulberry32, pinkNoise } from './random';
import { attenuationCoeff, MATERIAL_PRESETS } from './materials';
import type { MaterialId, SamplePreset, ChannelBuffer } from '../types';

/** 漏水声源谱包络：带通形（低频抬升、漏声带内平坦、带外滚降） */
function leakEnvelope(f: number, material: MaterialId): number {
  const [fL, fH] = MATERIAL_PRESETS[material].typicalLeakBand;
  if (f <= 0) return 0;
  const lowRise = Math.pow(f / fL, 1.5) / Math.sqrt(1 + Math.pow(f / fL, 5));
  const highRoll = 1 / Math.sqrt(1 + Math.pow(f / fH, 6));
  // 轻微粉色倾斜，越往高频能量越低
  const tilt = 1 / Math.sqrt(1 + f / (fL * 4));
  return lowRise * highRoll * tilt * 22;
}

/** 慢随机幅度起伏（模拟漏水喷溅声的自然调制） */
function slowEnvelope(n: number, fs: number, rand: () => number): Float32Array {
  const env = new Float32Array(n);
  const tau = 0.35; // 相关时间秒
  const p = Math.exp(-1 / (tau * fs));
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = p * v + (1 - p) * rand();
    env[i] = Math.exp(0.35 * (v - 0.5));
  }
  return env;
}

/** 交通噪声：brown 低频轰鸣 + 过车事件包络 + 发动机线谱 */
function trafficNoise(n: number, fs: number, rand: () => number, level: number): Float32Array {
  const out = new Float32Array(n);
  // brown 噪声（一阶积分低通，截止约 120 Hz）
  const pole = Math.exp((-2 * Math.PI * 120) / fs);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    brown = pole * brown + (1 - pole) * (rand() * 2 - 1);
    out[i] = brown * 3.2;
  }
  // 随机过车事件：3~7 秒的升余弦包络
  let t = 0;
  while (t < n / fs) {
    const dur = 3 + rand() * 4;
    const start = Math.floor(t * fs);
    const len = Math.floor(dur * fs);
    const fEng = 38 + rand() * 45; // 发动机基频 38~83 Hz
    const drift = (rand() - 0.5) * 8;
    for (let i = 0; i < len && start + i < n; i++) {
      const ph = i / fs;
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
      const tone =
        0.6 * Math.sin(2 * Math.PI * (fEng + drift * ph) * ph) +
        0.3 * Math.sin(2 * Math.PI * 2 * (fEng + drift * ph) * ph);
      out[start + i] += win * tone * 1.4;
    }
    t += dur + 2 + rand() * 6;
  }
  scaleRms(out, level * 0.055);
  return out;
}

/** 水泵噪声：低频谐波线谱簇 + 颤幅 */
function pumpNoise(n: number, fs: number, rand: () => number, level: number): Float32Array {
  const out = new Float32Array(n);
  const f0 = 47 + rand() * 6; // 水泵基频 ~50 Hz
  const harmonics = [1, 2, 4, 6];
  const amps = [1, 0.7, 0.35, 0.18];
  const vibrato = 0.004 * Math.sin(2 * Math.PI * 0.7 * (n / fs));
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const wob = 1 + 0.12 * Math.sin(2 * Math.PI * 2.3 * t); // 颤幅
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const f = f0 * harmonics[h] * (1 + vibrato);
      v += amps[h] * Math.sin(2 * Math.PI * f * t + h * 0.7);
    }
    out[i] = v * wob;
  }
  scaleRms(out, level * 0.045);
  return out;
}

function scaleRms(x: Float32Array, targetRms: number): void {
  let sq = 0;
  for (const v of x) sq += v * v;
  const cur = Math.sqrt(sq / x.length) + 1e-12;
  const k = targetRms / cur;
  for (let i = 0; i < x.length; i++) x[i] *= k;
}

function rmsOf(x: Float32Array): number {
  let sq = 0;
  for (const v of x) sq += v * v;
  return Math.sqrt(sq / x.length);
}

export interface SynthOutput {
  channels: [ChannelBuffer, ChannelBuffer];
  /** 漏点到 A/B 的传播时延，秒（考核真值） */
  trueArrival: [number, number];
  /** 实际采用的声速，m/s */
  soundSpeed: number;
}

/**
 * 按样本预设合成双通道信号。
 * @param soundSpeed 该管段理论声速（由物理公式算出后传入，保证仿真与模型一致）
 */
export function synthesizeCapture(preset: SamplePreset, soundSpeed: number): SynthOutput {
  const fs = preset.sampleRate;
  const n = Math.floor(preset.durationSec * fs);
  const nfft = nextPow2(n);
  const half = nfft >>> 1;
  const rand = mulberry32(preset.seed);
  const mat = preset.material;

  const dA = preset.trueDistanceFromA;
  const dB = preset.spacing - dA;
  const tA = dA / soundSpeed;
  const tB = dB / soundSpeed;

  // ---- 1. 频域直接生成漏水声源谱 S(f) ----
  const fft = new FFT(nfft);
  const srcRe = new Float32Array(nfft);
  const srcIm = new Float32Array(nfft);
  for (let k = 1; k < half; k++) {
    const f = (k * fs) / nfft;
    const env = leakEnvelope(f, mat);
    // 瑞利幅度近似：两个独立高斯相乘
    srcRe[k] = env * (rand() + rand() - 1);
    srcIm[k] = env * (rand() + rand() - 1);
  }

  // ---- 2. 两条传播路径：衰减 + 分数延迟，各自 IFFT ----
  // 两路传感器/阀门耦合的频响并不完全一致：加入与干扰水平相关的
  // 幅度纹波与相位抖动，模拟现场贴棒耦合差异（PE 管高频对此尤其敏感）。
  const mismatch = 0.15 + 0.5 * preset.noiseFloor; // 耦合不一致强度
  const rippleA = new Float32Array(half + 1);
  const rippleB = new Float32Array(half + 1);
  const rRipple = mulberry32((preset.seed + 777) >>> 0);
  for (let k = 1; k <= half; k++) {
    const f = (k * fs) / nfft;
    const fNorm = f / (fs / 2);
    rippleA[k] = mismatch * (0.6 * Math.sin(2 * Math.PI * 3.7 * fNorm + 1.3) + 0.4 * (rRipple() - 0.5));
    rippleB[k] = mismatch * (0.6 * Math.sin(2 * Math.PI * 4.3 * fNorm + 2.1) + 0.4 * (rRipple() - 0.5));
  }
  const buildChannel = (
    dist: number,
    delaySec: number,
    ripple: Float32Array,
  ): Float32Array => {
    const re = new Float32Array(nfft);
    const im = new Float32Array(nfft);
    const delaySamples = delaySec * fs;
    for (let k = 0; k <= half; k++) {
      const f = (k * fs) / nfft;
      const att = Math.exp(-attenuationCoeff(mat, f) * dist);
      // 传感器耦合：幅度纹波 + 随频率增大的相位抖动（弧度）
      const ampSensor = 1 + ripple[k];
      const phaseJitter = mismatch * 0.5 * (ripple[k] / (mismatch + 1e-9)) * Math.PI * (f / (fs / 2));
      const phase = -2 * Math.PI * k * (delaySamples / nfft) + phaseJitter;
      const wr = Math.cos(phase);
      const wi = Math.sin(phase);
      const sr = srcRe[k];
      const si = srcIm[k];
      const ar = sr * att * ampSensor;
      const ai = si * att * ampSensor;
      re[k] = ar * wr - ai * wi;
      im[k] = ar * wi + ai * wr;
    }
    for (let k = half + 1; k < nfft; k++) {
      const mk = nfft - k;
      re[k] = re[mk];
      im[k] = -im[mk];
    }
    fft.inverse(re, im);
    return re.slice(0, n);
  };

  const rawA = buildChannel(dA, tA, rippleA);
  const rawB = buildChannel(dB, tB, rippleB);

  // 慢起伏调制
  const env = slowEnvelope(n, fs, rand);
  for (let i = 0; i < n; i++) {
    rawA[i] *= env[i];
    rawB[i] *= env[i];
  }

  // ---- 漏水分量目标电平标定（全频带 RMS 归一再放大）----
  // 漏水信号是两通道唯一的同源分量，必须在带内明显强于本地干扰，
  // 否则互相关被独立噪声主导；强弱差别由各预设的 leakLevel 控制。
  const targetLeakRms = 0.09 + 0.05 * preset.leakLevel; // 0.095~0.14
  const normA = targetLeakRms / (rmsOf(rawA) + 1e-12);
  const normB = targetLeakRms / (rmsOf(rawB) + 1e-12);
  const chA = new Float32Array(n);
  const chB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    chA[i] = rawA[i] * normA;
    chB[i] = rawB[i] * normB;
  }

  // ---- 3. 现场干扰：公共相干分量 + 通道独立分量 ----
  // 真实路面/泵站振动经土体同时传到两个阀门，因此干扰并非完全独立，
  // 而是"部分相干"：相干部分会抬升互谱底噪、压低有效相干性。
  // 相干占比随交通/水泵强度增大，恶劣工况下显著拉低定位可信度。
  const rCommon = mulberry32((preset.seed + 3001) >>> 0);
  const commonTraffic = trafficNoise(n, fs, rCommon, 1);
  const commonPump = pumpNoise(n, fs, rCommon, 1);
  // 公共分量到两个传感器的短延迟（远小于漏水时延，主要贡献零附近底噪）
  const commonDelayA = 0.003 + preset.seed % 7 * 0.0007;
  const commonDelayB = commonDelayA + 0.004;
  const commonA = new Float32Array(n);
  const commonB = new Float32Array(n);
  const fftInf = new FFT(nfft);
  const injectCommon = (out: Float32Array, delaySec: number, gainA: number): void => {
    const re = new Float32Array(nfft);
    const im = new Float32Array(nfft);
    for (let i = 0; i < n; i++) re[i] = (commonTraffic[i] * 0.7 + commonPump[i] * 0.5) * gainA;
    fftInf.forward(re, im);
    const ds = delaySec * fs;
    for (let k = 0; k <= half; k++) {
      const ph = -2 * Math.PI * k * (ds / nfft);
      const wr = Math.cos(ph), wi = Math.sin(ph);
      const ar = re[k], ai = im[k];
      re[k] = ar * wr - ai * wi;
      im[k] = ar * wi + ai * wr;
    }
    for (let k = half + 1; k < nfft; k++) {
      const mk = nfft - k;
      re[k] = re[mk];
      im[k] = -im[mk];
    }
    fftInf.inverse(re, im);
    for (let i = 0; i < n; i++) out[i] = re[i];
  };
  injectCommon(commonA, commonDelayA, 1);
  injectCommon(commonB, commonDelayB, 0.92);

  // 干扰相干占比：干扰越强，公共振动占比越高（0.25~0.7）
  const coherentFraction = Math.min(
    0.7,
    0.22 + 0.35 * Math.max(preset.trafficLevel, preset.pumpLevel),
  );
  const targetInfRms =
    0.018 + 0.05 * Math.max(preset.trafficLevel, preset.pumpLevel) + 0.025 * preset.noiseFloor;
  const kCommon = (targetInfRms * coherentFraction) / (rmsOf(commonA) + 1e-12);
  const kCommonB = (targetInfRms * coherentFraction) / (rmsOf(commonB) + 1e-12);

  const mixInterference = (
    ch: Float32Array,
    seedOffset: number,
    common: Float32Array,
    kC: number,
  ): void => {
    const r2 = mulberry32((preset.seed + seedOffset) >>> 0);
    const traffic = trafficNoise(n, fs, r2, preset.trafficLevel);
    const pump = pumpNoise(n, fs, r2, preset.pumpLevel);
    const floor = new Float32Array(n);
    const flow = new Float32Array(n);
    gaussianNoise(floor, r2, preset.noiseFloor * 0.02);
    pinkNoise(flow, r2, preset.noiseFloor * 0.025);
    const indep = new Float32Array(n);
    for (let i = 0; i < n; i++) indep[i] = traffic[i] + pump[i] + floor[i] + flow[i];
    const kIndep = (targetInfRms * (1 - coherentFraction)) / (rmsOf(indep) + 1e-12);
    for (let i = 0; i < n; i++) {
      ch[i] += common[i] * kC + indep[i] * kIndep;
      // ADC 软限幅
      ch[i] = Math.tanh(ch[i] * 1.6) / Math.tanh(1.6);
    }
  };
  mixInterference(chA, 1013, commonA, kCommon);
  mixInterference(chB, 2027, commonB, kCommonB);

  return {
    channels: [
      { sampleRate: fs, samples: chA },
      { sampleRate: fs, samples: chB },
    ],
    trueArrival: [tA, tB],
    soundSpeed,
  };
}
