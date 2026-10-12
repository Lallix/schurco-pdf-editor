// Side-panel content for Phase 6: redaction (draw / select text / search), the
// crop tool, and the "Page tools" buttons on the page panel.

import { PRESETS } from '../textsearch.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MM = 0.352778;
const toMm = (pt) => Math.round(pt * MM * 10) / 10;
const toPt = (mm) => mm / MM;

// ---------------------------------------------------------------------------
// redaction

export function renderRedactPanel(container, state, actions) {
  const modes = [['match', 'Match page'], ['black', 'Black'], ['custom', 'Custom']];
  const rs = state.redactSearch;
  const results = rs.results;
  const marksN = state.redactMarks.length;
  const unmarked = results ? results.filter((r) => !r.marked).length : 0;
  const pagesHit = results ? new Set(results.map((r) => r.pageIndex)).size : 0;
  const LIST = 150;

  container.innerHTML = `
    <span class="panel-section-title">Redaction</span>
    <span class="panel-empty">Mark what must go — by drawing boxes, selecting text, or searching — then <strong>Redact all</strong>. It's permanently removed from the file, not just covered, once you export.</span>

    <div class="field">
      <span class="field-label">Mark by</span>
      <div class="segmented" role="radiogroup" aria-label="Mark by">
        ${[['box', 'Drawing a box'], ['text', 'Selecting text']].map(([k, l]) => `<button type="button" class="segmented-btn ${state.redactMode === k ? 'active' : ''}" role="radio" aria-checked="${state.redactMode === k}" data-mode="${k}">${l}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <span class="field-label">Search the whole document</span>
      <div style="display:flex;gap:6px;">
        <input type="search" class="field-box" data-role="query" placeholder="Word, phrase or number…" value="${esc(rs.query)}" style="border:1px solid var(--line);flex:1;" ${rs.preset ? 'disabled' : ''} />
        <button class="btn-primary" data-role="find" style="height:38px;padding:0 14px;font-size:12px;" ${rs.busy ? 'disabled' : ''}>${rs.busy ? 'Searching…' : 'Find'}</button>
      </div>
      <select class="field-select" data-role="preset" style="border:1px solid var(--line);appearance:none;">
        <option value="">Or pick a pattern…</option>
        ${PRESETS.map((p) => `<option value="${p.key}" ${rs.preset === p.key ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
      </select>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        ${[['matchCase', 'Match case'], ['wholeWord', 'Whole word'], ['regex', 'Pattern (regex)']].map(([k, l]) => `
          <label style="display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--ink-soft);cursor:pointer;">
            <input type="checkbox" data-opt="${k}" ${rs[k] ? 'checked' : ''} ${rs.preset && k === 'regex' ? 'disabled' : ''} /> ${l}
          </label>`).join('')}
      </div>
      ${rs.error ? `<span class="field-hint" style="color:var(--danger);">${esc(rs.error)}</span>` : ''}
    </div>

    ${results ? `
      <div class="field">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span class="field-hint">${results.length ? `${results.length} match${results.length === 1 ? '' : 'es'} on ${pagesHit} page${pagesHit === 1 ? '' : 's'}` : 'No matches found.'}</span>
          ${unmarked ? `<button class="btn-secondary" data-role="mark-all" style="height:28px;padding:0 10px;font-size:11.5px;">Mark all (${unmarked})</button>` : ''}
        </div>
        <div class="markup-list" style="max-height:230px;overflow-y:auto;">
          ${results.slice(0, LIST).map((r, i) => `
            <button type="button" class="markup-row ${r.marked ? 'selected' : ''}" data-result="${i}">
              <span class="markup-dot" style="background:${r.marked ? '#C0453A' : '#bbb'}"></span>
              <span class="markup-row-main">
                <span class="markup-row-top"><strong>${r.marked ? 'Marked' : 'Click to mark'}</strong><span>p.${r.pageIndex + 1}</span></span>
                <span class="markup-row-text">…${esc(r.before)}<mark style="background:#ffe28a;">${esc(r.text)}</mark>${esc(r.after)}…</span>
              </span>
            </button>`).join('')}
          ${results.length > LIST ? `<span class="field-hint" style="padding:6px 8px;">Showing the first ${LIST}; "Mark all" still marks every match.</span>` : ''}
        </div>
      </div>` : ''}

    ${marksN ? `
      <div class="ocr-card">
        <div class="ocr-card-header"><span>${marksN} area${marksN === 1 ? '' : 's'} marked</span></div>
        <button class="ocr-run-btn" data-role="redact-all" style="background:#C0453A;">Redact ${marksN > 1 ? 'all' : ''}</button>
        <button class="btn-secondary" data-role="redact-clear" style="height:30px;font-size:12px;">Clear marks</button>
      </div>` : ''}

    <div class="field">
      <span class="field-label">Fill</span>
      <div class="segmented" role="radiogroup" aria-label="Redaction fill">
        ${modes.map(([key, label]) => `
          <button type="button" class="segmented-btn ${state.redactFill === key ? 'active' : ''}" role="radio" aria-checked="${state.redactFill === key}" data-fill="${key}">${label}</button>
        `).join('')}
      </div>
      <span class="field-hint">${state.redactFill === 'match'
        ? 'The area is filled with the surrounding page colour, so it simply looks blank — no black box.'
        : state.redactFill === 'black' ? 'The area is covered with a solid black box.' : 'The area is covered with the colour you choose.'}</span>
    </div>

    ${state.redactFill === 'custom' ? `
      <div class="field">
        <span class="field-label">Colour</span>
        <input type="color" data-role="color" value="${state.redactColor}" class="swatch" style="padding:0;cursor:pointer;" />
      </div>
    ` : ''}
  `;

  container.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => actions.onRedactModeChange(b.dataset.mode)));
  container.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => actions.onRedactFillChange(b.dataset.fill)));
  container.querySelector('[data-role="color"]')?.addEventListener('input', (e) => actions.onRedactColorChange(e.target.value));
  const q = container.querySelector('[data-role="query"]');
  q.addEventListener('input', () => { rs.query = q.value; }); // no re-render: it would steal focus
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); actions.onRedactFind(); } });
  container.querySelector('[data-role="find"]').addEventListener('click', () => actions.onRedactFind());
  container.querySelector('[data-role="preset"]').addEventListener('change', (e) => actions.onRedactSearchOpts({ preset: e.target.value, results: null, error: '' }));
  container.querySelectorAll('[data-opt]').forEach((c) => c.addEventListener('change', () => actions.onRedactSearchOpts({ [c.dataset.opt]: c.checked })));
  container.querySelector('[data-role="mark-all"]')?.addEventListener('click', () => actions.onMarkSearchResults());
  container.querySelectorAll('[data-result]').forEach((b) => b.addEventListener('click', () => actions.onMarkSearchResults(Number(b.dataset.result))));
  container.querySelector('[data-role="redact-all"]')?.addEventListener('click', () => actions.onConfirmRedaction());
  container.querySelector('[data-role="redact-clear"]')?.addEventListener('click', () => actions.onCancelRedaction());
}

// ---------------------------------------------------------------------------
// crop

export function renderCropPanel(container, state, actions) {
  const idx = state.selectedPageIndex ?? 0;
  const info = state.pages[idx];
  const draft = state.cropPageDraft && state.cropPageDraft.pageIndex === idx ? state.cropPageDraft : null;
  const ins = draft ? draft.insets : { l: 0, t: 0, r: 0, b: 0 };
  const nSel = state.checkedPages.size;
  const anyCropped = state.pages.some((p) => p.cropped);

  container.innerHTML = `
    <span class="panel-section-title">Crop pages</span>
    <span class="panel-empty">Drag a rectangle on the page around the area to keep, then adjust it with the corners or the margins below. Everything outside is hidden in every viewer.</span>
    ${info ? `<span class="field-hint">Page ${idx + 1} is currently ${esc(info.sizeLabel)}${info.cropped ? ' (cropped)' : ''}.</span>` : ''}

    <div class="field">
      <span class="field-label">Margins to remove (mm)</span>
      <div class="field-row">
        <div class="field"><span class="field-label">Left</span><input type="number" min="0" step="0.5" class="field-box" data-inset="l" value="${toMm(ins.l)}" style="border:1px solid var(--line);" /></div>
        <div class="field"><span class="field-label">Right</span><input type="number" min="0" step="0.5" class="field-box" data-inset="r" value="${toMm(ins.r)}" style="border:1px solid var(--line);" /></div>
      </div>
      <div class="field-row">
        <div class="field"><span class="field-label">Top</span><input type="number" min="0" step="0.5" class="field-box" data-inset="t" value="${toMm(ins.t)}" style="border:1px solid var(--line);" /></div>
        <div class="field"><span class="field-label">Bottom</span><input type="number" min="0" step="0.5" class="field-box" data-inset="b" value="${toMm(ins.b)}" style="border:1px solid var(--line);" /></div>
      </div>
      <button class="btn-secondary" data-role="detect" style="height:32px;font-size:12px;">Fit to page content</button>
    </div>

    <div class="field">
      <span class="field-label">Apply to</span>
      <select class="field-select" data-role="scope" style="border:1px solid var(--line);appearance:none;">
        <option value="page" ${state.cropScope === 'page' ? 'selected' : ''}>This page</option>
        <option value="all" ${state.cropScope === 'all' ? 'selected' : ''}>All pages (same margins)</option>
        ${nSel > 1 ? `<option value="selected" ${state.cropScope === 'selected' ? 'selected' : ''}>Selected pages (${nSel})</option>` : ''}
      </select>
    </div>

    <div style="display:flex;gap:8px;">
      <button class="btn-primary" data-role="apply" style="flex:1;" ${draft ? '' : 'disabled'}>Crop</button>
      <button class="btn-secondary" data-role="reset" style="flex:1;" ${anyCropped ? '' : 'disabled'} title="Show the whole page again">Reset crop</button>
    </div>
    <button class="btn-secondary" data-role="done" style="height:32px;font-size:12px;">Done</button>
    <span class="field-hint">Cropping hides the outside area but doesn't delete it from the file. Use Redact for anything that must be removed.</span>
  `;

  container.querySelectorAll('[data-inset]').forEach((inp) => inp.addEventListener('change', () => {
    actions.onCropPageInsets({ [inp.dataset.inset]: Math.max(0, toPt(Number(inp.value) || 0)) });
  }));
  container.querySelector('[data-role="detect"]').addEventListener('click', () => actions.onCropPageDetect());
  container.querySelector('[data-role="scope"]').addEventListener('change', (e) => actions.onCropScopeChange(e.target.value));
  container.querySelector('[data-role="apply"]').addEventListener('click', () => actions.onApplyCrop());
  container.querySelector('[data-role="reset"]').addEventListener('click', () => actions.onResetCrop());
  container.querySelector('[data-role="done"]').addEventListener('click', () => actions.onToolClick('select'));
}

// ---------------------------------------------------------------------------
// page tools block on the page panel

export function pageToolsHtml(state) {
  const anyFlat = state.pages.some((p) => p.flattened > 0);
  const flatHere = state.pages[state.selectedPageIndex ?? 0]?.flattened || 0;
  const icon = (d) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const btn = (role, label, svg, disabled = false, title = '') => `<button class="btn-secondary tool-tile" data-ptool="${role}" ${disabled ? 'disabled' : ''} title="${esc(title)}">${icon(svg)}<span>${label}</span></button>`;
  return `
    <span class="panel-section-title">Page tools</span>
    <div class="tool-tiles">
      ${btn('crop', 'Crop…', '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>', false, 'Crop pages to an area')}
      ${btn('deskew', 'Deskew…', '<path d="M4 15l16-6"/><path d="M4 20h16"/><path d="M12 4v3"/>', false, 'Straighten a skewed scan')}
      ${btn('flatten', 'Flatten…', '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>', false, 'Bake markups into the page (reversible)')}
      ${btn('unflatten', 'Unflatten…', '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M12 13v8M9 18l3 3 3-3"/>', !anyFlat, anyFlat ? 'Make flattened markups editable again' : 'Nothing has been flattened with this editor')}
    </div>
    ${flatHere ? `<span class="field-hint">${flatHere} markup${flatHere === 1 ? '' : 's'} on this page ${flatHere === 1 ? 'is' : 'are'} flattened.</span>` : ''}
  `;
}

export function bindPageTools(container, actions) {
  container.querySelectorAll('[data-ptool]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.ptool;
    if (k === 'crop') actions.onToolClick('cropPage');
    else if (k === 'deskew') actions.onDeskewClick();
    else if (k === 'flatten') actions.onFlattenClick();
    else if (k === 'unflatten') actions.onUnflattenClick();
  }));
}
