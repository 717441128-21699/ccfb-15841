/**
 * 检漏记录页：归档列表、处置状态流转、导出 CSV
 */
import { h, clear, fmt, fmtTime } from '../ui/dom';
import { store } from '../lib/store';
import { MATERIAL_PRESETS } from '../dsp/materials';
import type { LeakRecord } from '../types';

const STATUS_FLOW: { value: LeakRecord['status']; label: string }[] = [
  { value: 'pending', label: '待开挖' },
  { value: 'excavated', label: '已开挖' },
  { value: 'confirmed_leak', label: '确认漏点' },
  { value: 'false_alarm', label: '误判回填' },
  { value: 'backfilled', label: '已回填修复' },
];

const LEVEL_TEXT = { high: '高', medium: '中', low: '低' } as const;

export function renderRecordsPage(root: HTMLElement): void {
  const state = store.getState();
  clear(root);

  const panel = h('div', { class: 'panel' });
  root.append(panel);
  panel.append(
    h('div', { class: 'row' }, [
      h('h2', { style: 'margin:0' }, `检漏记录（${state.records.length}）`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn secondary', onclick: exportCsv }, '导出 CSV'),
    ]),
  );

  if (state.records.length === 0) {
    panel.append(h('div', { class: 'empty' }, '暂无记录。在「相关分析」页完成分析后可归档生成。'));
    return;
  }

  const table = h('table', {}, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, '归档时间'), h('th', {}, '管段'), h('th', {}, '管材'), h('th', {}, '地点'),
      h('th', {}, '距 A (m)'), h('th', {}, '距 B (m)'), h('th', {}, '声速 (m/s)'),
      h('th', {}, '时延 (ms)'), h('th', {}, '可信度'), h('th', {}, '状态'),
      h('th', {}, '备注'), h('th', {}, '操作'),
    ])),
    h('tbody', {}, state.records.map((rec) => {
      const statusSelect = h('select', {}, STATUS_FLOW.map((s) =>
        h('option', { value: s.value, selected: rec.status === s.value ? 'selected' : false }, s.label),
      )) as HTMLSelectElement;
      statusSelect.addEventListener('change', () => {
        void store.updateRecordStatus(rec.id, statusSelect.value as LeakRecord['status']);
      });
      return h('tr', {}, [
        h('td', {}, fmtTime(rec.createdAt)),
        h('td', { class: 'mono' }, rec.segmentCode),
        h('td', {}, MATERIAL_PRESETS[rec.material].label),
        h('td', {}, rec.location || '—'),
        h('td', { class: 'mono', style: 'font-weight:700' }, fmt(rec.distanceFromA, 2)),
        h('td', { class: 'mono' }, fmt(rec.distanceFromB, 2)),
        h('td', { class: 'mono' }, fmt(rec.soundSpeed, 0)),
        h('td', { class: 'mono' }, fmt(rec.delaySec * 1000, 3)),
        h('td', {}, h('span', { class: `badge ${rec.confidenceLevel}` }, LEVEL_TEXT[rec.confidenceLevel])),
        h('td', {}, statusSelect),
        h('td', { style: 'max-width:180px' }, rec.note || '—'),
        h('td', {}, h('button', {
          class: 'btn danger',
          onclick: () => { if (confirm('删除该检漏记录？')) void store.deleteRecord(rec.id); },
        }, '删除')),
      ]);
    })),
  ]);
  panel.append(table);

  // 统计
  const confirmed = state.records.filter((r) => r.status === 'confirmed_leak').length;
  const falseAlarm = state.records.filter((r) => r.status === 'false_alarm').length;
  const low = state.records.filter((r) => r.confidenceLevel === 'low').length;
  panel.append(h('div', { class: 'muted', style: 'margin-top:12px;font-size:12.5px' },
    `统计：确认漏点 ${confirmed} 处 · 误判 ${falseAlarm} 处 · 低可信度记录 ${low} 条（低可信度结果应先复测再安排开挖，减少无效回填）。`));
}

function exportCsv(): void {
  const rows = store.getState().records;
  if (rows.length === 0) return;
  const header = ['id', 'createdAt', 'segmentCode', 'material', 'location', 'distanceFromA', 'distanceFromB', 'soundSpeed', 'delaySec', 'confidenceLevel', 'confidenceScore', 'status', 'note'];
  const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id, new Date(r.createdAt).toISOString(), r.segmentCode, r.material, r.location,
      r.distanceFromA.toFixed(3), r.distanceFromB.toFixed(3), r.soundSpeed.toFixed(2),
      r.delaySec.toFixed(6), r.confidenceLevel, r.confidenceScore.toFixed(3), r.status, r.note,
    ].map(esc).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `检漏记录_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
