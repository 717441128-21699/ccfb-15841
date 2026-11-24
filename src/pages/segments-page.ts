/**
 * 管段录入页：管材/管径/壁厚/约束/传感器间距，实时显示理论声速与典型值校核
 */
import { h, clear, fmt, appendChildren } from '../ui/dom';
import { store } from '../lib/store';
import { MATERIAL_PRESETS, theoreticalSoundSpeed, speedVsTypicalPct } from '../dsp/materials';
import { uid } from '../lib/id';
import type { MaterialId, PipeSegment, RestraintType } from '../types';

const RESTRAINT_LABELS: Record<RestraintType, string> = {
  thin_open: '薄壁自由管（ψ=1-ν²/2）',
  one_end: '一端固定（ψ=1-ν/2）',
  anchored: '全线锚固（ψ=1-ν²）',
};

export function renderSegmentsPage(root: HTMLElement): void {
  const state = store.getState();
  clear(root);

  const form = h('div', { class: 'panel' });
  const list = h('div', { class: 'panel' });
  root.append(form, list);

  // ---- 录入/编辑表单 ----
  form.append(h('h2', {}, '管段档案录入'));
  const codeInput = h('input', { value: '', placeholder: '如 DN300-CI-017' }) as HTMLInputElement;
  const matSelect = h('select', {},
    (Object.keys(MATERIAL_PRESETS) as MaterialId[]).map((id) =>
      h('option', { value: id }, MATERIAL_PRESETS[id].label),
    ),
  ) as HTMLSelectElement;
  const diaInput = h('input', { type: 'number', value: '300', min: '20', step: '1' }) as HTMLInputElement;
  const wallInput = h('input', { type: 'number', value: '12', min: '1', step: '0.1' }) as HTMLInputElement;
  const spacingInput = h('input', { type: 'number', value: '200', min: '5', step: '1' }) as HTMLInputElement;
  const restraintSelect = h('select', {},
    (Object.keys(RESTRAINT_LABELS) as RestraintType[]).map((id) =>
      h('option', { value: id }, RESTRAINT_LABELS[id]),
    ),
  ) as HTMLSelectElement;
  restraintSelect.value = 'thin_open';
  const locInput = h('input', { value: '', placeholder: '如 建国路与人民路交叉口南 80m 路东' }) as HTMLInputElement;
  const speedBox = h('div', { class: 'row' });
  const noteBox = h('div', { class: 'muted', style: 'font-size:12.5px' });

  function refreshSpeed(): void {
    const draft: PipeSegment = {
      id: 'draft', code: codeInput.value || 'draft',
      material: matSelect.value as MaterialId,
      outerDiameterMm: Number(diaInput.value) || 0,
      wallThicknessMm: Number(wallInput.value) || 1,
      sensorSpacingM: Number(spacingInput.value) || 0,
      restraint: restraintSelect.value as RestraintType,
      location: locInput.value, createdAt: 0,
    };
    const c = theoreticalSoundSpeed(draft);
    const dev = speedVsTypicalPct(c, draft.material);
    const preset = MATERIAL_PRESETS[draft.material];
    const tone = dev > 5 ? 'var(--bad)' : 'var(--ok)';
    clear(speedBox);
    speedBox.append(
      h('div', { class: 'metric', style: 'min-width:190px' }, [
        h('div', { class: 'k' }, '理论声速 c（Korteweg 公式）'),
        h('div', { class: 'v', style: `color:${tone}` }, `${fmt(c, 1)} `, h('span', { class: 'u' }, 'm/s')),
      ]),
      h('div', { class: 'metric', style: 'min-width:190px' }, [
        h('div', { class: 'k' }, '与该管材典型工程值偏差'),
        h('div', { class: 'v', style: `color:${tone}` }, `${fmt(dev, 2)} `, h('span', { class: 'u' }, `%（典型 ${preset.typicalSpeedRange[0]}~${preset.typicalSpeedRange[1]} m/s）`)),
      ]),
      h('div', { class: 'metric', style: 'min-width:190px' }, [
        h('div', { class: 'k' }, '声穿越全程时延 L/c'),
        h('div', { class: 'v' }, `${fmt((draft.sensorSpacingM / c) * 1000, 2)} `, h('span', { class: 'u' }, 'ms')),
      ]),
    );
    clear(noteBox);
    appendChildren(noteBox, [
      `E=${(preset.elasticModulus / 1e9).toFixed(1)} GPa，ν=${preset.poissonRatio}，ρ_p=${preset.pipeDensity} kg/m³。`,
      h('br'),
      preset.note,
      dev > 5 ? h('div', { style: `color:${tone};font-weight:700;margin-top:4px` }, '⚠ 偏差超过 5%，请核对管径/壁厚与管材选择') : null,
    ]);
  }
  for (const el of [matSelect, diaInput, wallInput, spacingInput, restraintSelect]) {
    el.addEventListener('input', refreshSpeed);
    el.addEventListener('change', refreshSpeed);
  }

  const saveBtn = h('button', { class: 'btn' }, '保存管段') as HTMLButtonElement;
  saveBtn.addEventListener('click', async () => {
    if (!codeInput.value.trim()) { codeInput.focus(); return; }
    const seg: PipeSegment = {
      id: uid('seg'),
      code: codeInput.value.trim(),
      material: matSelect.value as MaterialId,
      outerDiameterMm: Number(diaInput.value),
      wallThicknessMm: Number(wallInput.value),
      sensorSpacingM: Number(spacingInput.value),
      restraint: restraintSelect.value as RestraintType,
      location: locInput.value.trim(),
      createdAt: Date.now(),
    };
    await store.saveSegment(seg);
    codeInput.value = '';
    locInput.value = '';
    renderSegmentsPage(root);
  });

  form.append(
    h('div', { class: 'grid-3' }, [
      h('label', { class: 'field' }, ['管段编号', codeInput]),
      h('label', { class: 'field' }, ['管材', matSelect]),
      h('label', { class: 'field' }, ['约束方式', restraintSelect]),
      h('label', { class: 'field' }, ['外径 D (mm)', diaInput]),
      h('label', { class: 'field' }, ['壁厚 e (mm)', wallInput]),
      h('label', { class: 'field' }, ['传感器间距 L (m)', spacingInput]),
    ]),
    h('label', { class: 'field', style: 'margin-top:14px' }, ['安装地点', locInput]),
    h('div', { style: 'margin:14px 0 6px' }, [speedBox]),
    noteBox,
    h('div', { style: 'margin-top:14px' }, [saveBtn]),
  );
  refreshSpeed();

  // ---- 已保存管段表 ----
  list.append(h('h2', {}, `已录入管段（${state.segments.length}）`));
  if (state.segments.length === 0) {
    list.append(h('div', { class: 'empty' }, '暂无管段，请先在上方录入'));
    return;
  }
  const table = h('table', {}, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, '编号'), h('th', {}, '管材'), h('th', {}, 'D/e (mm)'),
      h('th', {}, '间距 L (m)'), h('th', {}, '理论声速 (m/s)'),
      h('th', {}, '典型值偏差'), h('th', {}, '地点'), h('th', {}, '操作'),
    ])),
    h('tbody', {}, state.segments.map((seg) => {
      const c = theoreticalSoundSpeed(seg);
      const dev = speedVsTypicalPct(c, seg.material);
      const selected = state.currentSegmentId === seg.id;
      return h('tr', { class: `selectable ${selected ? 'selected' : ''}` }, [
        h('td', { class: 'mono' }, seg.code),
        h('td', {}, MATERIAL_PRESETS[seg.material].label),
        h('td', { class: 'mono' }, `${seg.outerDiameterMm}/${seg.wallThicknessMm}`),
        h('td', { class: 'mono' }, String(seg.sensorSpacingM)),
        h('td', { class: 'mono' }, fmt(c, 1)),
        h('td', { class: 'mono', style: dev > 5 ? 'color:var(--bad);font-weight:700' : 'color:var(--ok)' }, `${fmt(dev, 2)}%`),
        h('td', {}, seg.location || '—'),
        h('td', {}, h('button', {
          class: 'btn danger',
          onclick: () => { if (confirm(`删除管段 ${seg.code}？`)) void store.deleteSegment(seg.id); },
        }, '删除')),
      ]);
    })),
  ]);
  list.append(table);
  list.append(h('div', { class: 'muted', style: 'margin-top:10px;font-size:12.5px' },
    '点击行可选中该管段，选中后在“同步采集”页直接使用。声速公式：c = √[(K/ρ) / (1 + ψ·K·D/(E·e))]，K=2.18 GPa（水），ρ=998 kg/m³。'));

  table.querySelectorAll('tbody tr.selectable').forEach((tr, i) => {
    tr.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
      const seg = state.segments[i];
      store.selectSegment(store.getState().currentSegmentId === seg.id ? null : seg.id);
    });
  });
}
