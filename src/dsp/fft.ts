/**
 * 迭代版 radix-2 Cooley–Tukey FFT
 * 实部、虚部分别存于两个 Float32Array，原地运算。
 * 长度必须为 2 的幂。
 */
export class FFT {
  readonly size: number;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0 || size < 2) {
      throw new Error('FFT 长度必须为 2 的幂');
    }
    this.size = size;
    const half = size >>> 1;
    this.cosTable = new Float32Array(half);
    this.sinTable = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      const theta = (-2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(theta);
      this.sinTable[i] = Math.sin(theta);
    }
    // 位反转置换表
    this.reverse = new Uint32Array(size);
    let j = 0;
    for (let i = 1; i < size; i++) {
      let bit = half;
      while (j & bit) {
        j ^= bit;
      bit >>>= 1;
      }
      j ^= bit;
      this.reverse[i] = j;
    }
  }

  /** 正向 FFT（sign=-1），结果原地写回 re/im */
  forward(re: Float32Array, im: Float32Array): void {
    const n = this.size;
    const rev = this.reverse;
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (r > i) {
        let t = re[i]; re[i] = re[r]; re[r] = t;
        t = im[i]; im[i] = im[r]; im[r] = t;
      }
    }
    const cosT = this.cosTable;
    const sinT = this.sinTable;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >>> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        let k = 0;
        for (let m = 0; m < half; m++, k += step) {
          const a = i + m;
          const b = a + half;
          const wr = cosT[k];
          const wi = sinT[k];
          const xr = re[b];
          const xi = im[b];
          const tr = wr * xr - wi * xi;
          const ti = wr * xi + wi * xr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  /** 逆向 FFT（sign=+1），输出 1/N 归一化，原地写回 */
  inverse(re: Float32Array, im: Float32Array): void {
    // 逆变换 = 虚部取共轭后正变换，再共轭并除以 N
    const n = this.size;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.forward(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] = -im[i] * inv;
    }
  }
}

/** 下取最近的 2 的幂 */
export function nextPow2(x: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(2, x)));
}

/**
 * 单频点分数延迟（在调用处给定 FFT 实例与频域缓冲）。
 * 相位谱乘以 exp(-j·2πf·d)，d 单位为采样点，可为小数。
 */
export function applyFractionalDelayPhase(
  re: Float32Array,
  im: Float32Array,
  fftSize: number,
  delaySamples: number,
): void {
  const half = fftSize >>> 1;
  // k = 0 .. half（含 Nyquist），负频段由共轭对称性决定
  for (let k = 0; k <= half; k++) {
    const phase = (-2 * Math.PI * k * delaySamples) / fftSize;
    const wr = Math.cos(phase);
    const wi = Math.sin(phase);
    const ar = re[k];
    const ai = im[k];
    re[k] = ar * wr - ai * wi;
    im[k] = ar * wi + ai * wr;
  }
  // 重建负频段（实数信号共轭对称）
  for (let k = half + 1; k < fftSize; k++) {
    const mk = fftSize - k;
    re[k] = re[mk];
    im[k] = -im[mk];
  }
}
