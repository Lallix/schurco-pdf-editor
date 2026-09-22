import { PAGE_SIZES, FONT_VARIANTS } from '../pdf-engine.js';

let lastSignature = null;

export function renderPropertiesPanel(container, state, actions) {
  const signature = JSON.stringify([
    state.isLoaded, state.selectedPageIndex, state.docRevision, state.activeTool,
    state.textEdit, state.redactColor, state.selectedImage,
  ]);
  if (signature === lastSignature && container.dataset.rendered === '1') return;
  lastSignature = signature;
  container.dataset.rendered = '1';

  if (!state.isLoaded) {
    container.innerHTML = `
      <span class="panel-section-title">Page properties</span>
      <span class="panel-empty">Open a PDF and select a page to see its properties.</span>
    `;
    return;
  }

  if (state.activeTool === 'text') return renderTextPanel(container, state, actions);
  if (state.activeTool === 'redact') return renderRedactPanel(container, state, actions);
  if (state.activeTool === 'image') return renderImagePanel(container, state, actions);
  return renderPagePanel(container, state, actions);
}

function renderTextPanel(container, state, actions) {
  const te = state.textEdit;
  if (!te) {
    container.innerHTML = `
      <span class="panel-section-title">Text properties</span>
      <span class="panel-empty">Click text on the page to edit it. The original text is removed from the file, not just covered, once you export.</span>
    `;
    return;
  }

  const families = Object.keys(FONT_VARIANTS);

  container.innerHTML = `
    <span class="panel-section-title">Text properties</span>

    <div class="field">
      <span class="field-label">Font</span>
      <select class="field-select" data-role="font" style="border:1px solid var(--line);appearance:none;">
        ${families.map((f) => `<option value="${f}" ${te.fontFamily === f ? 'selected' : ''}>${f}</option>`).join('')}
      </select>
    </div>

    <div class="field-row">
      <div class="field">
        <span class="field-label">Size</span>
        <input type="number" min="6" max="96" class="field-box" data-role="size" value="${te.fontSize}" style="border:1px solid var(--line);" />
      </div>
      <div class="field">
        <span class="field-label">Colour</span>
        <input type="color" data-role="color" value="${te.color}" class="swatch" style="padding:0;cursor:pointer;" />
      </div>
    </div>

    <div class="style-row">
      <button class="style-btn ${te.bold ? 'active' : ''}" data-role="bold" aria-label="Bold" aria-pressed="${te.bold}"><span>B</span></button>
      <button class="style-btn ${te.italic ? 'active' : ''}" data-role="italic" aria-label="Italic" aria-pressed="${te.italic}"><span style="font-style:italic;">I</span></button>
      <button class="style-btn ${te.underline ? 'active' : ''}" data-role="underline" aria-label="Underline" aria-pressed="${te.underline}"><span style="text-decoration:underline;">U</span></button>
    </div>

    <span class="field-hint">Editing “${te.text.length > 40 ? te.text.slice(0, 40) + '…' : te.text}” on page ${te.pageIndex + 1}. Press Enter to apply, Esc to cancel.</span>
  `;

  container.querySelector('[data-role="font"]').addEventListener('change', (e) => actions.onTextStyleChange({ fontFamily: e.target.value }));
  container.querySelector('[data-role="size"]').addEventListener('change', (e) => actions.onTextStyleChange({ fontSize: Math.max(6, Math.min(96, Number(e.target.value) || te.fontSize)) }));
  container.querySelector('[data-role="color"]').addEventListener('input', (e) => actions.onTextStyleChange({ color: e.target.value }));
  container.querySelector('[data-role="bold"]').addEventListener('click', () => actions.onTextStyleChange({ bold: !te.bold }));
  container.querySelector('[data-role="italic"]').addEventListener('click', () => actions.onTextStyleChange({ italic: !te.italic }));
  container.querySelector('[data-role="underline"]').addEventListener('click', () => actions.onTextStyleChange({ underline: !te.underline }));
}

function renderRedactPanel(container, state, actions) {
  container.innerHTML = `
    <span class="panel-section-title">Redaction</span>
    <span class="panel-empty">Drag a box over anything on the page you want gone. It's permanently removed from the file — not just covered — once you export, so this can't be undone by re-opening the PDF elsewhere.</span>

    <div class="field">
      <span class="field-label">Redaction colour</span>
      <input type="color" data-role="color" value="${state.redactColor}" class="swatch" style="padding:0;cursor:pointer;" />
    </div>
  `;
  container.querySelector('[data-role="color"]').addEventListener('input', (e) => actions.onRedactColorChange(e.target.value));
}

function renderImagePanel(container, state, actions) {
  container.innerHTML = `
    <span class="panel-section-title">Image</span>
    <span class="panel-empty">${state.selectedImage ? 'Use the icons on the image to replace, crop, or delete it.' : 'Click an image on the page to replace, crop, or delete it.'}</span>
    <span class="field-hint">Replacing, cropping, or deleting also removes the original image data from the file on export.</span>
  `;
}

function renderPagePanel(container, state, actions) {
  const idx = state.selectedPageIndex;
  const info = state.pages[idx];
  if (!info) {
    container.innerHTML = `
      <span class="panel-section-title">Page properties</span>
      <span class="panel-empty">Open a PDF and select a page to see its properties.</span>
    `;
    return;
  }

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
    <span class="panel-empty">Select the Edit Text tool, then click text on the page.</span>

    <div class="section-divider"></div>

    ${info.likelyScanned ? `
      <div class="ocr-card">
        <div class="ocr-card-header">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M20 8.5V6a2 2 0 0 0-2-2h-2.5M4 15.5V18a2 2 0 0 0 2 2h2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5"/><path d="M4 12h16"/></svg>
          <span>Page ${idx + 1} appears scanned</span>
        </div>
        <p>Run OCR to make its text searchable, selectable and copyable.</p>
        <button class="ocr-run-btn" data-role="run-ocr">Run OCR</button>
      </div>
    ` : ''}
  `;

  container.querySelector('[data-role="size"]').addEventListener('change', (e) => {
    if (e.target.value) actions.onSetPageSize(idx, e.target.value);
  });
  container.querySelector('[data-role="rotate-left"]').addEventListener('click', () => actions.onRotatePage(idx, -90));
  container.querySelector('[data-role="rotate-right"]').addEventListener('click', () => actions.onRotatePage(idx, 90));
  container.querySelector('[data-role="delete"]').addEventListener('click', () => actions.onDeletePage(idx));
  container.querySelector('[data-role="run-ocr"]')?.addEventListener('click', () => actions.onRunOcr(idx));
}
