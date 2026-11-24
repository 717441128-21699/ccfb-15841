/**
 * 确定性随机数与噪声生成（仿真样本可复现）
 */

/** mulberry32 伪随机数发生器，返回 0..1 的函数 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 高斯白噪声（Box–Muller），写入 out，强度 rms 由 rms 给定 */
export function gaussianNoise(
  out: Float32Array,
  rand: () => number,
  rms: number,
): void {
  let spare: number | null = null;
  for (let i = 0; i < out.length; i++) {
    if (spare !== null) {
      out[i] = rms * spare;
      spare = null;
    } else {
      let u = 0;
      let v = 0;
      while (u === 0) u = rand();
      v = rand();
      const mag = Math.sqrt(-2 * Math.log(u));
      const z0 = mag * Math.cos(2 * Math.PI * v);
      const z1 = mag * Math.sin(2 * Math.PI * v);
      out[i] = rms * z0;
      spare = z1;
    }
  }
}

/** 粉色噪声（Voss–McCartney 近似），经多级一阶低通累加后白化整形 */
export function pinkNoise(
  out: Float32Array,
  rand: () => number,
  rms: number,
): void {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let sumSq = 0;
  for (let i = 0; i < out.length; i++) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    out[i] = pink;
    sumSq += pink * pink;
  }
  const scale = rms / Math.sqrt(sumSq / out.length + 1e-12);
  for (let i = 0; i < out.length; i++) out[i] *= scale;
}
