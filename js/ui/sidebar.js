import { engine } from '../pdf-engine.js';

let lastRevision = -1;
let dragFromIndex = null;

function iconSvg(path) {
  return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

export async function renderSidebar(container, state, actions) {
  const needsFullRender = state.docRevision !== lastRevision || container.dataset.rendered !== '1';

  const countLabel = () => (state.checkedPages.size > 1 ? `${state.checkedPages.size} selected` : String(state.pageCount));

  if (!needsFullRender) {
    container.querySelectorAll('.thumb').forEach((el) => {
      const idx = Number(el.dataset.index);
      el.classList.toggle('selected', idx === state.selectedPageIndex);
      el.classList.toggle('checked', state.checkedPages.has(idx));
    });
    const countEl = container.querySelector('.sidebar-count');
    if (countEl) countEl.textContent = countLabel();
    return;
  }

  lastRevision = state.docRevision;
  container.dataset.rendered = '1';

  container.innerHTML = `
    <div class="sidebar-header">
      <span class="sidebar-title">Pages</span>
      <span class="sidebar-count">${countLabel()}</span>
    </div>
    <div class="thumb-list"></div>
    <button class="insert-page-btn" data-role="insert-page" ${state.isLoaded ? '' : 'disabled'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      <span>Insert page</span>
    </button>
  `;

  const listEl = container.querySelector('.thumb-list');
  container.querySelector('[data-role="insert-page"]').addEventListener('click', () => actions.onInsertPageClick());

  if (!state.isLoaded) return;

  for (let i = 0; i < state.pageCount; i++) {
    const btn = document.createElement('button');
    btn.className = `thumb ${i === state.selectedPageIndex ? 'selected' : ''} ${state.checkedPages.has(i) ? 'checked' : ''}`;
    btn.dataset.index = String(i);
    btn.draggable = true;
    btn.title = 'Click to open · Ctrl+click to add to a selection · Shift+click to select a range';
    btn.innerHTML = `
      <div class="thumb-canvas-wrap"><canvas></canvas></div>
      <div class="thumb-footer">
        <span class="thumb-label">Page ${i + 1}</span>
      </div>
      <span class="thumb-check" aria-hidden="true">${iconSvg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')}</span>
      <div class="thumb-actions">
        <button class="thumb-action-btn" data-action="rotate" aria-label="Rotate page ${i + 1}" title="Rotate page ${i + 1}">${iconSvg('<path d="M4.5 12a7.5 7.5 0 1 1 2.4 5.5"/><path d="M4.5 17v-4.3h4.3"/>')}</button>
        <button class="thumb-action-btn" data-action="export" aria-label="Export page ${i + 1} as its own PDF" title="Extract page ${i + 1} to its own PDF">${iconSvg('<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/>')}</button>
        <button class="thumb-action-btn danger" data-action="delete" aria-label="Delete page ${i + 1}" title="Delete page ${i + 1}">${iconSvg('<path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 13h8l1-13"/>')}</button>
      </div>
    `;
    listEl.appendChild(btn);

    engine.renderPageToCanvas(i, btn.querySelector('canvas'), 160).catch(() => {});

    btn.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      actions.onPageClick(i, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    });

    btn.querySelector('[data-action="rotate"]').addEventListener('click', (e) => {
      e.stopPropagation();
      actions.onRotatePage(i, 90);
    });
    btn.querySelector('[data-action="export"]').addEventListener('click', (e) => {
      e.stopPropagation();
      actions.onExportPage(i);
    });
    btn.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      actions.onDeletePage(i);
    });

    btn.addEventListener('dragstart', (e) => {
      dragFromIndex = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    btn.addEventListener('dragend', () => {
      dragFromIndex = null;
      listEl.querySelectorAll('.thumb').forEach((el) => el.classList.remove('drag-over-top', 'drag-over-bottom'));
    });
    btn.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragFromIndex === null || dragFromIndex === i) return;
      const rect = btn.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      btn.classList.toggle('drag-over-top', before);
      btn.classList.toggle('drag-over-bottom', !before);
    });
    btn.addEventListener('dragleave', () => {
      btn.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      btn.classList.remove('drag-over-top', 'drag-over-bottom');
      if (dragFromIndex === null || dragFromIndex === i) return;
      const rect = btn.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      let targetIndex = before ? i : i + 1;
      actions.onReorderPage(dragFromIndex, targetIndex);
    });
  }
}
