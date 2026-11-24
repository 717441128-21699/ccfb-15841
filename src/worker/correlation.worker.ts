/**
 * 相关分析 Web Worker
 * 主线程把采集数据（Transferable 零拷贝）与管段、配置发来，
 * Worker 完成滤波+互相关+可信度评估后回传完整结果。
 */
import { buildAnalysisResult } from '../dsp/analysis';
import type { AnalysisConfig, AnalysisResult, Capture, PipeSegment } from '../types';

export interface AnalyzeRequest {
  type: 'analyze';
  capture: Capture;
  segment: PipeSegment;
  config: AnalysisConfig;
}

export type WorkerResponse =
  | { type: 'progress'; message: string }
  | { type: 'done'; result: AnalysisResult }
  | { type: 'error'; message: string };

self.onmessage = (ev: MessageEvent<AnalyzeRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'analyze') return;
  const t0 = performance.now();
  try {
    (self as unknown as Worker).postMessage({ type: 'progress', message: '正在滤波与分段谱估计…' } as WorkerResponse);
    const result = buildAnalysisResult(msg.capture, msg.segment, msg.config, 0);
    result.elapsedMs = performance.now() - t0;
    // 仅移交本次新产生的结果缓冲；采集样本缓冲在接收时已被 neuter，不能再次 transfer
    (self as unknown as Worker).postMessage(
      { type: 'done', result } as WorkerResponse,
      [
        result.correlation.buffer,
        result.lagAxisSec.buffer,
        result.spectrumA.buffer,
        result.spectrumB.buffer,
        result.spectrumFreqAxis.buffer,
      ],
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } as WorkerResponse);
  }
};
