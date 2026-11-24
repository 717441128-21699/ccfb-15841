/**
 * 极简响应式 store（发布订阅，无第三方依赖）
 */
import type {
  AnalysisConfig,
  AnalysisResult,
  Capture,
  LeakRecord,
  PipeSegment,
} from '../types';
import { dbGetAll, dbPut, dbDelete } from './storage';

export type PageId = 'segments' | 'capture' | 'analysis' | 'records';

export interface AppState {
  page: PageId;
  segments: PipeSegment[];
  captures: Capture[];
  results: AnalysisResult[];
  records: LeakRecord[];
  currentSegmentId: string | null;
  currentCaptureId: string | null;
  currentResultId: string | null;
  analysisConfig: AnalysisConfig;
  busy: boolean;
}

type Listener = (s: AppState) => void;

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  bandLowHz: 300,
  bandHighHz: 2500,
  weighting: 'phat',
  fftSize: 8192,
};

class AppStore {
  private state: AppState = {
    page: 'segments',
    segments: [],
    captures: [],
    results: [],
    records: [],
    currentSegmentId: null,
    currentCaptureId: null,
    currentResultId: null,
    analysisConfig: { ...DEFAULT_ANALYSIS_CONFIG },
    busy: false,
  };
  private listeners = new Set<Listener>();

  getState(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.state = { ...this.state };
    for (const fn of this.listeners) fn(this.state);
  }

  setPage(page: PageId): void {
    location.hash = page;
    this.state.page = page;
    this.emit();
  }

  setBusy(busy: boolean): void {
    this.state.busy = busy;
    this.emit();
  }

  patchConfig(patch: Partial<AnalysisConfig>): void {
    this.state.analysisConfig = { ...this.state.analysisConfig, ...patch };
    this.emit();
  }

  selectSegment(id: string | null): void {
    this.state.currentSegmentId = id;
    this.emit();
  }

  selectCapture(id: string | null): void {
    this.state.currentCaptureId = id;
    this.emit();
  }

  selectResult(id: string | null): void {
    this.state.currentResultId = id;
    this.emit();
  }

  // ---- 管段 ----
  async saveSegment(seg: PipeSegment): Promise<void> {
    await dbPut('segments', seg);
    await this.reload();
    this.state.currentSegmentId = seg.id;
    this.emit();
  }

  async deleteSegment(id: string): Promise<void> {
    await dbDelete('segments', id);
    if (this.state.currentSegmentId === id) this.state.currentSegmentId = null;
    await this.reload();
    this.emit();
  }

  // ---- 采集 ----
  async saveCapture(cap: Capture): Promise<void> {
    await dbPut('captures', cap);
    await this.reload();
    this.state.currentCaptureId = cap.id;
    this.emit();
  }

  async deleteCapture(id: string): Promise<void> {
    await dbDelete('captures', id);
    if (this.state.currentCaptureId === id) this.state.currentCaptureId = null;
    await this.reload();
    this.emit();
  }

  // ---- 结果 ----
  async saveResult(res: AnalysisResult): Promise<void> {
    await dbPut('results', res);
    await this.reload();
    this.state.currentResultId = res.id;
    this.emit();
  }

  // ---- 检漏记录 ----
  async saveRecord(rec: LeakRecord): Promise<void> {
    await dbPut('records', rec);
    await this.reload();
    this.emit();
  }

  async updateRecordStatus(id: string, status: LeakRecord['status'], note?: string): Promise<void> {
    const rec = this.state.records.find((r) => r.id === id);
    if (!rec) return;
    rec.status = status;
    if (note !== undefined) rec.note = note;
    await dbPut('records', rec);
    await this.reload();
    this.emit();
  }

  async deleteRecord(id: string): Promise<void> {
    await dbDelete('records', id);
    await this.reload();
    this.emit();
  }

  async reload(): Promise<void> {
    const [segments, captures, results, records] = await Promise.all([
      dbGetAll<PipeSegment>('segments'),
      dbGetAll<Capture>('captures'),
      dbGetAll<AnalysisResult>('results'),
      dbGetAll<LeakRecord>('records'),
    ]);
    segments.sort((a, b) => b.createdAt - a.createdAt);
    captures.sort((a, b) => b.startedAt - a.startedAt);
    records.sort((a, b) => b.createdAt - a.createdAt);
    this.state.segments = segments;
    this.state.captures = captures;
    this.state.results = results;
    this.state.records = records;
  }
}

export const store = new AppStore();
