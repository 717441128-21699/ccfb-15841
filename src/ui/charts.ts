/**
 * Canvas 绘图工具集：波形、频谱、相关曲线
 * 全部按设备像素比缩放，支持主题色变量。
 */

export interface PlotStyle {
  fg: string;
  grid: string;
  accent: string;
  accent2: string;
  warn: string;
  bg: string;
}

export function getPlotStyle(): PlotStyle {
  const css = getComputedStyle(document.documentElement);
  return {
    fg: css.getPropertyValue('--fg').trim() || '#1a2330',
    grid: css.getPropertyValue('--grid').trim() || '#d8dee6',
    accent: css.getPropertyValue('--accent').trim() || '#1f6feb',
    accent2: css.getPropertyValue('--accent-2').trim() || '#d97706',
    warn: css.getPropertyValue('--warn').trim() || '#dc2626',
    bg: css.getPropertyValue('--panel').trim() || '#ffffff',
  };
}

function setupCanvas(canvas: HTMLCanvasElement): [CanvasRenderingContext2D, number, number, number] {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(320, rect.width);
  const h = Math.max(160, rect.height);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h, dpr];
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, style: PlotStyle): void {
  ctx.strokeStyle = style.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 5; i++) {
    const x = (w * i) / 5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let i = 1; i < 4; i++) {
    const y = (h * i) / 4;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

/** 时域波形（可双路叠加） */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  a: Float32Array,
  b?: Float32Array,
  decimate = 8,
): void {
  const [ctx, w, h] = setupCanvas(canvas);
  const style = getPlotStyle();
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h, style);
  const mid = h / 2;
  const amp = h * 0.42;
  const drawOne = (data: Float32Array, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(data.length / w) * decimate);
    let first = true;
    for (let i = 0; i < data.length; i += step) {
      const x = (i / data.length) * w;
      const y = mid - data[i] * amp;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  drawOne(a, style.accent);
  if (b) drawOne(b, style.accent2);
}

/** 双路频谱（dB），freqAxis 为线性频率轴 */
export function drawSpectrum(
  canvas: HTMLCanvasElement,
  freqAxis: Float32Array,
  specA: Float32Array,
  specB: Float32Array,
  bandLow: number,
  bandHigh: number,
): void {
  const [ctx, w, h] = setupCanvas(canvas);
  const style = getPlotStyle();
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h, style);
  const fMax = freqAxis[freqAxis.length - 1];
  // 通带高亮
  const xL = (bandLow / fMax) * w;
  const xH = (bandHigh / fMax) * w;
  ctx.fillStyle = 'rgba(31,111,235,0.08)';
  ctx.fillRect(xL, 0, xH - xL, h);

  let dbMin = -90;
  let dbMax = -20;
  for (const v of specA) {
    dbMin = Math.min(dbMin, v);
    dbMax = Math.max(dbMax, v);
  }
  const drawOne = (spec: Float32Array, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let k = 0; k < spec.length; k++) {
      const x = (freqAxis[k] / fMax) * w;
      const y = h - ((spec[k] - dbMin) / (dbMax - dbMin)) * h * 0.92 - h * 0.04;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  drawOne(specA, style.accent);
  drawOne(specB, style.accent2);

  ctx.fillStyle = style.fg;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`${Math.round(fMax)} Hz`, w - 52, h - 6);
  ctx.fillText('0', 4, h - 6);
  ctx.fillStyle = style.accent;
  ctx.fillText(`通带 ${bandLow}~${bandHigh} Hz`, xL + 6, 14);
}

/** 互相关曲线 + 峰值标注 */
export function drawCorrelation(
  canvas: HTMLCanvasElement,
  lagAxis: Float32Array,
  corr: Float32Array,
  peakLagSec: number,
  peakValue: number,
): void {
  const [ctx, w, h] = setupCanvas(canvas);
  const style = getPlotStyle();
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h, style);
  const mid = h / 2;
  const amp = h * 0.44;
  const lagMax = lagAxis[lagAxis.length - 1];

  // 零滞后轴
  ctx.strokeStyle = style.grid;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();

  ctx.strokeStyle = style.accent;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < corr.length; i++) {
    const x = ((lagAxis[i] + lagMax) / (2 * lagMax)) * w;
    const y = mid - corr[i] * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 峰标记
  const px = ((peakLagSec + lagMax) / (2 * lagMax)) * w;
  const py = mid - peakValue * amp;
  ctx.strokeStyle = style.warn;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 6);
  ctx.lineTo(px, h - 6);
  ctx.stroke();
  ctx.fillStyle = style.warn;
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = 'bold 12px system-ui, sans-serif';
  const label = `τ=${(peakLagSec * 1000).toFixed(3)} ms`;
  ctx.fillText(label, Math.min(px + 8, w - 110), py - 8);

  ctx.fillStyle = style.fg;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`-${lagMax.toFixed(3)}s`, 4, h - 6);
  ctx.fillText(`+${lagMax.toFixed(3)}s`, w - 58, h - 6);
  ctx.fillText('0', w / 2 + 4, h - 6);
}
