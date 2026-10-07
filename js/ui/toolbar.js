const ICONS = {
  select: '<path d="M9 4h6M9 20h6M12 4v16"/>',
  pan: '<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 10.5V6a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.7-2.3L3.4 14.8a1.5 1.5 0 0 1 2.3-1.9L8 15"/>',
  text: '<path d="M5 5h14M12 5v14"/>',
  redact: '<path d="M4 20l4-1 10.3-10.3-3-3L5 16l-1 4z"/><path d="M14 6.7l3 3"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M5.5 17l4.5-4.5 3.5 3.5 2.5-2.5 3 3"/>',
  insertPage: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 9v6M9 12h6"/>',
  deletePages: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 12h6"/>',
  extractPages: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6M9.5 13.5L12 11l2.5 2.5"/>',
  rotate: '<path d="M4.5 12a7.5 7.5 0 1 1 2.4 5.5"/><path d="M4.5 17v-4.3h4.3"/>',
  merge: '<path d="M12 3.5l7.5 3.8L12 11l-7.5-3.7L12 3.5z"/><path d="M4.5 12l7.5 3.7 7.5-3.7"/><path d="M4.5 16.3L12 20l7.5-3.7"/>',
  ocr: '<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M20 8.5V6a2 2 0 0 0-2-2h-2.5M4 15.5V18a2 2 0 0 0 2 2h2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5"/><path d="M4 12h16"/>',
};

// Two groups, in order: what you do *to the content*, then what you do *to the
// pages*. Insert / delete / extract live here (not buried in thumbnails) so
// every page-level action is one click away.
const TOOL_GROUPS = [
  [
    { key: 'select', label: 'Select text — highlight and copy (Ctrl+C)', sticky: true },
    { key: 'pan', label: 'Pan — drag to move the page (or hold Space)', sticky: true },
    { key: 'text', label: 'Edit text', sticky: true },
    { key: 'redact', label: 'Redact', sticky: true },
    { key: 'image', label: 'Edit images', sticky: true },
  ],
  [
    { key: 'insertPage', label: 'Insert page' },
    { key: 'deletePages', label: 'Delete page' },
    { key: 'extractPages', label: 'Extract page to its own PDF' },
    { key: 'rotate', label: 'Rotate page' },
    { key: 'merge', label: 'Merge documents' },
    { key: 'ocr', label: 'Run OCR (scanned pages)' },
  ],
];

function icon(key) {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
}

function fileOpIcon(path) {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

let lastSignature = null;
let outsideClickWired = false;

export function renderToolbar(container, state, actions) {
  const signature = JSON.stringify([
    state.activeTool, state.isLoaded, state.fileName, state.selectedPageIndex,
    state.isDirty, state.canUndo, state.canRedo, state.checkedPages.size,
  ]);
  if (signature === lastSignature && container.dataset.rendered === '1') return;
  lastSignature = signature;

  const nSel = state.checkedPages.size;
  // Page-level buttons act on the multi-selection when there is one.
  const labelFor = (t) => {
    if (nSel > 1 && t.key === 'deletePages') return `Delete ${nSel} selected pages`;
    if (nSel > 1 && t.key === 'extractPages') return `Extract ${nSel} selected pages into one PDF`;
    return t.label;
  };

  container.dataset.rendered = '1';
  container.innerHTML = `
    <div class="brand">
      <div class="brand-mark"><span>S</span></div>
      <span class="brand-name">Schurco PDF Editor</span>
    </div>
    <div class="toolbar-divider"></div>

    <div class="tool-pill">
      <button class="tool-btn" data-role="open" aria-label="Open PDF" title="Open a PDF (Ctrl+O)">
        ${fileOpIcon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>')}
      </button>
      <button class="tool-btn" data-role="save" aria-label="Save" title="${state.isDirty ? 'Save (Ctrl+S)' : 'No changes to save'}" ${state.isLoaded && state.isDirty ? '' : 'disabled'}>
        ${fileOpIcon('<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3v5h7V3"/><path d="M7 21v-7h10v7"/>')}
      </button>
      <button class="tool-btn" data-role="close" aria-label="Close document" title="Close document" ${state.isLoaded ? '' : 'disabled'}>
        ${fileOpIcon('<path d="M6 6l12 12M18 6L6 18"/>')}
      </button>
    </div>

    <div class="tool-pill">
      <button class="tool-btn" data-role="undo" aria-label="Undo" title="Undo (Ctrl+Z)" ${state.canUndo ? '' : 'disabled'}>
        ${fileOpIcon('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>')}
      </button>
      <button class="tool-btn" data-role="redo" aria-label="Redo" title="Redo (Ctrl+Y)" ${state.canRedo ? '' : 'disabled'}>
        ${fileOpIcon('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>')}
      </button>
    </div>

    <span class="doc-name">${state.fileName || 'No document open'}${state.isDirty ? ' •' : ''}</span>
    <div class="toolbar-spacer"></div>
    ${TOOL_GROUPS.map((group) => `
      <div class="tool-pill">
        ${group.map((t) => `
          <button
            class="tool-btn ${t.sticky && state.activeTool === t.key ? 'active' : ''}"
            aria-label="${labelFor(t)}"
            title="${labelFor(t)}"
            data-tool="${t.key}"
            ${!state.isLoaded ? 'disabled' : ''}
          >${icon(t.key)}</button>
        `).join('')}
      </div>
    `).join('')}
    <div class="toolbar-spacer"></div>
    <div class="privacy-badge" title="Local only — nothing uploaded">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>
      <span>Local only — nothing uploaded</span>
    </div>
    <div class="export-menu-wrap" style="position:relative;">
      <button class="export-btn" data-role="export-toggle" ${state.isLoaded ? '' : 'disabled'} aria-label="Export document" aria-haspopup="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>
        <span>Export</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="export-menu" data-role="export-menu" style="display:none;position:absolute;top:52px;right:0;background:var(--surface);border-radius:8px;box-shadow:0 12px 28px rgba(20,22,20,0.22);min-width:200px;overflow:hidden;z-index:30;padding:6px;">
        <button class="export-menu-item" data-role="export-pdf">Export as PDF</button>
        <button class="export-menu-item" data-role="export-word">Export as Word (.docx)</button>
        <button class="export-menu-item" data-role="export-excel">Export as Excel (.xlsx)</button>
      </div>
    </div>
    <div class="avatar"><span>${(window.SCHURCO_USER_INITIALS || 'GV')}</span></div>
  `;

  container.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => actions.onToolClick(btn.dataset.tool));
  });
  container.querySelector('[data-role="open"]').addEventListener('click', () => actions.onOpenFileClick());
  container.querySelector('[data-role="save"]').addEventListener('click', () => actions.onSave());
  container.querySelector('[data-role="close"]').addEventListener('click', () => actions.onCloseDocument());
  container.querySelector('[data-role="undo"]').addEventListener('click', () => actions.onUndo());
  container.querySelector('[data-role="redo"]').addEventListener('click', () => actions.onRedo());

  const menu = container.querySelector('[data-role="export-menu"]');
  const toggle = container.querySelector('[data-role="export-toggle"]');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });
  if (!outsideClickWired) {
    outsideClickWired = true;
    document.addEventListener('click', () => {
      const openMenu = document.querySelector('[data-role="export-menu"]');
      if (openMenu) openMenu.style.display = 'none';
    });
  }
  container.querySelector('[data-role="export-pdf"]').addEventListener('click', () => { menu.style.display = 'none'; actions.onExport(); });
  container.querySelector('[data-role="export-word"]').addEventListener('click', () => { menu.style.display = 'none'; actions.onExportWord(); });
  container.querySelector('[data-role="export-excel"]').addEventListener('click', () => { menu.style.display = 'none'; actions.onExportExcel(); });
}
