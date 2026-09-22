const ICONS = {
  select: '<path d="M5 3l14 8-6 1.6-2 6.4-6-16z"/>',
  text: '<path d="M5 5h14M12 5v14"/>',
  redact: '<path d="M4 20l4-1 10.3-10.3-3-3L5 16l-1 4z"/><path d="M14 6.7l3 3"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M5.5 17l4.5-4.5 3.5 3.5 2.5-2.5 3 3"/>',
  insertPage: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 9v6M9 12h6"/>',
  rotate: '<path d="M4.5 12a7.5 7.5 0 1 1 2.4 5.5"/><path d="M4.5 17v-4.3h4.3"/>',
  merge: '<path d="M12 3.5l7.5 3.8L12 11l-7.5-3.7L12 3.5z"/><path d="M4.5 12l7.5 3.7 7.5-3.7"/><path d="M4.5 16.3L12 20l7.5-3.7"/>',
  ocr: '<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M20 8.5V6a2 2 0 0 0-2-2h-2.5M4 15.5V18a2 2 0 0 0 2 2h2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5"/><path d="M4 12h16"/>',
};

const TOOLS = [
  { key: 'select', label: 'Select', enabled: true },
  { key: 'text', label: 'Edit text', enabled: false },
  { key: 'redact', label: 'Redact and replace', enabled: false },
  { key: 'image', label: 'Edit images', enabled: false },
  { key: 'insertPage', label: 'Insert page', enabled: true },
  { key: 'rotate', label: 'Rotate page', enabled: true },
  { key: 'merge', label: 'Merge documents', enabled: true },
  { key: 'ocr', label: 'Run OCR', enabled: false },
];

function icon(key, extra = '') {
  return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[key]}</svg>`;
}

let lastSignature = null;

export function renderToolbar(container, state, actions) {
  const signature = JSON.stringify([state.activeTool, state.isLoaded, state.fileName, state.selectedPageIndex]);
  if (signature === lastSignature && container.dataset.rendered === '1') return;
  lastSignature = signature;

  container.dataset.rendered = '1';
  container.innerHTML = `
    <div class="brand">
      <div class="brand-mark"><span>S</span></div>
      <span class="brand-name">Schurco PDF Editor</span>
    </div>
    <div class="toolbar-divider"></div>
    <span class="doc-name">${state.fileName || 'No document open'}</span>
    <div class="toolbar-spacer"></div>
    <div class="tool-pill">
      ${TOOLS.map((t) => `
        <button
          class="tool-btn ${state.activeTool === t.key ? 'active' : ''}"
          aria-label="${t.label}"
          title="${t.enabled ? t.label : t.label + ' — coming in a later phase'}"
          data-tool="${t.key}"
          ${(!t.enabled || !state.isLoaded) ? 'disabled' : ''}
        >${icon(t.key)}</button>
      `).join('')}
    </div>
    <div class="toolbar-spacer"></div>
    <div class="privacy-badge">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>
      <span>Local only — nothing uploaded</span>
    </div>
    <button class="export-btn" data-role="export" ${state.isLoaded ? '' : 'disabled'} aria-label="Export document">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>
      <span>Export</span>
    </button>
    <div class="avatar"><span>${(window.SCHURCO_USER_INITIALS || 'GV')}</span></div>
  `;

  container.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => actions.onToolClick(btn.dataset.tool));
  });
  container.querySelector('[data-role="export"]').addEventListener('click', () => actions.onExport());
}
