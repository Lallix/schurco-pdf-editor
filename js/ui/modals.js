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

// `pages` lists every page with what we know about it; pages that look scanned
// are pre-ticked (or the open page, if none do). `onRun(indices, onProgress)`
// does the actual OCR work.
export function openOcrModal({ pages, currentIndex, onRun }) {
  const anyScanned = pages.some((p) => p.scanned);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-label="Run OCR">
      <h3>Run OCR</h3>
      <span class="panel-empty">Makes the selected pages' text searchable, selectable, and copyable — the pages will look identical. Runs entirely in this browser; nothing is uploaded.</span>
      ${anyScanned ? '' : '<span class="field-hint" style="color:var(--ink);">None of the pages look scanned, but you can still run OCR on any page — tick the ones you want. Real text already on a page is left alone.</span>'}
      <div data-role="page-list" style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;"></div>
      <span data-role="progress" class="field-hint" style="display:none;"></span>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-role="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-role="run">Run OCR</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const listEl = backdrop.querySelector('[data-role="page-list"]');
  const checked = new Set(anyScanned ? pages.filter((p) => p.scanned).map((p) => p.index) : [currentIndex]);
  const runBtn = backdrop.querySelector('[data-role="run"]');
  const cancelBtn = backdrop.querySelector('[data-role="cancel"]');
  const progressEl = backdrop.querySelector('[data-role="progress"]');

  const describe = (p) => {
    if (p.ocrDone) return 'OCR already run';
    if (p.scanned) return p.textChars < 3 ? 'scanned — no selectable text' : 'looks scanned';
    return `has selectable text (${p.textChars} characters)`;
  };
  pages.forEach((p) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink);cursor:pointer;';
    row.innerHTML = `<input type="checkbox" ${checked.has(p.index) ? 'checked' : ''} data-idx="${p.index}" /><span>Page ${p.index + 1}</span><span style="color:var(--muted);font-size:11.5px;">${describe(p)}</span>`;
    listEl.appendChild(row);
  });
  runBtn.disabled = checked.size === 0;
  listEl.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const idx = Number(cb.dataset.idx);
    if (cb.checked) checked.add(idx); else checked.delete(idx);
    runBtn.disabled = checked.size === 0;
  });

  cancelBtn.addEventListener('click', () => closeModal(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    cancelBtn.disabled = true;
    listEl.querySelectorAll('input').forEach((cb) => { cb.disabled = true; });
    progressEl.style.display = 'block';
    const indices = Array.from(checked).sort((a, b) => a - b);
    try {
      await onRun(indices, (pageIdx, pageNum, total, pct) => {
        progressEl.textContent = `Reading page ${pageIdx + 1} (${pageNum} of ${total}) — ${Math.round(pct * 100)}%`;
      });
      closeModal(backdrop);
    } catch (err) {
      progressEl.textContent = `OCR failed: ${err.message}`;
      runBtn.disabled = false;
      cancelBtn.disabled = false;
      listEl.querySelectorAll('input').forEach((cb) => { cb.disabled = false; });
    }
  });
}


// Options dialog shown before a Word / Excel export. `onRun(options)` receives
// { scope: 'all' | 'selected', ...format options } and does the export.
export function openExportOptionsModal({ kind, pageCount, selectedCount, onRun }) {
  const isWord = kind === 'word';
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const radio = (name, value, label, checked, hint = '') => `
    <label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--ink);cursor:pointer;">
      <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} style="margin-top:3px;" />
      <span>${label}${hint ? `<br><span style="color:var(--muted);font-size:11.5px;">${hint}</span>` : ''}</span>
    </label>`;
  const check = (name, label, checked, hint = '') => `
    <label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--ink);cursor:pointer;">
      <input type="checkbox" name="${name}" ${checked ? 'checked' : ''} style="margin-top:3px;" />
      <span>${label}${hint ? `<br><span style="color:var(--muted);font-size:11.5px;">${hint}</span>` : ''}</span>
    </label>`;
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-label="Export to ${isWord ? 'Word' : 'Excel'}">
      <h3>Export to ${isWord ? 'Word' : 'Excel'}</h3>
      <span class="panel-empty">The page layout is rebuilt rather than copied: tables become real tables, columns stay side by side, and text keeps its font, size, colour and alignment. Complex pages won't be pixel-perfect. Scanned pages need OCR first. Nothing is uploaded.</span>
      ${selectedCount > 1 ? `
        <div class="field">
          <span class="field-label">Pages</span>
          ${radio('scope', 'all', `All pages (${pageCount})`, false)}
          ${radio('scope', 'selected', `Selected pages (${selectedCount})`, true)}
        </div>` : ''}
      ${isWord ? `
        <div class="field">
          <span class="field-label">Include</span>
          ${check('images', 'Pictures and line art', true)}
          ${check('background', 'Page backgrounds', false, 'Full-page artwork such as a letterhead. Leave off for easier editing.')}
        </div>` : `
        <div class="field">
          <span class="field-label">Layout</span>
          ${radio('mode', 'layout', 'Keep page layout', true, 'One sheet per page, text placed on a cell grid that follows the page.')}
          ${radio('mode', 'tables', 'Tables only', false, 'One sheet per ruled table — best for data you want to calculate with.')}
        </div>
        <div class="field">
          <span class="field-label">Include</span>
          ${check('images', 'Pictures and line art (page layout mode)', true)}
        </div>`}
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-role="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-role="run">Export</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const val = (name) => backdrop.querySelector(`input[name="${name}"]:checked`)?.value;
  const on = (name) => !!backdrop.querySelector(`input[name="${name}"]`)?.checked;
  backdrop.querySelector('[data-role="cancel"]').addEventListener('click', () => closeModal(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });
  backdrop.querySelector('[data-role="run"]').addEventListener('click', () => {
    const options = {
      scope: selectedCount > 1 ? val('scope') : 'all',
      keepImages: on('images'),
      keepBackground: isWord ? on('background') : false,
      mode: isWord ? undefined : val('mode'),
    };
    closeModal(backdrop);
    onRun(options);
  });
}
