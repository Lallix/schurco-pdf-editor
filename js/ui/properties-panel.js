import { PAGE_SIZES } from '../pdf-engine.js';

let lastSignature = null;

export function renderPropertiesPanel(container, state, actions) {
  const signature = JSON.stringify([state.isLoaded, state.selectedPageIndex, state.docRevision]);
  if (signature === lastSignature && container.dataset.rendered === '1') return;
  lastSignature = signature;
  container.dataset.rendered = '1';

  if (!state.isLoaded || state.selectedPageIndex === null) {
    container.innerHTML = `
      <span class="panel-section-title">Page properties</span>
      <span class="panel-empty">Open a PDF and select a page to see its properties.</span>
    `;
    return;
  }

  const idx = state.selectedPageIndex;
  const info = state.pages[idx];
  if (!info) return;

  const sizeKeys = Object.keys(PAGE_SIZES);
  const matchedKey = sizeKeys.find((k) => info.sizeLabel.startsWith(k)) || '';

  container.innerHTML = `
    <span class="panel-section-title">Page properties</span>

    <div class="field">
      <span class="field-label">Page ${idx + 1} size</span>
      <select class="field-select" data-role="size" style="border:1px solid var(--line);appearance:none;">
        <option value="" ${matchedKey ? '' : 'selected'} disabled>${info.sizeLabel}</option>
        <option value="A4" ${matchedKey === 'A4' ? 'selected' : ''}>A4 (210 × 297 mm)</option>
        <option value="Letter" ${matchedKey === 'Letter' ? 'selected' : ''}>Letter (216 × 279 mm)</option>
      </select>
    </div>

    <div class="field">
      <span class="field-label">Rotation — ${info.rotation}°</span>
      <div class="rotate-row">
        <button class="rotate-btn" data-role="rotate-left" aria-label="Rotate left 90 degrees">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-1"/></svg>
        </button>
        <button class="rotate-btn" data-role="rotate-right" aria-label="Rotate right 90 degrees">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h1"/></svg>
        </button>
      </div>
    </div>

    <button class="delete-page-btn" data-role="delete">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 13h8l1-13"/></svg>
      <span>Delete this page</span>
    </button>

    <div class="section-divider"></div>

    <span class="panel-section-title">Text properties</span>
    <span class="panel-empty">Available once text editing ships in a later phase.</span>

    <div class="section-divider"></div>

    ${info.likelyScanned ? `
      <div class="ocr-card">
        <div class="ocr-card-header">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M20 8.5V6a2 2 0 0 0-2-2h-2.5M4 15.5V18a2 2 0 0 0 2 2h2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5"/><path d="M4 12h16"/></svg>
          <span>Page ${idx + 1} appears scanned</span>
        </div>
        <p>Run OCR to make its text searchable, selectable and editable.</p>
        <button class="ocr-run-btn" disabled title="Coming in a later phase">Run OCR</button>
      </div>
    ` : ''}
  `;

  container.querySelector('[data-role="size"]').addEventListener('change', (e) => {
    if (e.target.value) actions.onSetPageSize(idx, e.target.value);
  });
  container.querySelector('[data-role="rotate-left"]').addEventListener('click', () => actions.onRotatePage(idx, -90));
  container.querySelector('[data-role="rotate-right"]').addEventListener('click', () => actions.onRotatePage(idx, 90));
  container.querySelector('[data-role="delete"]').addEventListener('click', () => actions.onDeletePage(idx));
}
