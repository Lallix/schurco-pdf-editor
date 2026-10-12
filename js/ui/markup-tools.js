// Markup tools UI: the tool bar, drawing interactions on the page, selection /
// move / resize of existing markups, and the inline text editor for new ones.
// The markups themselves are written by markups.js (through actions).

import { STAMPS, REVU_RED, REVU_YELLOW } from '../markups.js';

const I = (body) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const MARKUP_TOOLS = [
  { key: 'select', label: 'Select, move and edit markups', icon: '<path d="M5 3l14 8-6 1.6-2 6.4-6-16z"/>' },
  { key: 'text', label: 'Text box', icon: '<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M8 10h8M8 14h5"/>' },
  { key: 'callout', label: 'Callout (text box with a leader line)', icon: '<rect x="3" y="4" width="13" height="9" rx="1"/><path d="M10 13l7 7"/>' },
  { key: 'line', label: 'Line (hold Shift for 45°)', icon: '<path d="M5 19L19 5"/>' },
  { key: 'arrow', label: 'Arrow (hold Shift for 45°)', icon: '<path d="M5 19L19 5M10 5h9v9"/>' },
  { key: 'rect', label: 'Rectangle', icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  { key: 'ellipse', label: 'Ellipse', icon: '<ellipse cx="12" cy="12" rx="8" ry="6"/>' },
  { key: 'cloud', label: 'Revision cloud (click points, double-click to finish)', icon: '<path d="M7 18a3.500 3.500 0 0 1-.6-6.900A5 5 0 0 1 16 9a3.500 3.500 0 0 1 1 6.900V18z"/>' },
  { key: 'highlight', label: 'Highlight text', icon: '<path d="M4 21h7M14 3l7 7-9 9-7-7 9-9z"/>' },
  { key: 'underline', label: 'Underline text', icon: '<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>' },
  { key: 'strike', label: 'Strikethrough text', icon: '<path d="M7 7c0-2 2-3 5-3s5 1 5 3M4 12h16M17 15c0 2.500-2 4-5 4s-5-1.500-5-4"/>' },
  { key: 'ink', label: 'Pen (freehand)', icon: '<path d="M4 20l1-4L16 5l3 3L8 19l-4 1z"/>' },
  { key: 'note', label: 'Note (sticky comment)', icon: '<path d="M5 4h14v12h-8l-4 4v-4H5z"/>' },
  { key: 'stamp', label: 'Stamp', icon: '<rect x="5" y="14" width="14" height="5" rx="1"/><path d="M9 14v-3a3 3 0 1 1 6 0v3"/>' },
];

const KIND_OF_TOOL = {
  text: 'FreeText', callout: 'FreeTextCallout', line: 'Line', arrow: 'LineArrow', rect: 'Square', ellipse: 'Circle',
  cloud: 'PolygonCloud', highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut', ink: 'Ink', note: 'Text', stamp: 'Stamp',
};

export function markupBarHtml(state) {
  return `
    <div class="markup-bar" role="toolbar" aria-label="Markup tools">
      ${MARKUP_TOOLS.map((t) => `
        <button class="markup-tool ${state.markupTool === t.key ? 'active' : ''}" data-markup-tool="${t.key}" title="${t.label}" aria-label="${t.label}">${I(t.icon)}</button>
      `).join('')}
      <span class="markup-bar-divider"></span>
      <button class="markup-tool ${state.markupListOpen ? 'active' : ''}" data-role="markup-list" title="Markups List" aria-label="Markups List">${I('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>')}<span class="markup-count">${state.markups.length}</span></button>
    </div>`;
}

export function wireMarkupBar(container, actions) {
  container.querySelectorAll('[data-markup-tool]').forEach((b) => {
    b.addEventListener('click', () => actions.onMarkupToolChange(b.dataset.markupTool));
  });
  container.querySelector('[data-role="markup-list"]')?.addEventListener('click', () => actions.onToggleMarkupList());
}

// --- helpers ----------------------------------------------------------------

function pdfRectToScreen(viewport, [x0, y0, x1, y1]) {
  const p1 = viewport.convertToViewportPoint(x0, y0);
  const p2 = viewport.convertToViewportPoint(x1, y1);
  return { left: Math.min(p1[0], p2[0]), top: Math.min(p1[1], p2[1]), width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]) };
}

function rectFromScreen(viewport, left, top, width, height) {
  const [x1, y1] = viewport.convertToPdfPoint(left, top);
  const [x2, y2] = viewport.convertToPdfPoint(left + width, top + height);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function previewColor(state) {
  const t = state.markupTool;
  return state.markupStyle.color || (t === 'highlight' ? REVU_YELLOW : REVU_RED);
}

function snap45(p1, p2) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [p1[0] + Math.cos(ang) * len, p1[1] + Math.sin(ang) * len];
}

// Selected text -> quads (PDF space) for highlight / underline / strikethrough.
export function quadsFromSelection(layer, viewport) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  if (!layer.contains(range.commonAncestorContainer)) return [];
  const base = layer.getBoundingClientRect();
  const quads = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const l = r.left - base.left, t = r.top - base.top;
    const [x0, y0] = viewport.convertToPdfPoint(l, t);
    const [x1, y1] = viewport.convertToPdfPoint(l + r.width, t + r.height);
    const left = Math.min(x0, x1), right = Math.max(x0, x1), bottom = Math.min(y0, y1), top = Math.max(y0, y1);
    quads.push([left, top, right, top, left, bottom, right, bottom]);
  }
  return quads;
}

// --- drawing new markups ----------------------------------------------------

let draftText = null;
let lastDraftKey = null;
let cloudPoints = null; // screen-space points while a cloud is being clicked out

export function wireMarkupCreate(hit, overlays, idx, viewport, state, actions, textLayerEl) {
  const tool = state.markupTool;
  if (tool === 'select') { hit.style.cursor = 'default'; return; }
  hit.style.cursor = 'crosshair';
  const color = previewColor(state);
  const lw = Math.max(1, (state.markupStyle.lineWidth ?? 2) * viewport.scale);

  const local = (e) => {
    const r = hit.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toPdf = (p) => viewport.convertToPdfPoint(p[0], p[1]);

  // text-markup tools work on the selectable text layer instead
  if (tool === 'highlight' || tool === 'underline' || tool === 'strike') {
    if (textLayerEl) {
      textLayerEl.addEventListener('mouseup', () => {
        setTimeout(() => {
          const quads = quadsFromSelection(textLayerEl, viewport);
          if (!quads.length) return;
          window.getSelection().removeAllRanges();
          actions.onCreateMarkup({ kind: KIND_OF_TOOL[tool], pageIndex: idx, quads });
        }, 0);
      });
    }
    return;
  }

  // draft with a text editor already open: the page is inert until it's done
  if (state.markupDraft && state.markupDraft.stage === 'text') return;

  // click-to-place tools
  if (tool === 'note') {
    hit.addEventListener('click', (e) => {
      const p = toPdf(local(e));
      actions.onMarkupDraft({ kind: 'Text', pageIndex: idx, p1: p, stage: 'text' });
    });
    return;
  }

  if (tool === 'cloud') {
    wireCloud(hit, overlays, idx, viewport, state, actions, local, toPdf, color, lw);
    return;
  }

  // callout step 2: click where the leader should point
  if (state.markupDraft && state.markupDraft.stage === 'tip') {
    hit.addEventListener('click', (e) => {
      const tip = toPdf(local(e));
      actions.onMarkupDraft({ ...state.markupDraft, tip, stage: 'text' });
    });
    return;
  }

  hit.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const start = local(e);
    let preview = null;
    const ink = [start];
    if (tool === 'ink') {
      const svg = svgEl('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;' });
      preview = svgEl('polyline', { fill: 'none', stroke: color, 'stroke-width': lw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      svg.appendChild(preview);
      overlays.appendChild(svg);
    } else if (tool === 'line' || tool === 'arrow') {
      const svg = svgEl('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;' });
      preview = svgEl('line', { stroke: color, 'stroke-width': lw, 'stroke-linecap': 'round' });
      svg.appendChild(preview);
      overlays.appendChild(svg);
    } else {
      preview = document.createElement('div');
      preview.style.cssText = `position:absolute;pointer-events:none;box-sizing:border-box;border:${Math.max(1.5, lw)}px ${tool === 'text' || tool === 'callout' ? 'dashed' : 'solid'} ${tool === 'stamp' ? '#E44234' : color};${tool === 'ellipse' ? 'border-radius:50%;' : ''}`;
      overlays.appendChild(preview);
    }

    const onMove = (ev) => {
      const r = hit.getBoundingClientRect();
      let cur = [Math.min(Math.max(ev.clientX - r.left, 0), r.width), Math.min(Math.max(ev.clientY - r.top, 0), r.height)];
      if ((tool === 'line' || tool === 'arrow') && ev.shiftKey) cur = snap45(start, cur);
      if (tool === 'ink') {
        ink.push(cur);
        preview.setAttribute('points', ink.map((p) => p.join(',')).join(' '));
      } else if (tool === 'line' || tool === 'arrow') {
        preview.setAttribute('x1', start[0]); preview.setAttribute('y1', start[1]);
        preview.setAttribute('x2', cur[0]); preview.setAttribute('y2', cur[1]);
      } else {
        preview.style.left = `${Math.min(start[0], cur[0])}px`;
        preview.style.top = `${Math.min(start[1], cur[1])}px`;
        preview.style.width = `${Math.abs(cur[0] - start[0])}px`;
        preview.style.height = `${Math.abs(cur[1] - start[1])}px`;
      }
      preview._cur = cur;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const cur = preview._cur || start;
      (preview.parentNode?.tagName === 'svg' ? preview.parentNode : preview).remove();
      const dx = Math.abs(cur[0] - start[0]), dy = Math.abs(cur[1] - start[1]);
      const kind = KIND_OF_TOOL[tool];
      const base = { kind, pageIndex: idx };

      if (tool === 'ink') {
        if (ink.length < 3) return;
        actions.onCreateMarkup({ ...base, strokes: [ink.map(toPdf)] });
      } else if (tool === 'line' || tool === 'arrow') {
        if (Math.hypot(dx, dy) < 6) return;
        actions.onCreateMarkup({ ...base, p1: toPdf(start), p2: toPdf(cur) });
      } else if (tool === 'stamp') {
        // a click drops a stamp at its natural size, a drag sizes it
        const w = dx > 20 ? dx : 128 * viewport.scale;
        const h = dy > 10 ? dy : 38 * viewport.scale;
        const left = dx > 20 ? Math.min(start[0], cur[0]) : start[0] - w / 2;
        const top = dy > 10 ? Math.min(start[1], cur[1]) : start[1] - h / 2;
        actions.onCreateMarkup({ ...base, rect: rectFromScreen(viewport, left, top, w, h), stampKey: state.stampKey });
      } else if (tool === 'rect' || tool === 'ellipse') {
        if (dx < 6 || dy < 6) return;
        actions.onCreateMarkup({ ...base, rect: rectFromScreen(viewport, Math.min(start[0], cur[0]), Math.min(start[1], cur[1]), dx, dy) });
      } else if (tool === 'text' || tool === 'callout') {
        // a click makes a default-sized box; a drag sizes it
        const w = dx > 30 ? dx : 170 * viewport.scale;
        const h = dy > 14 ? dy : 22 * viewport.scale;
        const left = dx > 30 ? Math.min(start[0], cur[0]) : start[0];
        const top = dy > 14 ? Math.min(start[1], cur[1]) : start[1];
        const rect = rectFromScreen(viewport, left, top, w, h);
        actions.onMarkupDraft({ ...base, rect, stage: tool === 'callout' ? 'tip' : 'text' });
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function wireCloud(hit, overlays, idx, viewport, state, actions, local, toPdf, color, lw) {
  const svg = svgEl('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;' });
  const line = svgEl('polyline', { fill: 'rgba(228,66,52,0.06)', stroke: color, 'stroke-width': lw, 'stroke-dasharray': '6 4' });
  svg.appendChild(line);
  overlays.appendChild(svg);
  const pts = cloudPoints && cloudPoints.page === idx ? cloudPoints.pts : [];
  cloudPoints = { page: idx, pts };
  const draw = (cursor) => {
    const all = cursor ? [...pts, cursor] : pts;
    line.setAttribute('points', all.map((p) => p.join(',')).join(' '));
  };
  draw();
  hit.addEventListener('mousemove', (e) => { if (pts.length) draw(local(e)); });
  hit.addEventListener('click', (e) => {
    const p = local(e);
    if (e.detail >= 2) { finish(); return; } // double-click closes
    if (pts.length >= 3 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < 10) { finish(); return; }
    pts.push(p);
    draw(p);
  });
  function finish() {
    // a double-click also fires a single click first, which added a duplicate point
    while (pts.length > 1 && Math.hypot(pts[pts.length - 1][0] - pts[pts.length - 2][0], pts[pts.length - 1][1] - pts[pts.length - 2][1]) < 4) pts.pop();
    const done = pts.slice();
    cloudPoints = null;
    if (done.length >= 3) actions.onCreateMarkup({ kind: 'PolygonCloud', pageIndex: idx, points: done.map(toPdf) });
    else draw();
  }
  // Enter finishes, Escape abandons
  const key = (e) => {
    if (!hit.isConnected) { document.removeEventListener('keydown', key); return; }
    if (e.key === 'Enter' && pts.length >= 3) { e.preventDefault(); finish(); }
    if (e.key === 'Escape' && pts.length) { e.stopPropagation(); cloudPoints = null; pts.length = 0; draw(); }
  };
  document.addEventListener('keydown', key, true);
}

export function cancelCloud() { cloudPoints = null; }

// --- overlays: selection, handles, text editor for drafts -----------------------

function handleEl(x, y, cursor) {
  const h = document.createElement('div');
  h.style.cssText = `position:absolute;left:${x - 5}px;top:${y - 5}px;width:10px;height:10px;background:#fff;border:1.5px solid var(--accent);border-radius:2px;pointer-events:auto;cursor:${cursor};z-index:6;`;
  return h;
}

export function renderMarkupOverlays(overlays, idx, viewport, state, actions) {
  // --- in-progress draft: callout hint or the text editor
  const draft = state.markupDraft;
  if (draft && draft.pageIndex === idx) {
    if (draft.stage === 'tip') {
      const s = pdfRectToScreen(viewport, draft.rect);
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${s.left}px;top:${s.top}px;width:${s.width}px;height:${s.height}px;border:1.5px dashed ${previewColor(state)};pointer-events:none;background:rgba(255,255,255,0.7);`;
      overlays.appendChild(box);
      const hint = document.createElement('div');
      hint.style.cssText = `position:absolute;left:${s.left}px;top:${Math.max(0, s.top - 34)}px;background:var(--dark);color:#fff;font-size:11.5px;padding:6px 10px;border-radius:8px;pointer-events:auto;white-space:nowrap;`;
      hint.innerHTML = 'Click where the callout should point &nbsp;<button class="btn-secondary" style="height:22px;padding:0 8px;font-size:11px;" data-role="skip">No leader</button>';
      overlays.appendChild(hint);
      hint.querySelector('[data-role="skip"]').addEventListener('click', () => actions.onMarkupDraft({ ...draft, tip: null, stage: 'text', kind: 'FreeText' }));
    } else if (draft.stage === 'text') {
      renderDraftEditor(overlays, viewport, state, actions, draft);
    }
  }

  if (state.markupTool !== 'select') return;

  // --- existing markups on this page: selectable
  const mine = state.markups.filter((m) => m.pageIndex === idx && m.ref);
  const areaOf = (m) => (m.rect[2] - m.rect[0]) * (m.rect[3] - m.rect[1]);
  mine.sort((a, b) => areaOf(b) - areaOf(a)); // small ones last, so they sit on top
  for (const m of mine) {
    const sel = state.selectedMarkup === m.ref;
    const s = pdfRectToScreen(viewport, m.rect);
    if (m.line && (m.kind === 'Line' || m.kind === 'LineArrow')) {
      const [a, b] = [viewport.convertToViewportPoint(m.line[0], m.line[1]), viewport.convertToViewportPoint(m.line[2], m.line[3])];
      const svg = svgEl('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;' });
      const hitLine = svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: sel ? 'rgba(33,130,64,0.35)' : 'transparent', 'stroke-width': 12, 'stroke-linecap': 'round', style: 'pointer-events:stroke;cursor:move;' });
      svg.appendChild(hitLine);
      overlays.appendChild(svg);
      wireMove(hitLine, m, viewport, state, actions);
      if (sel) {
        for (const [pt, which] of [[a, 'p1'], [b, 'p2']]) {
          const h = handleEl(pt[0], pt[1], 'crosshair');
          overlays.appendChild(h);
          wireLineHandle(h, m, which, viewport, overlays, actions);
        }
      }
      continue;
    }
    const box = document.createElement('div');
    box.dataset.markup = m.ref;
    box.style.cssText = `position:absolute;left:${s.left}px;top:${s.top}px;width:${Math.max(8, s.width)}px;height:${Math.max(8, s.height)}px;pointer-events:auto;cursor:move;box-sizing:border-box;${sel ? 'outline:1.5px dashed var(--accent);outline-offset:1px;background:rgba(33,130,64,0.06);' : ''}`;
    box.title = `${m.type}${m.contents ? `: ${m.contents.slice(0, 80)}` : ''}`;
    overlays.appendChild(box);
    wireMove(box, m, viewport, state, actions);
    if (sel && ['FreeText', 'FreeTextCallout', 'Square', 'Circle', 'Stamp'].includes(m.kind)) {
      const target = m.box ? pdfRectToScreen(viewport, m.box) : s;
      const corners = [[target.left, target.top, 'nwse-resize', 'tl'], [target.left + target.width, target.top, 'nesw-resize', 'tr'],
        [target.left, target.top + target.height, 'nesw-resize', 'bl'], [target.left + target.width, target.top + target.height, 'nwse-resize', 'br']];
      for (const [x, y, cur, which] of corners) {
        const h = handleEl(x, y, cur);
        overlays.appendChild(h);
        wireResize(h, m, which, target, viewport, overlays, actions);
      }
    }
  }
}

function dragGesture(el, onMove, onEnd) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    const mv = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      onMove(dx, dy, ev);
    };
    const up = (ev) => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      onEnd(ev.clientX - x0, ev.clientY - y0, moved);
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });
}

function wireMove(el, m, viewport, state, actions) {
  // clicking selects; dragging moves (the element shows a ghost offset while dragging)
  dragGesture(el,
    (dx, dy) => {
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      if (el.tagName === 'line') el.setAttribute('transform', `translate(${dx} ${dy})`);
    },
    (dx, dy, moved) => {
      if (state.selectedMarkup !== m.ref) actions.onSelectMarkup(m.ref, m.pageIndex);
      if (!moved) return;
      const [px0, py0] = viewport.convertToPdfPoint(0, 0);
      const [px1, py1] = viewport.convertToPdfPoint(dx, dy);
      actions.onMoveMarkup(m.ref, px1 - px0, py1 - py0);
    });
  el.addEventListener('dblclick', () => actions.onSelectMarkup(m.ref, m.pageIndex, { focusText: true }));
}

function wireResize(handle, m, which, target, viewport, overlays, actions) {
  const ghost = document.createElement('div');
  ghost.style.cssText = 'position:absolute;pointer-events:none;border:1.5px dashed var(--accent);display:none;box-sizing:border-box;';
  overlays.appendChild(ghost);
  let rect = null;
  dragGesture(handle,
    (dx, dy) => {
      let { left, top, width, height } = target;
      let right = left + width, bottom = top + height;
      if (which.includes('l')) left += dx; else right += dx;
      if (which.includes('t')) top += dy; else bottom += dy;
      const L = Math.min(left, right), R = Math.max(left, right), T = Math.min(top, bottom), B = Math.max(top, bottom);
      rect = { left: L, top: T, width: Math.max(12, R - L), height: Math.max(12, B - T) };
      Object.assign(ghost.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    },
    (dx, dy, moved) => {
      ghost.remove();
      if (!moved || !rect) return;
      actions.onResizeMarkup(m.ref, { rect: rectFromScreen(viewport, rect.left, rect.top, rect.width, rect.height) });
    });
}

function wireLineHandle(handle, m, which, viewport, overlays, actions) {
  const svg = svgEl('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;' });
  const ghost = svgEl('line', { stroke: '#218240', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' });
  svg.appendChild(ghost);
  overlays.appendChild(svg);
  const a = viewport.convertToViewportPoint(m.line[0], m.line[1]);
  const b = viewport.convertToViewportPoint(m.line[2], m.line[3]);
  let np = null;
  dragGesture(handle,
    (dx, dy, ev) => {
      const fixed = which === 'p1' ? b : a;
      const orig = which === 'p1' ? a : b;
      np = [orig[0] + dx, orig[1] + dy];
      if (ev.shiftKey) np = snap45(fixed, np);
      ghost.setAttribute('x1', fixed[0]); ghost.setAttribute('y1', fixed[1]);
      ghost.setAttribute('x2', np[0]); ghost.setAttribute('y2', np[1]);
    },
    (dx, dy, moved) => {
      svg.remove();
      if (!moved || !np) return;
      const pt = viewport.convertToPdfPoint(np[0], np[1]);
      const patch = which === 'p1' ? { p1: pt, p2: [m.line[2], m.line[3]] } : { p1: [m.line[0], m.line[1]], p2: pt };
      actions.onResizeMarkup(m.ref, patch);
    });
}

function renderDraftEditor(overlays, viewport, state, actions, draft) {
  const key = JSON.stringify([draft.kind, draft.pageIndex, draft.rect, draft.p1]);
  if (key !== lastDraftKey || draftText === null) { draftText = draft.text || ''; lastDraftKey = key; }
  const isNote = draft.kind === 'Text';
  let s;
  if (isNote) {
    const p = viewport.convertToViewportPoint(draft.p1[0], draft.p1[1]);
    s = { left: p[0], top: p[1], width: 220, height: 80 };
  } else {
    s = pdfRectToScreen(viewport, draft.rect);
    s.height = Math.max(s.height, 34);
  }
  const color = previewColor(state);
  const fs = (state.markupStyle.fontSize || 10) * viewport.scale;
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:absolute;left:${s.left}px;top:${s.top}px;width:${Math.max(s.width, 120)}px;pointer-events:auto;z-index:7;`;
  const ta = document.createElement('textarea');
  ta.value = draftText;
  ta.placeholder = isNote ? 'Write a note…' : 'Type your text…';
  ta.style.cssText = `width:100%;min-height:${s.height}px;box-sizing:border-box;border:1.5px solid ${color};border-radius:2px;padding:3px;margin:0;background:#fff;outline:none;resize:both;font-family:Helvetica,Arial,sans-serif;font-size:${isNote ? 12 : fs}px;line-height:1.2;color:${color};`;
  ta.addEventListener('input', () => { draftText = ta.value; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
  });
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-top:5px;';
  row.innerHTML = `
    <button class="btn-primary" style="height:28px;padding:0 12px;font-size:11.5px;" data-role="apply">Add</button>
    <button class="btn-secondary" style="height:28px;padding:0 12px;font-size:11.5px;" data-role="cancel">Cancel</button>
    <span style="align-self:center;font-size:11px;color:var(--muted);">Ctrl+Enter to add</span>`;
  wrap.appendChild(ta);
  wrap.appendChild(row);
  overlays.appendChild(wrap);
  function commit() {
    const text = draftText || '';
    draftText = null;
    if (!text.trim()) { actions.onMarkupDraft(null); return; }
    actions.onCreateMarkup({ ...draft, text, stage: undefined });
  }
  function cancel() { draftText = null; actions.onMarkupDraft(null); }
  row.querySelector('[data-role="apply"]').addEventListener('click', commit);
  row.querySelector('[data-role="cancel"]').addEventListener('click', cancel);
  setTimeout(() => ta.focus(), 0);
}

export { STAMPS };
