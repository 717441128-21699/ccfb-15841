/**
 * 相关分析页：滤波频带/加权/FFT 窗长配置 → Web Worker 跑完整分析
 * 展示：声速校核、时延、漏点距离、相关曲线、双路频谱、可信度与诊断提示
 */
import { h, clear, fmt } from '../ui/dom';
import { store } from '../lib/store';
import { MATERIAL_PRESETS, theoreticalSoundSpeed } from '../dsp/materials';
import { autoFftSize } from '../dsp/correlator';
import { drawCorrelation, drawSpectrum } from '../ui/charts';
import { uid } from '../lib/id';
import type { AnalysisConfig, AnalysisResult, LeakRecord, WeightingMethod } from '../types';
import type { AnalyzeRequest, WorkerResponse } from '../worker/correlation.worker';

const WEIGHT_LABELS: Record<WeightingMethod, string> = {
  standard: '普通互相关',
  phat: 'PHAT 加权（压尖相关峰，推荐）',
  scot: 'SCOT 白化加权',
};

const FFT_CHOICES = [1024, 2048, 4096, 8192, 16384];

export function renderAnalysisPage(root: HTMLElement): void {
  const state = store.getState();
  clear(root);

  const seg = state.segments.find((s) => s.id === state.currentSegmentId) ?? null;
  const cap = state.captures.find((c) => c.id === state.currentCaptureId) ?? null;
  const result = state.results.find((r) => r.id === state.currentResultId) ?? null;

  const cfgPanel = h('div', { class: 'panel' });
  const outPanel = h('div', { class: 'panel' });
  root.append(cfgPanel, outPanel);

  if (!seg || !cap) {
    cfgPanel.append(h('h2', {}, '相关分析'));
    cfgPanel.append(h('div', { class: 'advisory warn' }, '请先在「管段录入」选择管段、在「同步采集」选择一次采集数据。'));
    return;
  }

  const cfg = state.analysisConfig;
  const mat = MATERIAL_PRESETS[seg.material];
  const fs = cap.channels[0].sampleRate;

  const lowInput = h('input', { type: 'number', value: String(cfg.bandLowHz), min: '10', step: '10' }) as HTMLInputElement;
  const highInput = h('input', { type: 'number', value: String(cfg.bandHighHz), min: '50', step: '50' }) as HTMLInputElement;
  const weightSelect = h('select', {},
    (Object.keys(WEIGHT_LABELS) as WeightingMethod[]).map((w) => h('option', { value: w }, WEIGHT_LABELS[w])),
  ) as HTMLSelectElement;
  weightSelect.value = cfg.weighting;

  // 按管长/声速推荐能完整覆盖物理时延 L/c 的最小窗长，并预选中
  const segSpeed = theoreticalSoundSpeed(seg);
  const recommendedFft = autoFftSize(seg.sensorSpacingM, segSpeed, fs);
  if (!FFT_CHOICES.includes(cfg.fftSize) || cfg.fftSize < recommendedFft) {
    store.patchConfig({ fftSize: recommendedFft });
  }
  const fftSelect = h('select', {}, FFT_CHOICES.map((n) =>
    h('option', { value: String(n) },
      `${n} 点（${fmt(fs / n, 2)} Hz 分辨率）${n === recommendedFft ? ' · 推荐' : ''}`),
  )) as HTMLSelectElement;
  fftSelect.value = String(store.getState().analysisConfig.fftSize);

  const autoBandBtn = h('button', { class: 'btn secondary', type: 'button' }, '按管材推荐频带') as HTMLButtonElement;
  autoBandBtn.addEventListener('click', () => {
    lowInput.value = String(mat.typicalLeakBand[0]);
    highInput.value = String(Math.min(mat.typicalLeakBand[1], fs / 2 - 100));
  });

  const runBtn = h('button', { class: 'btn' }, '开始相关分析（Web Worker）') as HTMLButtonElement;
  const statusLine = h('div', { class: 'muted', style: 'margin-top:8px' }, '就绪。60 秒双通道数据完整分析目标耗时 ≤ 1 秒。');

  cfgPanel.append(
    h('h2', {}, `相关分析 · ${seg.code}（${mat.label}，L=${seg.sensorSpacingM}m，fs=${fs}Hz）`),
    h('div', { class: 'grid-3' }, [
      h('label', { class: 'field' }, ['带通低截止 (Hz)', lowInput]),
      h('label', { class: 'field' }, ['带通高截止 (Hz)', highInput]),
      h('label', { class: 'field' }, ['加权方法', weightSelect]),
      h('label', { class: 'field' }, ['FFT 窗长', fftSelect]),
      h('div', { class: 'field' }, [' ', autoBandBtn]),
    ]),
    h('div', { style: 'margin-top:14px' }, [runBtn]),
    statusLine,
  );

  runBtn.addEventListener('click', () => {
    const newCfg: AnalysisConfig = {
      bandLowHz: Number(lowInput.value),
      bandHighHz: Number(highInput.value),
      weighting: weightSelect.value as WeightingMethod,
      fftSize: Number(fftSelect.value),
    };
    if (newCfg.bandHighHz <= newCfg.bandLowHz) {
      statusLine.textContent = '频带设置非法：高截止必须大于低截止。';
      return;
    }
    store.patchConfig(newCfg);
    void runWorkerAnalysis(newCfg, statusLine, runBtn, outPanel);
  });

  if (result) renderResult(outPanel, result, seg.id, seg.code, seg.location);
}

function runWorkerAnalysis(
  cfg: AnalysisConfig,
  statusLine: HTMLElement,
  runBtn: HTMLButtonElement,
  outPanel: HTMLElement,
): void {
  const state = store.getState();
  const seg = state.segments.find((s) => s.id === state.currentSegmentId)!;
  const cap = state.captures.find((c) => c.id === state.currentCaptureId)!;

  // 深拷贝采集数据，Transferable 移交后原对象缓冲会被 neuter
  const captureCopy: typeof cap = {
    ...cap,
    channels: [
      { ...cap.channels[0], samples: new Float32Array(cap.channels[0].samples) },
      { ...cap.channels[1], samples: new Float32Array(cap.channels[1].samples) },
    ],
  };

  const worker = new Worker(new URL('../worker/correlation.worker.ts', import.meta.url), { type: 'module' });
  runBtn.disabled = true;
  store.setBusy(true);
  statusLine.textContent = 'Worker 已启动，正在做零相位带通滤波…';

  worker.onmessage = async (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      statusLine.textContent = msg.message;
      return;
    }
    if (msg.type === 'error') {
      statusLine.textContent = `分析失败：${msg.message}`;
      worker.terminate();
      runBtn.disabled = false;
      store.setBusy(false);
      return;
    }
    if (msg.type === 'done') {
      worker.terminate();
      runBtn.disabled = false;
      store.setBusy(false);
      const r = msg.result;
      statusLine.textContent = `分析完成，Worker 内计算耗时 ${fmt(r.elapsedMs, 0)} ms（60s 数据，要求 ≤1000 ms）。`;
      await store.saveResult(r);
      renderResult(outPanel, r, seg.id, seg.code, seg.location);
    }
  };
  worker.onerror = (e) => {
    statusLine.textContent = `Worker 异常：${e.message}`;
    runBtn.disabled = false;
    store.setBusy(false);
  };

  const req: AnalyzeRequest = { type: 'analyze', capture: captureCopy, segment: seg, config: cfg };
  worker.postMessage(req, [
    captureCopy.channels[0].samples.buffer,
    captureCopy.channels[1].samples.buffer,
  ]);
}

function renderResult(
  panel: HTMLElement,
  r: AnalysisResult,
  segmentId: string,
  segmentCode: string,
  location: string,
): void {
  clear(panel);
  const levelText = { high: '高可信度', medium: '中可信度', low: '低可信度' }[r.confidenceLevel];
  const peakIdx = indexOfPeak(r.correlation);
  const peakValue = r.correlation[peakIdx];

  panel.append(
    h('h2', {}, '定位结果'),
    h('div', { class: 'grid-3' }, [
      h('div', { class: 'metric' }, [
        h('div', { class: 'k' }, '漏点距传感器 A'),
        h('div', { class: 'v', style: 'color:var(--accent)' }, `${fmt(r.distanceFromA, 2)} `, h('span', { class: 'u' }, 'm')),
      ]),
      h('div', { class: 'metric' }, [
        h('div', { class: 'k' }, '漏点距传感器 B'),
        h('div', { class: 'v', style: 'color:var(--accent-2)' }, `${fmt(r.distanceFromB, 2)} `, h('span', { class: 'u' }, 'm')),
      ]),
      h('div', { class: 'metric' }, [
        h('div', { class: 'k' }, '估计时延 τ = t_B − t_A'),
        h('div', { class: 'v' }, `${fmt(r.delaySec * 1000, 3)} `, h('span', { class: 'u' }, 'ms')),
      ]),
      h('div', { class: 'metric' }, [
        h('div', { class: 'k' }, '采用管内声速 c'),
        h('div', { class: 'v' }, `${fmt(r.soundSpeed, 1)} `, h('span', { class: 'u' }, 'm/s')),
      ]),
      h('div', { class: 'metric' }, [
        h('div', { class: 'k' }, '声速与典型值偏差'),
        h('div', { class: 'v', style: r.speedVsTypicalPct > 5 ? 'color:var(--bad)' : 'color:var(--ok)' },
          `${fmt(r.speedVsTypicalPct, 2)} `, h('span', { class: 'u' }, '%（要求 ≤5%）')),
      ]),
      h('div', { class: 'metric' }, [
        h('div', { class: 'k' }, '可信度'),
        h('div', { class: 'v' }, [
          h('span', { class: `badge ${r.confidenceLevel}`, style: 'font-size:14px;padding:4px 14px' }, levelText),
          h('span', { class: 'u', style: 'margin-left:8px' }, `${fmt(r.confidenceScore * 100, 0)} 分`),
        ]),
      ]),
    ]),
  );

  // 诊断指标条
  panel.append(
    h('div', { class: 'grid-3', style: 'margin-top:14px' }, [
      h('div', { class: 'metric' }, [h('div', { class: 'k' }, '归一化相关峰高'), h('div', { class: 'v', style: 'font-size:18px' }, fmt(r.peakHeight, 3))]),
      h('div', { class: 'metric' }, [h('div', { class: 'k' }, '峰锐度（主峰/次峰）'), h('div', { class: 'v', style: 'font-size:18px' }, fmt(r.peakSharpness, 2))]),
      h('div', { class: 'metric' }, [
        h('div', { class: 'k' }, '通带相干性 / 有效带宽'), h('div', { class: 'v', style: 'font-size:18px' }, `${fmt(r.coherence, 2)} / ${fmt(r.effectiveBandwidthHz, 0)} Hz`)],
      ),
      h('div', { class: 'metric' }, [
        h('div', { class: 'k' }, '距离不确定度 ±（CRB 估计）'),
        h('div', { class: 'v', style: 'font-size:18px' }, `${fmt(r.distanceUncertaintyM, 2)} `, h('span', { class: 'u' }, 'm')),
      ]),
    ]),
  );

  // 诊断提示
  const advWrap = h('div', { style: 'margin-top:14px' }, h('h3', {}, '系统诊断与施工提示'));
  for (const msg of r.advisories) {
    const cls = r.confidenceLevel === 'low' ? 'bad' : r.confidenceLevel === 'medium' ? 'warn' : 'ok';
    advWrap.append(h('div', { class: `advisory ${cls}` }, msg));
  }
  panel.append(advWrap);

  // 图
  const corrCanvas = h('canvas', { class: 'plot' }) as HTMLCanvasElement;
  const specCanvas = h('canvas', { class: 'plot' }) as HTMLCanvasElement;
  panel.append(
    h('h3', { style: 'margin-top:18px' }, '加权互相关函数'),
    corrCanvas,
    h('h3', { style: 'margin-top:14px' }, '双路功率谱（带通区间高亮）'),
    specCanvas,
  );
  requestAnimationFrame(() => {
    drawCorrelation(corrCanvas, r.lagAxisSec, r.correlation, r.delaySec, peakValue);
    drawSpectrum(specCanvas, r.spectrumFreqAxis, r.spectrumA, r.spectrumB, r.config.bandLowHz, r.config.bandHighHz);
  });

  // 存档为检漏记录
  const noteInput = h('textarea', { rows: '2', placeholder: '班组备注：地表情况、阀门编号、复测安排…' }) as HTMLTextAreaElement;
  const saveRecBtn = h('button', { class: 'btn' }, '生成检漏记录并归档') as HTMLButtonElement;
  saveRecBtn.addEventListener('click', async () => {
    const state2 = store.getState();
    const rec: LeakRecord = {
      id: uid('rec'),
      segmentId,
      segmentCode,
      location,
      material: state2.segments.find((s) => s.id === segmentId)!.material,
      captureId: r.captureId,
      resultId: r.id,
      distanceFromA: r.distanceFromA,
      distanceFromB: r.distanceFromB,
      soundSpeed: r.soundSpeed,
      delaySec: r.delaySec,
      confidenceScore: r.confidenceScore,
      confidenceLevel: r.confidenceLevel,
      status: 'pending',
      note: noteInput.value.trim(),
      createdAt: Date.now(),
    };
    await store.saveRecord(rec);
    saveRecBtn.textContent = '已归档 ✓';
    saveRecBtn.disabled = true;
  });
  panel.append(
    h('h3', { style: 'margin-top:18px' }, '归档'),
    noteInput,
    h('div', { style: 'margin-top:10px' }, [saveRecBtn]),
  );
}

function indexOfPeak(corr: Float32Array): number {
  let idx = 0;
  let v = -Infinity;
  for (let i = 0; i < corr.length; i++) {
    if (Math.abs(corr[i]) > v) {
      v = Math.abs(corr[i]);
      idx = i;
    }
  }
  return idx;
}
