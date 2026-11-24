/**
 * 应用外壳：顶部页签 + 页面路由（hash）
 */
import { h, clear } from './ui/dom';
import { store, type PageId } from './lib/store';
import { renderSegmentsPage } from './pages/segments-page';
import { renderCapturePage } from './pages/capture-page';
import { renderAnalysisPage } from './pages/analysis-page';
import { renderRecordsPage } from './pages/records-page';

const TABS: { id: PageId; label: string }[] = [
  { id: 'segments', label: '管段录入' },
  { id: 'capture', label: '同步采集' },
  { id: 'analysis', label: '相关分析' },
  { id: 'records', label: '检漏记录' },
];

const RENDERERS: Record<PageId, (root: HTMLElement) => void> = {
  segments: renderSegmentsPage,
  capture: renderCapturePage,
  analysis: renderAnalysisPage,
  records: renderRecordsPage,
};

function pageFromHash(): PageId {
  const p = location.hash.replace('#', '') as PageId;
  return (TABS.some((t) => t.id === p) ? p : 'segments');
}

export function mountApp(root: HTMLElement): void {
  const header = h('div', { class: 'app-header' }, [
    h('div', {}, [
      h('h1', { class: 'app-title' }, '供水管道检漏相关仪'),
      h('div', { class: 'app-subtitle' }, '双传感器互相关漏点定位 · GCC 加权 · 零相位带通 · Web Worker 离线计算'),
    ]),
    h('nav', { class: 'tabs' }, TABS.map((t) =>
      h('div', { class: 'tab', 'data-page': t.id, onclick: () => store.setPage(t.id) }, t.label),
    )),
  ]);
  const pageRoot = h('div', {});
  root.append(header, pageRoot);

  const render = () => {
    const state = store.getState();
    header.querySelectorAll('.tab').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.page === state.page);
    });
    clear(pageRoot);
    RENDERERS[state.page](pageRoot);
    window.scrollTo({ top: 0 });
  };

  store.subscribe(render);
  window.addEventListener('hashchange', () => {
    store.getState().page = pageFromHash();
    render();
  });
  if (!location.hash) location.hash = 'segments';
  store.getState().page = pageFromHash();
}
