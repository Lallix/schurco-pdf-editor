// Self-contained dialogs for the two multi-step Phase 1 flows: inserting
// pages (blank or from another PDF) and merging whole documents. Each opens
// a backdrop + modal appended to <body> and resolves once closed.

import { engine, renderPageOfDoc } from '../pdf-engine.js';

function computeAtIndex(position, selectedPageIndex, pageCount) {
  switch (position) {
    case 'start': return 0;
    case 'before': return selectedPageIndex ?? 0;
    case 'after': return (selectedPageIndex ?? -1) + 1;
    case 'end':
    default: return pageCount;
  }
}

function closeModal(backdrop) {
  backdrop.remove();
}

function positionOptionsHtml(selectedPageIndex, pageCount) {
  const opts = [];
  if (selectedPageIndex !== null && pageCount > 0) {
    opts.push(['before', `Before page ${selectedPageIndex + 1}`]);
    opts.push(['after', `After page ${selectedPageIndex + 1}`]);
  }
  opts.push(['start', 'At the start']);
  opts.push(['end', 'At the end']);
  const defaultVal = selectedPageIndex !== null && pageCount > 0 ? 'after' : 'end';
  return opts.map(([v, label]) =>
    `<option value="${v}" ${v === defaultVal ? 'selected' : ''}>${label}</option>`
  ).join('');
}

export function openInsertPageModal({ selectedPageIndex, pageCount, onDone }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-label="Insert page">
      <h3>Insert page</h3>
      <div class="field-row" style="gap:6px;">
        <button type="button" class="btn-secondary tab-btn active" data-tab="blank" style="flex:1;">Blank page</button>
        <button type="button" class="btn-secondary tab-btn" data-tab="external" style="flex:1;">From another PDF</button>
      </div>

      <div data-panel="blank" class="field" style="gap:16px;">
        <div class="field">
          <span class="field-label">Page size</span>
          <select class="field-select" data-role="size" style="border:1px solid var(--line);appearance:none;">
            <option value="A4">A4 (210 × 297 mm)</option>
            <option value="Letter">Letter (216 × 279 mm)</option>
          </select>
        </div>
        <div class="field">
          <span class="field-label">Position</span>
          <select class="field-select" data-role="position-blank" style="border:1px solid var(--line);appearance:none;">
            ${positionOptionsHtml(selectedPageIndex, pageCount)}
          </select>
        </div>
      </div>

      <div data-panel="external" class="field" style="gap:14px; display:none;">
        <input type="file" accept="application/pdf" data-role="external-file" class="sr-only" />
        <button type="button" class="btn-secondary" data-role="choose-external">Choose PDF file…</button>
        <span class="panel-empty" data-role="external-status">No file selected.</span>
        <div class="modal-page-grid" data-role="external-grid"></div>
        <div class="field" data-role="external-position-wrap" style="display:none;">
          <span class="field-label">Insert selected pages</span>
          <select class="field-select" data-role="position-external" style="border:1px solid var(--line);appearance:none;">
            ${positionOptionsHtml(selectedPageIndex, pageCount)}
          </select>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-role="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-role="confirm">Insert</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  let activeTab = 'blank';
  let externalDoc = null;
  let externalBytes = null;
  const externalSelected = new Set();

  const tabBtns = backdrop.querySelectorAll('.tab-btn');
  const panels = {
    blank: backdrop.querySelector('[data-panel="blank"]'),
    external: backdrop.querySelector('[data-panel="external"]'),
  };
  const confirmBtn = backdrop.querySelector('[data-role="confirm"]');

  function updateConfirmState() {
    if (activeTab === 'blank') {
      confirmBtn.disabled = false;
    } else {
      confirmBtn.disabled = !externalDoc || externalSelected.size === 0;
    }
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
      panels.blank.style.display = activeTab === 'blank' ? 'flex' : 'none';
      panels.external.style.display = activeTab === 'external' ? 'flex' : 'none';
      updateConfirmState();
    });
  });

  const fileInput = backdrop.querySelector('[data-role="external-file"]');
  const chooseBtn = backdrop.querySelector('[data-role="choose-external"]');
  const statusEl = backdrop.querySelector('[data-role="external-status"]');
  const gridEl = backdrop.querySelector('[data-role="external-grid"]');
  const positionWrap = backdrop.querySelector('[data-role="external-position-wrap"]');

  chooseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    statusEl.textContent = `Loading ${file.name}…`;
    gridEl.innerHTML = '';
    externalSelected.clear();
    try {
      externalBytes = new Uint8Array(await file.arrayBuffer());
      externalDoc = await engine.loadExternalDocument(externalBytes);
      const renderDoc = await engine.loadExternalRenderDoc(externalBytes);
      const count = externalDoc.getPageCount();
      statusEl.textContent = `${file.name} — ${count} page${count === 1 ? '' : 's'}. Select pages to insert.`;
      for (let i = 0; i < count; i++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'modal-page-thumb';
        cell.setAttribute('aria-label', `Page ${i + 1}`);
        cell.innerHTML = `<canvas></canvas><span class="modal-page-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5 11-11"/></svg></span>`;
        gridEl.appendChild(cell);
        renderPageOfDoc(renderDoc, i, cell.querySelector('canvas'), 110);
        cell.addEventListener('click', () => {
          if (externalSelected.has(i)) externalSelected.delete(i);
          else externalSelected.add(i);
          cell.classList.toggle('selected', externalSelected.has(i));
          updateConfirmState();
        });
      }
      positionWrap.style.display = 'flex';
      updateConfirmState();
    } catch (err) {
      statusEl.textContent = `Could not read that file: ${err.message}`;
    }
  });

  backdrop.querySelector('[data-role="cancel"]').addEventListener('click', () => closeModal(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      if (activeTab === 'blank') {
        const size = backdrop.querySelector('[data-role="size"]').value;
        const position = backdrop.querySelector('[data-role="position-blank"]').value;
        const atIndex = computeAtIndex(position, selectedPageIndex, pageCount);
        await onDone({ type: 'blank', size, atIndex });
      } else {
        const position = backdrop.querySelector('[data-role="position-external"]').value;
        const atIndex = computeAtIndex(position, selectedPageIndex, pageCount);
        const indices = Array.from(externalSelected).sort((a, b) => a - b);
        await onDone({ type: 'external', externalDoc, indices, atIndex });
      }
      closeModal(backdrop);
    } catch (err) {
      confirmBtn.disabled = false;
      alert(`Could not insert page(s): ${err.message}`);
    }
  });

  updateConfirmState();
}

export function openMergeModal({ onDone }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-label="Merge documents">
      <h3>Merge PDFs into this document</h3>
      <span class="panel-empty">Selected files are appended to the end, in the order listed below.</span>
      <input type="file" accept="application/pdf" multiple data-role="merge-file" class="sr-only" />
      <button type="button" class="btn-secondary" data-role="choose-merge">Choose PDF file(s)…</button>
      <div data-role="merge-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-role="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-role="confirm" disabled>Merge</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const files = []; // { name, bytes }
  const listEl = backdrop.querySelector('[data-role="merge-list"]');
  const confirmBtn = backdrop.querySelector('[data-role="confirm"]');
  const fileInput = backdrop.querySelector('[data-role="merge-file"]');

  function renderList() {
    listEl.innerHTML = '';
    files.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'field-box';
      row.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', `Remove ${f.name}`);
      removeBtn.style.cssText = 'border:none;background:transparent;cursor:pointer;flex-shrink:0;';
      removeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      removeBtn.addEventListener('click', () => { files.splice(i, 1); renderList(); });
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    });
    confirmBtn.disabled = files.length === 0;
  }

  backdrop.querySelector('[data-role="choose-merge"]').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    for (const file of Array.from(fileInput.files)) {
      files.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    fileInput.value = '';
    renderList();
  });

  backdrop.querySelector('[data-role="cancel"]').addEventListener('click', () => closeModal(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      await onDone({ files });
      closeModal(backdrop);
    } catch (err) {
      confirmBtn.disabled = false;
      alert(`Could not merge: ${err.message}`);
    }
  });
}
