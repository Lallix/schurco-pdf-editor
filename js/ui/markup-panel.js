// Right-hand panel for the Markup tool: style controls, the selected markup's
// comment, and the Markups List (browse / filter / jump to / export).

import { STAMPS, REVU_RED, REVU_BLUE, REVU_YELLOW } from '../markups.js';
import { MARKUP_TOOLS } from './markup-tools.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SWATCHES = [REVU_RED, REVU_BLUE, '#218240', '#E8820C', REVU_YELLOW, '#111111', '#FFFFFF'];
const WIDTHS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6];
const FILLS = [['auto', 'Automatic'], ['none', 'None'], ['white', 'White'], ['yellow', 'Light yellow']];

const TEXT_KINDS = new Set(['FreeText', 'FreeTextCallout']);
const NO_WIDTH = new Set(['Highlight', 'Underline', 'StrikeOut', 'Text', 'Stamp']);
const FILL_KINDS = new Set(['FreeText', 'FreeTextCallout', 'Square', 'Circle']);

const KIND_OF_TOOL = {
  text: 'FreeText', callout: 'FreeTextCallout', line: 'Line', arrow: 'LineArrow', rect: 'Square', ellipse: 'Circle',
  cloud: 'PolygonCloud', highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut', ink: 'Ink', note: 'Text', stamp: 'Stamp',
};

const TOOL_HINT = {
  select: 'Click a markup to select it. Drag to move, drag a corner to resize. Delete removes it.',
  text: 'Click or drag on the page, then type.',
  callout: 'Drag a box, click where the leader should point, then type.',
  line: 'Drag to draw. Hold Shift for 45°.',
  arrow: 'Drag from the tail to the point. Hold Shift for 45°.',
  rect: 'Drag to draw a rectangle.',
  ellipse: 'Drag to draw an ellipse.',
  cloud: 'Click each corner; double-click (or Enter) to close the cloud.',
  highlight: 'Select text on the page to highlight it.',
  underline: 'Select text on the page to underline it.',
  strike: 'Select text on the page to strike it through.',
  ink: 'Drag to draw freehand.',
  note: 'Click where the note should go, then write it.',
  stamp: 'Click to place a stamp, or drag to size it.',
};

export function typeOptions(markups) {
  return [...new Set(markups.map((m) => m.type))].sort();
}

export function authorOptions(markups) {
  return [...new Set(markups.map((m) => m.author || '(none)'))].sort();
}

export function filterMarkups(markups, f) {
  const q = (f.search || '').trim().toLowerCase();
  return markups.filter((m) => {
    if (f.type !== 'all' && m.type !== f.type) return false;
    if (f.author !== 'all' && (m.author || '(none)') !== f.author) return false;
    if (q && !`${m.contents} ${m.author} ${m.type} ${m.subject}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function renderMarkupPanel(container, state, actions) {
  if (state.markupListOpen) return renderList(container, state, actions);

  const tool = state.markupTool;
  const sel = state.markups.find((m) => m.ref === state.selectedMarkup) || null;
  const kind = sel ? sel.kind : KIND_OF_TOOL[tool];
  const toolLabel = MARKUP_TOOLS.find((t) => t.key === tool)?.label.split(' (')[0] || 'Markup';
  const style = state.markupStyle;

  const color = sel ? (sel.color || REVU_RED) : (style.color || (kind === 'Highlight' ? REVU_YELLOW : REVU_RED));
  const lw = sel ? sel.lineWidth ?? 1 : style.lineWidth ?? (kind === 'FreeText' || kind === 'FreeTextCallout' ? 0.5 : 2);
  const fs = sel ? sel.fontSize ?? 10 : style.fontSize;
  const fillMode = sel ? (sel.fill ? (sel.fill.toUpperCase() === '#FFFFFF' ? 'white' : 'yellow') : 'none') : style.fill;

  const showWidth = kind && !NO_WIDTH.has(kind);
  const showText = kind && TEXT_KINDS.has(kind);
  const showFill = kind && FILL_KINDS.has(kind);
  const showCloud = kind === 'PolygonCloud';
  const align = sel ? sel.align || 'left' : style.align || 'left';
  const arc = sel ? sel.arc || 10 : style.arc || 10;
  const invert = sel ? !!sel.invert : !!style.invert;

  container.innerHTML = `
    <span class="panel-section-title">${sel ? `Selected: ${esc(sel.type)}` : esc(toolLabel)}</span>
    <span class="panel-empty">${sel ? `Page ${sel.pageIndex + 1}${sel.author ? ` · ${esc(sel.author)}` : ''}${sel.date ? ` · ${esc(fmtDate(sel.date))}` : ''}` : esc(TOOL_HINT[tool] || '')}</span>

    ${tool === 'stamp' && !sel ? `
      <div class="field">
        <span class="field-label">Stamp</span>
        <div class="stamp-grid">
          ${STAMPS.map((s) => `<button type="button" class="stamp-btn ${state.stampKey === s.key ? 'active' : ''}" data-stamp="${s.key}" style="--c:${s.color}">${esc(s.text)}</button>`).join('')}
        </div>
      </div>` : ''}

    ${kind && kind !== 'Stamp' ? `
      <div class="field">
        <span class="field-label">Colour</span>
        <div class="swatch-row">
          ${SWATCHES.map((c) => `<button type="button" class="swatch-btn ${c.toUpperCase() === color.toUpperCase() ? 'active' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}
          <input type="color" data-role="color" value="${color}" class="swatch-custom" aria-label="Custom colour" />
        </div>
      </div>` : ''}

    <div class="field-row">
      ${showWidth ? `
        <div class="field">
          <span class="field-label">Line width</span>
          <select class="field-select" data-role="width" style="border:1px solid var(--line);appearance:none;">
            ${WIDTHS.map((w) => `<option value="${w}" ${Number(lw) === w ? 'selected' : ''}>${w} pt</option>`).join('')}
          </select>
        </div>` : ''}
      ${showText ? `
        <div class="field">
          <span class="field-label">Font size</span>
          <input type="number" min="6" max="48" class="field-box" data-role="fontsize" value="${fs || 10}" style="border:1px solid var(--line);" />
        </div>` : ''}
    </div>

    ${showText ? `
      <div class="field">
        <span class="field-label">Text alignment</span>
        <div class="segmented" role="radiogroup" aria-label="Text alignment">
          ${[['left', 'Left', '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'], ['center', 'Centre', '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'], ['right', 'Right', '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>']].map(([k, label, icon]) => `
            <button type="button" class="segmented-btn ${align === k ? 'active' : ''}" role="radio" aria-checked="${align === k}" data-align="${k}" title="${label}" aria-label="${label}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:middle;">${icon}</svg>
            </button>`).join('')}
        </div>
      </div>` : ''}

    ${showCloud ? `
      <div class="field">
        <span class="field-label">Cloud scallop size</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="range" min="4" max="40" step="1" value="${arc}" data-role="arc" style="flex:1;accent-color:var(--accent);" />
          <span class="field-hint" data-role="arc-label" style="min-width:34px;text-align:right;">${Math.round(arc)} pt</span>
        </div>
        <div style="display:flex;gap:6px;">
          ${[['Small', 6], ['Medium', 10], ['Large', 18], ['X-Large', 28]].map(([l, v]) => `<button type="button" class="btn-secondary" data-arc-preset="${v}" style="flex:1;height:28px;padding:0;font-size:11px;${Math.round(arc) === v ? 'border-color:var(--accent);color:var(--accent);' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="toggle-row">
        <span class="toggle-label">Invert (scallops point inward)</span>
        <button type="button" class="toggle ${invert ? 'on' : ''}" data-role="invert" role="switch" aria-checked="${invert}" aria-label="Invert cloud"><span class="toggle-knob"></span></button>
      </div>` : ''}

    ${showFill ? `
      <div class="field">
        <span class="field-label">Fill</span>
        <select class="field-select" data-role="fill" style="border:1px solid var(--line);appearance:none;">
          ${FILLS.filter(([k]) => sel ? k !== 'auto' : true).map(([k, l]) => `<option value="${k}" ${fillMode === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>` : ''}

    ${sel ? `
      <div class="field">
        <span class="field-label">Comment</span>
        <textarea data-role="comment" class="comment-box" rows="4" placeholder="Add a comment…">${esc(sel.contents)}</textarea>
        <div style="display:flex;gap:8px;">
          <button class="btn-primary" data-role="save-comment" style="height:32px;font-size:12px;">Save comment</button>
          <button class="delete-page-btn" data-role="delete" style="height:32px;flex:1;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 13h8l1-13"/></svg>
            <span>Delete</span>
          </button>
        </div>
      </div>` : ''}

    <div class="section-divider"></div>
    <span class="field-hint">Author: <strong>${esc(state.markupAuthor || 'not set')}</strong> — <a href="#" data-role="author" style="color:var(--accent);">change</a><br>
    Markups are standard PDF annotations, so Bluebeam Revu and Acrobat can open and edit them too.</span>
  `;

  const apply = (patch) => actions.onMarkupStyleChange(patch);
  container.querySelectorAll('[data-stamp]').forEach((b) => b.addEventListener('click', () => actions.onStampChange(b.dataset.stamp)));
  container.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => apply({ color: b.dataset.color })));
  container.querySelector('[data-role="color"]')?.addEventListener('change', (e) => apply({ color: e.target.value.toUpperCase() }));
  container.querySelector('[data-role="width"]')?.addEventListener('change', (e) => apply({ lineWidth: Number(e.target.value) }));
  container.querySelector('[data-role="fontsize"]')?.addEventListener('change', (e) => apply({ fontSize: Math.max(6, Math.min(48, Number(e.target.value) || 10)) }));
  container.querySelectorAll('[data-align]').forEach((b) => b.addEventListener('click', () => apply({ align: b.dataset.align })));
  const arcInput = container.querySelector('[data-role="arc"]');
  arcInput?.addEventListener('input', () => { container.querySelector('[data-role="arc-label"]').textContent = `${arcInput.value} pt`; });
  arcInput?.addEventListener('change', () => apply({ arc: Number(arcInput.value) }));
  container.querySelectorAll('[data-arc-preset]').forEach((b) => b.addEventListener('click', () => apply({ arc: Number(b.dataset.arcPreset) })));
  container.querySelector('[data-role="invert"]')?.addEventListener('click', () => apply({ invert: !invert }));
  container.querySelector('[data-role="fill"]')?.addEventListener('change', (e) => apply({ fill: e.target.value }));
  container.querySelector('[data-role="save-comment"]')?.addEventListener('click', () => actions.onSetMarkupText(sel.ref, container.querySelector('[data-role="comment"]').value));
  container.querySelector('[data-role="delete"]')?.addEventListener('click', () => actions.onDeleteMarkup(sel.ref));
  container.querySelector('[data-role="author"]')?.addEventListener('click', (e) => { e.preventDefault(); actions.onChangeAuthor(); });
  if (sel && state.focusMarkupText) {
    state.focusMarkupText = false;
    container.querySelector('[data-role="comment"]')?.focus();
  }
}

function renderList(container, state, actions) {
  const f = state.markupFilter;
  const types = typeOptions(state.markups);
  const authors = authorOptions(state.markups);
  const rows = filterMarkups(state.markups, f);
  const LIMIT = 500;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <span class="panel-section-title">Markups List</span>
      <button class="thumb-action-btn" data-role="close-list" aria-label="Close list" title="Back to tools" style="width:28px;height:28px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <input type="search" class="field-box" data-role="search" placeholder="Search comments…" value="${esc(f.search)}" style="border:1px solid var(--line);" />
    <div class="field-row">
      <select class="field-select" data-role="type" style="border:1px solid var(--line);appearance:none;">
        <option value="all">All types</option>
        ${types.map((t) => `<option value="${esc(t)}" ${f.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      <select class="field-select" data-role="author-filter" style="border:1px solid var(--line);appearance:none;">
        <option value="all">All authors</option>
        ${authors.map((a) => `<option value="${esc(a)}" ${f.author === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <span class="field-hint" data-role="count">${rows.length} of ${state.markups.length} markups</span>
      <span style="display:flex;gap:6px;">
        <button class="btn-secondary" data-role="export-xlsx" style="height:28px;padding:0 10px;font-size:11.5px;" ${rows.length ? '' : 'disabled'}>Excel</button>
        <button class="btn-secondary" data-role="export-csv" style="height:28px;padding:0 10px;font-size:11.5px;" ${rows.length ? '' : 'disabled'}>CSV</button>
      </span>
    </div>
    <div class="markup-list" data-role="rows">
      ${rows.slice(0, LIMIT).map((m) => `
        <button type="button" class="markup-row ${state.selectedMarkup === m.ref ? 'selected' : ''}" data-ref="${esc(m.ref)}" data-page="${m.pageIndex}" data-hay="${esc(`${m.contents} ${m.author} ${m.type} ${m.subject}`.toLowerCase())}">
          <span class="markup-dot" style="background:${esc(m.color || '#999')}"></span>
          <span class="markup-row-main">
            <span class="markup-row-top"><strong>${esc(m.type)}</strong><span>p.${m.pageIndex + 1}</span></span>
            <span class="markup-row-text">${m.contents ? esc(m.contents) : '<em>(no text)</em>'}</span>
            <span class="markup-row-meta">${esc(m.author || '')}${m.date ? ` · ${esc(fmtDate(m.date))}` : ''}</span>
          </span>
        </button>`).join('')}
      ${rows.length > LIMIT ? `<span class="field-hint" style="padding:8px;">Showing the first ${LIMIT}. Use the filters to narrow the list.</span>` : ''}
      ${!rows.length ? '<span class="panel-empty" style="padding:8px;">No markups match.</span>' : ''}
    </div>
  `;

  container.querySelector('[data-role="close-list"]').addEventListener('click', () => actions.onToggleMarkupList());
  // typing filters the rows in place (re-rendering would steal focus from the box)
  const search = container.querySelector('[data-role="search"]');
  search.addEventListener('input', () => {
    f.search = search.value;
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    container.querySelectorAll('.markup-row').forEach((row) => {
      const ok = !q || row.dataset.hay.includes(q);
      row.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    container.querySelector('[data-role="count"]').textContent = `${shown} of ${state.markups.length} markups`;
  });
  container.querySelector('[data-role="type"]').addEventListener('change', (e) => actions.onMarkupFilter({ type: e.target.value }));
  container.querySelector('[data-role="author-filter"]').addEventListener('change', (e) => actions.onMarkupFilter({ author: e.target.value }));
  container.querySelectorAll('.markup-row').forEach((row) => {
    row.addEventListener('click', () => actions.onSelectMarkup(row.dataset.ref, Number(row.dataset.page), { fromList: true }));
  });
  container.querySelector('[data-role="export-xlsx"]').addEventListener('click', () => actions.onExportMarkups('xlsx', rows));
  container.querySelector('[data-role="export-csv"]').addEventListener('click', () => actions.onExportMarkups('csv', rows));
}
