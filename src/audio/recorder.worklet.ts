/**
 * AudioWorklet 处理器：把双声道（或单声道复制为双路）原始 PCM 累积后回传。
 * 实际硬件通常为两路独立传感器接入双通道声卡；单麦克风设备自动复制为 A/B。
 */
class DualChannelRecorder extends AudioWorkletProcessor {
  private buffers: Float32Array[] = [];
  private total = 0;
  private targetSamples: number;

  constructor() {
    super();
    this.targetSamples = Math.round(sampleRate * 60); // 默认最多缓存 60s，由 port 消息覆盖
    this.port.onmessage = (ev: MessageEvent<{ targetSamples?: number; reset?: boolean }>) => {
      if (ev.data.reset) {
        this.buffers = [];
        this.total = 0;
      }
      if (ev.data.targetSamples) {
        this.targetSamples = ev.data.targetSamples;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const chA = input[0];
    const chB = input[1] ?? input[0];
    if (!chA) return true;
    this.buffers.push(new Float32Array(chA));
    this.buffers.push(new Float32Array(chB));
    this.total += chA.length;
    // 每约 0.5 秒上报一次电平，供界面 VU 表显示
    if (this.total % Math.round(sampleRate * 0.5) < 256) {
      let peakA = 0;
      let peakB = 0;
      for (let i = 0; i < chA.length; i += 16) {
        peakA = Math.max(peakA, Math.abs(chA[i]));
        peakB = Math.max(peakB, Math.abs(chB[i]));
      }
      this.port.postMessage({ type: 'level', peakA, peakB, collected: this.total });
    }
    if (this.total >= this.targetSamples) {
      const mergedA: number[] = [];
      const mergedB: number[] = [];
      for (let i = 0; i < this.buffers.length; i += 2) {
        for (const v of this.buffers[i]) mergedA.push(v);
        for (const v of this.buffers[i + 1]) mergedB.push(v);
      }
      this.port.postMessage(
        {
          type: 'complete',
          channelA: new Float32Array(mergedA.slice(0, this.targetSamples)),
          channelB: new Float32Array(mergedB.slice(0, this.targetSamples)),
          sampleRate,
        },
        [],
      );
      this.buffers = [];
      this.total = 0;
    }
    return true;
  }
}

registerProcessor('dual-channel-recorder', DualChannelRecorder);
