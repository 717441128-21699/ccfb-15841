/**
 * AudioWorklet 处理器全局声明（这些名字只在 WebWorker lib 中，
 * 为避免与 DOM lib 的全套 worker 全局冲突，这里仅声明 worklet 所需符号）。
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void;

/** Worklet 全局只读采样率 */
declare const sampleRate: number;
