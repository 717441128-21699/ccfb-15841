/**
 * 窗函数
 */

/** Hann 窗，长度 n */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

/** 窗的相干增益（均值）与能量增益（均方根平方） */
export function windowGains(w: Float32Array): { coherent: number; energy: number } {
  let s = 0;
  let sq = 0;
  for (const v of w) {
    s += v;
    sq += v * v;
  }
  return { coherent: s / w.length, energy: sq / w.length };
}
