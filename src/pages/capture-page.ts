/**
 * 同步采集页
 *  - 仿真模式：选择自编样本库预设，合成双通道 60s 信号并入库
 *  - 实时模式：getUserMedia + AudioWorklet 双通道采集，Web Audio 带通监听
 */
import { h, clear, fmt, fmtTime } from '../ui/dom';
import { store } from '../lib/store';
import { SAMPLE_PRESETS } from '../dsp/sample-presets';
import { synthesizeCapture } from '../dsp/synthesizer';
import { theoreticalSoundSpeed, MATERIAL_PRESETS } from '../dsp/materials';
import { uid } from '../lib/id';
import { drawWaveform } from '../ui/charts';
import { LiveCaptureSession } from '../audio/live-capture';
import type { Capture, ChannelBuffer } from '../types';

let liveSession: LiveCaptureSession | null = null;
let rafId = 0;

export function renderCapturePage(root: HTMLElement): void {
  const state = store.getState();
  cancelAnimationFrame(rafId);
  liveSession?.stop();
  liveSession = null;
  clear(root);

  const seg = state.segments.find((s) => s.id === state.currentSegmentId) ?? null;
  const setupPanel = h('div', { class: 'panel' });
  const simPanel = h('div', { class: 'panel' });
  const livePanel = h('div', { class: 'panel' });
  const listPanel = h('div', { class: 'panel' });
  root.append(setupPanel, simPanel, livePanel, listPanel);

  // ---- 当前管段 ----
  setupPanel.append(h('h2', {}, '当前管段'));
  if (!seg) {
    setupPanel.append(h('div', { class: 'advisory warn' }, '尚未选择管段，请先到「管段录入」页录入并点选一条管段。'));
  } else {
    const c = theoreticalSoundSpeed(seg);
    setupPanel.append(
      h('div', { class: 'grid-3' }, [
        h('div', { class: 'metric' }, [h('div', { class: 'k' }, '管段编号'), h('div', { class: 'v', style: 'font-size:17px' }, seg.code)]),
        h('div', { class: 'metric' }, [h('div', { class: 'k' }, '管材 / 间距'), h('div', { class: 'v', style: 'font-size:17px' }, `${MATERIAL_PRESETS[seg.material].label} · ${seg.sensorSpacingM}m`)]),
        h('div', { class: 'metric' }, [h('div', { class: 'k' }, '理论声速'), h('div', { class: 'v', style: 'font-size:17px' }, `${fmt(c, 0)} m/s`)]),
      ]),
    );
  }

  // ---- 仿真采集 ----
  simPanel.append(h('h2', {}, '仿真样本采集（自编管网/漏水噪声库）'));
  const compatible = seg
    ? SAMPLE_PRESETS.filter((p) => p.material === seg.material && p.spacing === seg.sensorSpacingM)
    : [];
  const presetSelect = h('select', {}, SAMPLE_PRESETS.map((p) =>
    h('option', { value: p.id }, `[${MATERIAL_PRESETS[p.material].label}] ${p.label}`),
  )) as HTMLSelectElement;
  if (compatible.length > 0) presetSelect.value = compatible[0].id;
  const desc = h('div', { class: 'muted', style: 'font-size:12.5px;min-height:36px' });
  const refreshDesc = () => {
    const p = SAMPLE_PRESETS.find((x) => x.id === presetSelect.value)!;
    clear(desc);
    desc.append(
      h('div', {}, p.description),
      h('div', { style: 'margin-top:4px' },
        `采样率 ${p.sampleRate} Hz · 时长 ${p.durationSec}s · 漏点真值距 A ${p.trueDistanceFromA}m · ` +
        `漏水 ${p.leakLevel} / 交通 ${p.trafficLevel} / 水泵 ${p.pumpLevel} / 本底 ${p.noiseFloor}`),
    );
  };
  presetSelect.addEventListener('change', refreshDesc);
  refreshDesc();

  const simBtn = h('button', { class: 'btn', disabled: seg ? false : '' }, '生成并保存 60 秒双通道仿真信号') as HTMLButtonElement;
  const simStatus = h('div', { class: 'muted', style: 'margin-top:8px' });
  const waveCanvas = h('canvas', { class: 'plot' }) as HTMLCanvasElement;

  simBtn.addEventListener('click', async () => {
    if (!seg) return;
    const preset = SAMPLE_PRESETS.find((x) => x.id === presetSelect.value)!;
    simBtn.disabled = true;
    simStatus.textContent = '正在合成漏水声源、双路径传播衰减与现场干扰…';
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const c = theoreticalSoundSpeed(seg);
    const synth = synthesizeCapture(preset, c);
    const capture: Capture = {
      id: uid('cap'),
      segmentId: seg.id,
      mode: 'simulated',
      samplePresetId: preset.id,
      startedAt: Date.now(),
      durationSec: preset.durationSec,
      channels: synth.channels as [ChannelBuffer, ChannelBuffer],
    };
    const synthMs = performance.now() - t0;
    await store.saveCapture(capture);
    simStatus.textContent = `合成完成，耗时 ${fmt(synthMs, 0)} ms；已入库（漏点真值距 A ${preset.trueDistanceFromA}m，可在分析页考核定位误差）。`;
    drawWaveform(waveCanvas, synth.channels[0].samples, synth.channels[1].samples, 4);
    simBtn.disabled = false;
    renderCaptureList(listPanel);
  });

  simPanel.append(
    h('div', { class: 'grid-2' }, [
      h('label', { class: 'field' }, ['样本预设', presetSelect]),
    ]),
    desc,
    h('div', { style: 'margin-top:12px' }, [simBtn]),
    simStatus,
    h('div', { style: 'margin-top:12px' }, [waveCanvas]),
    h('div', { class: 'legend' }, [
      h('span', {}, [h('i', { style: 'background:var(--accent)' }), '传感器 A（蓝）']),
      h('span', {}, [h('i', { style: 'background:var(--accent-2)' }), '传感器 B（橙）']),
    ]),
  );

  // ---- 实时麦克风采集 ----
  livePanel.append(h('h2', {}, '实时传感器采集（Web Audio API，双通道声卡）'));
  const durInput = h('input', { type: 'number', value: '60', min: '5', max: '600', step: '1' }) as HTMLInputElement;
  const startLiveBtn = h('button', { class: 'btn secondary' }, '开始实时采集') as HTMLButtonElement;
  const stopLiveBtn = h('button', { class: 'btn danger', disabled: '' }, '停止') as HTMLButtonElement;
  const vuA = h('div', { class: 'vu' }, h('div', { style: 'width:0%' }));
  const vuB = h('div', { class: 'vu' }, h('div', { style: 'width:0%' }));
  const liveStatus = h('div', { class: 'muted' }, '空闲');
  const liveProgress = h('div', { class: 'progress-wrap' }, h('div', { style: 'width:0%' }));

  startLiveBtn.addEventListener('click', async () => {
    if (!seg) return;
    const cfg = store.getState().analysisConfig;
    liveSession = new LiveCaptureSession();
    startLiveBtn.disabled = true;
    stopLiveBtn.disabled = false;
    liveStatus.textContent = '正在请求麦克风权限…';
    try {
      await liveSession.start({
        durationSec: Number(durInput.value),
        bandLowHz: cfg.bandLowHz,
        bandHighHz: cfg.bandHighHz,
        onLevel: (pa, pb, collected) => {
          const target = Number(durInput.value) * liveSession!.sampleRate;
          (vuA.firstChild as HTMLElement).style.width = `${Math.min(100, pa * 140)}%`;
          (vuB.firstChild as HTMLElement).style.width = `${Math.min(100, pb * 140)}%`;
          (liveProgress.firstChild as HTMLElement).style.width = `${Math.min(100, (collected / target) * 100)}%`;
          liveStatus.textContent = `采集中… 已收集 ${(collected / liveSession!.sampleRate).toFixed(1)}s / ${durInput.value}s`;
        },
      });
      liveStatus.textContent = '采集中…';
      const result = await liveSession.waitForCompletion();
      const channels: [ChannelBuffer, ChannelBuffer] = [
        { sampleRate: result.sampleRate, samples: result.channelA },
        { sampleRate: result.sampleRate, samples: result.channelB },
      ];
      const capture: Capture = {
        id: uid('cap'),
        segmentId: seg.id,
        mode: 'live',
        startedAt: Date.now(),
        durationSec: Number(durInput.value),
        channels,
      };
      await store.saveCapture(capture);
      liveStatus.textContent = '实时采集完成并已入库。';
      drawWaveform(waveCanvas, channels[0].samples, channels[1].samples, 4);
      renderCaptureList(listPanel);
    } catch (err) {
      liveStatus.textContent = `采集失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      startLiveBtn.disabled = false;
      stopLiveBtn.disabled = true;
      liveSession?.stop();
      liveSession = null;
    }
  });
  stopLiveBtn.addEventListener('click', () => {
    liveSession?.stop();
    liveSession = null;
    startLiveBtn.disabled = false;
    stopLiveBtn.disabled = true;
    liveStatus.textContent = '已手动停止。';
  });

  livePanel.append(
    h('div', { class: 'grid-3' }, [
      h('label', { class: 'field' }, ['采集时长 (秒)', durInput]),
      h('label', { class: 'field' }, ['通道 A 电平', vuA]),
      h('label', { class: 'field' }, ['通道 B 电平', vuB]),
    ]),
    h('div', { style: 'margin:12px 0' }, [startLiveBtn, stopLiveBtn, liveProgress]),
    liveStatus,
    h('div', { class: 'muted', style: 'margin-top:8px;font-size:12.5px' },
      '监听链路已加与分析页一致的带通滤波；单声道设备会自动把同一路信号复制为 A/B（仅用于流程演示，无法定位）。'),
  );

  renderCaptureList(listPanel);
}

function renderCaptureList(panel: HTMLElement): void {
  const state = store.getState();
  clear(panel);
  panel.append(h('h2', {}, `采集数据（${state.captures.length}）`));
  if (state.captures.length === 0) {
    panel.append(h('div', { class: 'empty' }, '暂无采集数据'));
    return;
  }
  const segMap = new Map(state.segments.map((s) => [s.id, s]));
  const table = h('table', {}, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, '时间'), h('th', {}, '管段'), h('th', {}, '模式'), h('th', {}, '样本/采样率'),
      h('th', {}, '时长'), h('th', {}, '点数/通道'), h('th', {}, '操作'),
    ])),
    h('tbody', {}, state.captures.map((cap) => {
      const seg = segMap.get(cap.segmentId);
      const preset = SAMPLE_PRESETS.find((p) => p.id === cap.samplePresetId);
      const selected = state.currentCaptureId === cap.id;
      return h('tr', { class: `selectable ${selected ? 'selected' : ''}` }, [
        h('td', {}, fmtTime(cap.startedAt)),
        h('td', { class: 'mono' }, seg?.code ?? '（管段已删）'),
        h('td', {}, cap.mode === 'simulated' ? '仿真' : '实时麦克风'),
        h('td', { class: 'mono' }, preset ? preset.id : `${cap.channels[0].sampleRate} Hz`),
        h('td', { class: 'mono' }, `${cap.durationSec}s`),
        h('td', { class: 'mono' }, cap.channels[0].samples.length.toLocaleString()),
        h('td', {}, [
          h('button', {
            class: 'btn secondary',
            style: 'margin-right:6px',
            onclick: () => { store.selectCapture(cap.id); store.setPage('analysis'); },
          }, '去分析'),
          h('button', {
            class: 'btn danger',
            onclick: () => { if (confirm('删除该采集数据？')) void store.deleteCapture(cap.id); },
          }, '删除'),
        ]),
      ]);
    })),
  ]);
  panel.append(table);
  table.querySelectorAll('tbody tr.selectable').forEach((tr, i) => {
    tr.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
      const cap = state.captures[i];
      store.selectCapture(store.getState().currentCaptureId === cap.id ? null : cap.id);
    });
  });
}
