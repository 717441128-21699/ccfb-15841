/**
 * 零相位 Butterworth 带通滤波器
 *
 * 设计：RBJ 双线性变换分别设计高通（低截止）与低通（高截止），
 * 每侧 4 阶（两个 biquad 节，Q 取 Butterworth 解析值 0.5412 / 1.3066），
 * 级联后做 filtfilt（正向+反向）获得零相位——幅频被平方、相位为零，
 * 不会给两路信号引入附加相位差，这对互相关时延估计是硬性要求。
 */
export interface BiquadCoeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

/** 4 阶 Butterworth 的两级 Q 值 */
const BUTTER_Q_4 = [0.541196100146197, 1.306562964876377];

function rbjLowpass(freqHz: number, q: number, sampleRate: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw) / 2) / a0,
    b1: (1 - cosw) / a0,
    b2: ((1 - cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function rbjHighpass(freqHz: number, q: number, sampleRate: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw) / 2) / a0,
    b1: (-(1 + cosw)) / a0,
    b2: ((1 + cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** 构造 4 阶低通 + 4 阶高通级联的带通节序列（filtfilt 后等效 16 阶） */
export function butterBandpass(
  lowHz: number,
  highHz: number,
  sampleRate: number,
): BiquadCoeffs[] {
  const nyq = sampleRate / 2;
  if (!(lowHz > 5 && highHz > lowHz && highHz < nyq * 0.98)) {
    throw new Error(`带通频率非法：${lowHz}~${highHz} Hz（奈奎斯特 ${nyq} Hz）`);
  }
  const sections: BiquadCoeffs[] = [];
  for (const q of BUTTER_Q_4) sections.push(rbjHighpass(lowHz, q, sampleRate));
  for (const q of BUTTER_Q_4) sections.push(rbjLowpass(highHz, q, sampleRate));
  return sections;
}

/** 单遍 DF2-T 转置型 biquad 滤波（原地） */
function applyOnce(x: Float32Array, s: BiquadCoeffs): void {
  let v1 = 0;
  let v2 = 0;
  for (let i = 0; i < x.length; i++) {
    const inp = x[i];
    const out = s.b0 * inp + v1;
    v1 = s.b1 * inp - s.a1 * out + v2;
    v2 = s.b2 * inp - s.a2 * out;
    x[i] = out;
  }
}

/** filtfilt 零相位滤波：反射镜像延拓抑制端点瞬态，正反向各滤波一遍 */
export function zeroPhaseBandpass(
  input: Float32Array,
  sections: BiquadCoeffs[],
): Float32Array {
  const n = input.length;
  const pad = Math.min(n - 1, 24);
  const buf = new Float32Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    buf[i] = input[pad - i] ?? 0;
    buf[buf.length - 1 - i] = input[n - 2 - i] ?? 0;
  }
  buf.set(input, pad);

  for (const s of sections) {
    applyOnce(buf, s);
    buf.reverse();
    applyOnce(buf, s);
    buf.reverse();
  }
  return buf.slice(pad, pad + n);
}
