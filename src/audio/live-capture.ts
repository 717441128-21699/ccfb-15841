/**
 * 真实麦克风双通道采集服务
 *
 * 信号链：getUserMedia 双声道 → BiquadFilter 带通（与分析页同频带）
 *        → AnalyserNode（界面波形/电平显示）→ AudioWorklet（落 PCM）
 * 监听输出只接耳机，且默认静音避免啸叫。
 */
// Vite 会把 worklet 处理器作为独立资源打包并给出运行时 URL
import workletUrl from './recorder.worklet.ts?url';

export interface LiveCaptureOptions {
  durationSec: number;
  bandLowHz: number;
  bandHighHz: number;
  onLevel?: (peakA: number, peakB: number, collected: number) => void;
}

export interface LiveCaptureResult {
  channelA: Float32Array;
  channelB: Float32Array;
  sampleRate: number;
}

export class LiveCaptureSession {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private analyserA: AnalyserNode | null = null;
  private analyserB: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private onLevel: LiveCaptureOptions['onLevel'];
  private completionResolver: ((r: LiveCaptureResult) => void) | null = null;
  private completionRejecter: ((e: Error) => void) | null = null;
  private timeoutId = 0;
  /** 实际 AudioContext 采样率（start 后可用） */
  sampleRate = 0;

  async start(opts: LiveCaptureOptions): Promise<void> {
    this.onLevel = opts.onLevel;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.audioWorklet.addModule(workletUrl);
    const source = this.ctx.createMediaStreamSource(this.stream);
    const sr = this.ctx.sampleRate;
    this.sampleRate = sr;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = opts.bandLowHz;
    hp.Q.value = 0.7;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(opts.bandHighHz, sr / 2 - 200);
    lp.Q.value = 0.7;

    this.splitter = this.ctx.createChannelSplitter(2);
    this.analyserA = this.ctx.createAnalyser();
    this.analyserB = this.ctx.createAnalyser();
    this.analyserA.fftSize = 2048;
    this.analyserB.fftSize = 2048;

    source.connect(hp);
    hp.connect(lp);
    lp.connect(this.splitter);
    this.splitter.connect(this.analyserA, 0);
    this.splitter.connect(this.analyserB, 1);

    this.workletNode = new AudioWorkletNode(this.ctx, 'dual-channel-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
    });
    lp.connect(this.workletNode);
    this.workletNode.port.postMessage({
      reset: true,
      targetSamples: Math.round(sr * opts.durationSec),
    });
    // 单一持久消息处理器：电平与完成事件都在这里分发，避免被覆盖
    this.workletNode.port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type: string; peakA?: number; peakB?: number; collected?: number; channelA?: Float32Array; channelB?: Float32Array; sampleRate?: number };
      if (data.type === 'level') {
        this.onLevel?.(data.peakA ?? 0, data.peakB ?? 0, data.collected ?? 0);
      } else if (data.type === 'complete' && this.completionResolver) {
        window.clearTimeout(this.timeoutId);
        const resolver = this.completionResolver;
        this.completionResolver = null;
        this.completionRejecter = null;
        resolver({
          channelA: data.channelA!,
          channelB: data.channelB!,
          sampleRate: data.sampleRate!,
        });
      }
    };
  }

  getAnalysers(): [AnalyserNode, AnalyserNode] | null {
    return this.analyserA && this.analyserB ? [this.analyserA, this.analyserB] : null;
  }

  /** 采集完成的 Promise（Worklet 攒满目标时长后 resolve） */
  waitForCompletion(): Promise<LiveCaptureResult> {
    return new Promise<LiveCaptureResult>((resolve, reject) => {
      if (!this.workletNode) {
        reject(new Error('采集尚未开始'));
        return;
      }
      this.completionResolver = resolve;
      this.completionRejecter = reject;
      this.timeoutId = window.setTimeout(() => reject(new Error('采集超时')), 5 * 60_000);
    });
  }

  stop(): void {
    window.clearTimeout(this.timeoutId);
    if (this.completionRejecter && this.workletNode) {
      // 手动停止时若尚未完成，拒绝等待中的 Promise
      this.completionRejecter(new Error('采集已手动停止'));
    }
    this.completionResolver = null;
    this.completionRejecter = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.workletNode = null;
    this.stream = null;
  }
}
