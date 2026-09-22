import { engine } from '../pdf-engine.js';

const BASE_WIDTH_AT_100 = 600;

let lastSignature = null;

export async function renderCanvas(container, state, actions) {
  const signature = JSON.stringify([state.isLoaded, state.selectedPageIndex, state.zoom, state.docRevision]);
  if (signature === lastSignature && container.dataset.rendered === '1') return;
  lastSignature = signature;
  container.dataset.rendered = '1';

  if (!state.isLoaded) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/></svg>
        <h2>Open a PDF to get started</h2>
        <p>Drag and drop a file here, or choose one from your computer. Nothing is uploaded — everything happens in this browser.</p>
        <button class="open-file-btn" data-role="open-file">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>
          <span>Open PDF</span>
        </button>
      </div>
    `;
    container.querySelector('[data-role="open-file"]').addEventListener('click', () => actions.onOpenFileClick());
    return;
  }

  const idx = state.selectedPageIndex ?? 0;
  const targetWidth = BASE_WIDTH_AT_100 * state.zoom;

  container.innerHTML = `
    <div class="page-sheet-wrap">
      <canvas class="page-sheet"></canvas>
    </div>
    <div class="nav-pill">
      <button class="nav-pill-btn" data-role="prev" aria-label="Previous page" ${idx <= 0 ? 'disabled' : ''}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <span class="nav-pill-label">Page ${idx + 1} of ${state.pageCount}</span>
      <button class="nav-pill-btn" data-role="next" aria-label="Next page" ${idx >= state.pageCount - 1 ? 'disabled' : ''}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <div class="nav-pill-divider"></div>
      <button class="nav-pill-btn" data-role="zoom-out" aria-label="Zoom out">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>
      </button>
      <span class="nav-pill-label">${Math.round(state.zoom * 100)}%</span>
      <button class="nav-pill-btn" data-role="zoom-in" aria-label="Zoom in">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  `;

  const canvas = container.querySelector('.page-sheet');
  engine.renderPageToCanvas(idx, canvas, targetWidth).catch(() => {});

  container.querySelector('[data-role="prev"]').addEventListener('click', () => actions.onSelectPage(idx - 1));
  container.querySelector('[data-role="next"]').addEventListener('click', () => actions.onSelectPage(idx + 1));
  container.querySelector('[data-role="zoom-out"]').addEventListener('click', () => actions.onZoom(-0.1));
  container.querySelector('[data-role="zoom-in"]').addEventListener('click', () => actions.onZoom(0.1));
}
