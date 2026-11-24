/**
 * Web Worker 封装层集成测试（Node 环境）：
 * stub 出 worker 全局 self/performance，加载真实 correlation.worker.ts，
 * 验证 消息协议 → buildAnalysisResult → 结果回传 + Transferable 移交 完整链路。
 */
import { pathToFileURL } from 'node:url';
import { SAMPLE_PRESETS } from '../src/dsp/sample-presets.ts';
import { synthesizeCapture } from '../src/dsp/synthesizer.ts';
import { theoreticalSoundSpeed } from '../src/dsp/materials.ts';
import { autoFftSize } from '../src/dsp/correlator.ts';
import type { AnalysisConfig, Capture, PipeSegment } from '../src/types.ts';

const preset = SAMPLE_PRESETS.find((p) => p.id === 'ci-standard-200')!;
const segment: PipeSegment = {
  id: 'seg-w1', code: 'W-001', material: preset.material,
  outerDiameterMm: 300, wallThicknessMm: 12, sensorSpacingM: 200,
  restraint: 'thin_open', location: 'Worker 集成测试', createdAt: 0,
};
const speed = theoreticalSoundSpeed(segment);
const synth = synthesizeCapture(preset, speed);
const fftSize = autoFftSize(preset.spacing, speed, preset.sampleRate);
const config: AnalysisConfig = { bandLowHz: 300, bandHighHz: 2500, weighting: 'phat', fftSize };
const capture: Capture = {
  id: 'cap-w1', segmentId: segment.id, mode: 'simulated', samplePresetId: preset.id,
  startedAt: 0, durationSec: preset.durationSec,
  channels: [synth.channels[0], synth.channels[1]],
};

// 记录移交前的缓冲引用，用于验证 neuter
const bufA = capture.channels[0].samples.buffer;
const bufB = capture.channels[1].samples.buffer;

// ---- stub worker 全局 ----
const posted: unknown[] = [];
const transferred: ArrayBuffer[] = [];
const workerSelf = {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]) {
    posted.push(msg);
    if (transfer) transferred.push(...transfer);
  },
};
(globalThis as Record<string, unknown>).self = workerSelf;
(globalThis as Record<string, unknown>).performance = performance;

const workerUrl = pathToFileURL('src/worker/correlation.worker.ts').href;
await import(workerUrl);
const onMsg = (workerSelf as unknown as { onmessage: (e: { data: unknown }) => void }).onmessage;

onMsg({ data: { type: 'analyze', capture, segment, config } });

// 同步部分会先 post progress，done 在同一同步任务末尾
const types = posted.map((m) => (m as { type: string }).type);
console.log('回传消息类型:', types.join(' → '));
const done = posted.find((m) => (m as { type: string }).type === 'done') as
  | { type: 'done'; result: import('../src/types.ts').AnalysisResult }
  | undefined;

if (!done) {
  console.error('FAIL: 未收到 done 消息');
  process.exit(1);
}
const r = done.result;
console.log('定位 dA =', r.distanceFromA.toFixed(2), 'm（真值 80）');
console.log('可信度 =', r.confidenceLevel, r.confidenceScore.toFixed(2));
console.log('耗时 =', r.elapsedMs.toFixed(1), 'ms');
console.log('回传 Transferable 数量 =', transferred.length, '(应为 5：相关/滞后/2 频谱/频率轴)');
console.log('采集缓冲未二次移交 =', !transferred.some((b) => b === bufA || b === bufB), '(避免对已 neuter 缓冲重复 transfer)');

const ok =
  types.includes('progress') &&
  types.includes('done') &&
  Math.abs(r.distanceFromA - 80) < 2 &&
  r.confidenceLevel === 'high' &&
  transferred.length === 5;
console.log(ok ? '\nWorker 封装层集成测试通过 ✓\n' : '\nWorker 封装层集成测试失败 ✗\n');
process.exit(ok ? 0 : 1);
