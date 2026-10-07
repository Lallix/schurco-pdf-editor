import { engine } from '../pdf-engine.js';

// Zoom is a multiplier on "fit to screen": 100% always means the whole page
// fits the workspace, whatever the page size or window size.
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

// Breathing room kept around the sheet inside the scrollable workspace. The
// workspace (the "pasteboard") extends past the page edges on every side, so
// anything drawn or placed just outside the page stays visible.
const PAD_X = 56;
const PAD_Y = 72;

// Cap on backing-store pixels for the page canvas (CSS size is unaffected —
// beyond this the bitmap is simply stretched, softer but safe).
const MAX_CANVAS_PIXELS = 36e6;

let lastSignature = null;
// Bumped on every renderCanvas call; a call checks this after each await and
// bails if a newer one has since started. Without this, two overlapping
// renders (e.g. opening a file and immediately clicking a tool) can race:
// the older call's container.innerHTML already got replaced by the newer
// one, but it doesn't know that, so it goes on to wire click/drag listeners
// onto its own now-detached, invisible layer — leaving the actual visible
// one never wired up. That's exactly what "the tool looks selected but
// nothing happens" looks like from the outside.
let renderGeneration = 0;

// The text the user is actively typing during a text edit. Kept outside
// global state so keystrokes never trigger a re-render (which would rebuild
// the textarea and drop focus/cursor position) — only style changes from the
// properties panel do that, and those are infrequent discrete clicks.
let draftText = null;
let lastTextEditKey = null;

// One-shot hints consumed by the next render so zoom/page changes land
// where the user expects instead of snapping back to the top-left.
let pendingAnchor = null;   // keep the page point under the cursor fixed while zooming
let pendingScrollIntent = null; // 'top' | 'bottom' | 'reset'
let lastRenderedPage = null;
let lastRenderedLoaded = false;

// Page-bitmap painting state (see ensurePainted).
let desiredPaintKey = null;
let inflightPaintKey = null;
let activeRenderTask = null;

export function captureZoomAnchor(container, clientX, clientY) {
  const sheet = container.querySelector('.page-sheet');
  if (!sheet) return;
  const r = sheet.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  if (!r.width || !r.height) return;
  pendingAnchor = {
    fx: (clientX - r.left) / r.width,
    fy: (clientY - r.top) / r.height,
    ox: clientX - cr.left,
    oy: clientY - cr.top,
  };
}

export function setScrollIntent(intent) {
  pendingScrollIntent = intent;
}

function displaySize(info) {
  const w = info?.widthPt || 612;
  const h = info?.heightPt || 792;
  return info && info.rotation % 180 !== 0 ? [h, w] : [w, h];
}

// The scale (CSS px per PDF point) at which the whole page just fits the
// visible workspace, leaving the pasteboard margin around it.
function fitScale(container, pageW, pageH) {
  const availW = Math.max(160, container.offsetWidth - PAD_X * 2 - 2);
  const availH = Math.max(160, container.offsetHeight - PAD_Y * 2 - 2);
  return Math.min(availW / pageW, availH / pageH);
}

function pdfRectToScreen(viewport, rect) {
  const p1 = viewport.convertToViewportPoint(rect.x, rect.y);
  const p2 = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
  const left = Math.min(p1[0], p2[0]);
  const top = Math.min(p1[1], p2[1]);
  return { left, top, width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]) };
}

function pillTop(overlays, screen, pillHeight = 40) {
  const below = screen.top + screen.height + pillHeight < overlays.clientHeight;
  return below ? screen.top + screen.height + 6 : Math.max(0, screen.top - pillHeight);
}

function screenRectToPdf(viewport, left, top, width, height) {
  const [x1, y1] = viewport.convertToPdfPoint(left, top);
  const [x2, y2] = viewport.convertToPdfPoint(left + width, top + height);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export async function renderCanvas(container, state, actions) {
  const signature = JSON.stringify([
    state.isLoaded, state.selectedPageIndex, state.zoom, state.docRevision, state.activeTool,
    state.textEdit ? { r: state.textEdit.rect, s: state.textEdit.fontFamily, sz: state.textEdit.fontSize, c: state.textEdit.color, b: state.textEdit.bold, i: state.textEdit.italic, u: state.textEdit.underline } : null,
    state.redactDraft, state.redactFill, state.redactColor, state.selectedImage, state.cropDraft,
    container.offsetWidth, container.offsetHeight,
  ]);
  if (signature === lastSignature && container.dataset.rendered === '1') return;
  lastSignature = signature;
  container.dataset.rendered = '1';
  const myGeneration = ++renderGeneration;

  const textEditKey = state.textEdit ? `${state.textEdit.pageIndex}:${state.textEdit.rect.x}:${state.textEdit.rect.y}` : null;
  const isNewTextEdit = textEditKey !== lastTextEditKey;
  lastTextEditKey = textEditKey;
  if (!state.textEdit) draftText = null;

  if (!state.isLoaded) {
    lastRenderedLoaded = false;
    container.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/></svg>
        <h2>Open a PDF to get started</h2>
        <p>Drag and drop a file here, or choose one from your computer. Nothing is uploaded — everything happens in this browser.</p>
        <button class="open-file-btn" data-role="open-file">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>
          <span>Open PDF</span>
        </button>
      </div>
    `;
    container.querySelector('[data-role="open-file"]').addEventListener('click', () => actions.onOpenFileClick());
    return;
  }

  const idx = state.selectedPageIndex ?? 0;
  const [pageW, pageH] = displaySize(state.pages[idx]);
  const cssScale = fitScale(container, pageW, pageH) * state.zoom;
  const cssW = Math.round(pageW * cssScale);
  const cssH = Math.round(pageH * cssScale);

  // Keep the bitmap that's already on screen (when it's the same page) so a
  // zoom or an edit doesn't flash blank while the sharper one renders — the
  // old pixels just stretch to the new size until the new ones are ready.
  const oldCanvas = container.querySelector('.page-sheet');
  const reusableCanvas = oldCanvas && oldCanvas.dataset.page === String(idx) ? oldCanvas : null;
  const prevScrollLeft = container.scrollLeft;
  const prevScrollTop = container.scrollTop;

  container.innerHTML = `
    <div class="pasteboard">
      <div class="page-sheet-wrap">
        <canvas class="page-sheet"></canvas>
        <div class="page-hit" style="position:absolute;inset:0;"></div>
        <div class="page-overlays" style="position:absolute;inset:0;pointer-events:none;"></div>
      </div>
    </div>
    <div class="nav-pill">
      <button class="nav-pill-btn" data-role="prev" aria-label="Previous page" title="Previous page" ${idx <= 0 ? 'disabled' : ''}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <span class="nav-pill-label">Page ${idx + 1} of ${state.pageCount}</span>
      <button class="nav-pill-btn" data-role="next" aria-label="Next page" title="Next page" ${idx >= state.pageCount - 1 ? 'disabled' : ''}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <div class="nav-pill-divider"></div>
      <button class="nav-pill-btn" data-role="zoom-out" aria-label="Zoom out" title="Zoom out (Ctrl + mouse wheel)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>
      </button>
      <span class="nav-pill-label" style="min-width:42px;text-align:center;">${Math.round(state.zoom * 100)}%</span>
      <button class="nav-pill-btn" data-role="zoom-in" aria-label="Zoom in" title="Zoom in (Ctrl + mouse wheel)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="nav-pill-btn" data-role="fit" aria-label="Fit page to screen" title="Fit page to screen (Ctrl+0)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/></svg>
      </button>
    </div>
  `;

  container.querySelector('[data-role="prev"]').addEventListener('click', () => actions.onSelectPage(idx - 1));
  container.querySelector('[data-role="next"]').addEventListener('click', () => actions.onSelectPage(idx + 1));
  container.querySelector('[data-role="zoom-out"]').addEventListener('click', () => actions.onZoomStep(-1));
  container.querySelector('[data-role="zoom-in"]').addEventListener('click', () => actions.onZoomStep(1));
  container.querySelector('[data-role="fit"]').addEventListener('click', () => actions.onFit());

  const wrap = container.querySelector('.page-sheet-wrap');
  let canvas = container.querySelector('.page-sheet');
  if (reusableCanvas) {
    canvas.replaceWith(reusableCanvas);
    canvas = reusableCanvas;
  }
  const hit = container.querySelector('.page-hit');
  const overlays = container.querySelector('.page-overlays');

  // Size everything synchronously from the known page size, so the layout
  // (and therefore scrolling/centring) is correct immediately instead of
  // after the async viewport lookup below.
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  wrap.style.width = `${cssW}px`;
  wrap.style.height = `${cssH}px`;

  const pageChanged = lastRenderedPage !== idx || !lastRenderedLoaded;
  lastRenderedPage = idx;
  lastRenderedLoaded = true;
  if (pendingAnchor && !pageChanged) {
    container.scrollLeft = wrap.offsetLeft + pendingAnchor.fx * cssW - pendingAnchor.ox;
    container.scrollTop = wrap.offsetTop + pendingAnchor.fy * cssH - pendingAnchor.oy;
  } else if (pendingScrollIntent === 'bottom') {
    container.scrollLeft = prevScrollLeft;
    container.scrollTop = container.scrollHeight;
  } else if (pendingScrollIntent === 'top' || pendingScrollIntent === 'reset' || pageChanged) {
    container.scrollLeft = pendingScrollIntent === 'reset' || pageChanged ? 0 : prevScrollLeft;
    container.scrollTop = 0;
  } else {
    container.scrollLeft = prevScrollLeft;
    container.scrollTop = prevScrollTop;
  }
  pendingAnchor = null;
  pendingScrollIntent = null;

  // Viewport geometry is cheap (no canvas compositing) — get it and wire up
  // interactions immediately so the tool is usable right away, rather than
  // waiting on the much slower page.render() to paint pixels first.
  const viewport = await engine.getPageViewport(idx, cssW);
  if (myGeneration !== renderGeneration) return; // a newer render has since taken over this container

  // The viewport is authoritative (e.g. a CropBox differs from pdf-lib's size).
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  wrap.style.width = `${viewport.width}px`;
  wrap.style.height = `${viewport.height}px`;

  const textRuns = (state.activeTool === 'text' && !state.textEdit) ? await engine.getTextRuns(idx) : null;
  if (myGeneration !== renderGeneration) return;

  wireToolInteractions(hit, overlays, idx, viewport, state, actions);
  renderOverlays(overlays, idx, viewport, state, actions, isNewTextEdit, textRuns);
  ensurePainted(container, idx, viewport, state.docRevision);

  if (state.activeTool === 'select') {
    const layer = document.createElement('div');
    layer.className = 'text-layer';
    wrap.insertBefore(layer, overlays);
    buildTextLayer(layer, idx, viewport, myGeneration).catch(() => {});
  }
}

// Paints the page bitmap off-screen at hi-DPI and swaps it into the visible
// canvas in one synchronous step (resize + draw), so there's never a blank
// frame. A render for a size the user has already zoomed past is cancelled.
function ensurePainted(container, idx, viewport, revision) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const outputScale = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
  const key = `${idx}|${revision}|${Math.round(viewport.width)}|${outputScale.toFixed(2)}`;
  desiredPaintKey = key;
  const current = container.querySelector('.page-sheet');
  if (!current || current.dataset.paintKey === key) return;
  if (inflightPaintKey === key) return;

  try { activeRenderTask?.cancel(); } catch { /* already finished */ }
  inflightPaintKey = key;
  const off = document.createElement('canvas');
  engine.renderPageToCanvas(idx, off, viewport.width, {
    outputScale,
    onTask: (task) => { activeRenderTask = task; },
  }).then(() => {
    if (inflightPaintKey === key) inflightPaintKey = null;
    if (desiredPaintKey !== key) return;
    const live = container.querySelector('.page-sheet');
    if (!live) return;
    live.width = off.width;
    live.height = off.height;
    live.getContext('2d').drawImage(off, 0, 0);
    live.dataset.paintKey = key;
    live.dataset.page = String(idx);
    off.width = off.height = 0;
  }).catch(() => {
    if (inflightPaintKey === key) inflightPaintKey = null;
  });
}

// Transparent, selectable text laid exactly over the rendered glyphs — this
// is what makes the Select tool able to highlight and copy page text.
async function buildTextLayer(layer, idx, viewport, generation) {
  const { items, styles } = await engine.getTextItems(idx);
  if (generation !== renderGeneration) return;
  const m = viewport.transform;
  const spans = [];
  for (const item of items) {
    const t = item.transform;
    const tx = [
      m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
      m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
      m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5],
    ];
    const fh = Math.hypot(tx[2], tx[3]);
    if (!fh || !isFinite(fh)) continue;
    const angle = Math.atan2(tx[1], tx[0]);
    const style = styles[item.fontName] || {};
    const ascent = fh * (style.ascent ? style.ascent : style.descent ? 1 + style.descent : 0.85);
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.cssText = `left:${tx[4] + ascent * Math.sin(angle)}px;top:${tx[5] - ascent * Math.cos(angle)}px;font-size:${fh}px;font-family:${style.fontFamily || 'sans-serif'};`;
    spans.push({ span, angle, target: item.width * viewport.scale });
    layer.appendChild(span);
    // Line breaks, so copied text keeps its lines instead of running together.
    if (item.hasEOL) layer.appendChild(document.createElement('br'));
  }
  // Measure everything in one pass (a single layout), then apply the
  // horizontal stretch that makes each span as wide as its real glyphs.
  const widths = spans.map((s) => s.span.offsetWidth);
  spans.forEach((s, i) => {
    const k = widths[i] > 0 && s.target > 0 ? Math.min(6, Math.max(0.15, s.target / widths[i])) : 1;
    s.span.style.transform = `rotate(${s.angle}rad) scaleX(${k})`;
  });
}

function wireToolInteractions(hit, overlays, idx, viewport, state, actions) {
  const tool = state.activeTool;
  hit.style.cursor = tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';

  if (tool === 'image') {
    hit.addEventListener('click', async (e) => {
      if (state.cropDraft) return;
      const rectC = hit.getBoundingClientRect();
      const [px, py] = viewport.convertToPdfPoint(e.clientX - rectC.left, e.clientY - rectC.top);
      const rects = await engine.getImageRects(idx);
      const found = rects.find((r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height);
      actions.onSelectImage(found ? idx : null, found || null);
    });
  }

  if (tool === 'redact' || (tool === 'image' && state.cropDraft)) {
    let dragBox = null;
    let startX = 0, startY = 0;
    const constrainRect = state.cropDraft ? pdfRectToScreen(viewport, state.cropDraft.originalRect) : null;

    hit.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = hit.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      if (constrainRect) {
        startX = Math.min(Math.max(startX, constrainRect.left), constrainRect.left + constrainRect.width);
        startY = Math.min(Math.max(startY, constrainRect.top), constrainRect.top + constrainRect.height);
      }
      dragBox = document.createElement('div');
      dragBox.style.cssText = `position:absolute;border:2px dashed ${tool === 'redact' ? '#C0453A' : '#218240'};background:${tool === 'redact' ? 'rgba(192,69,58,0.18)' : 'rgba(33,130,64,0.15)'};left:${startX}px;top:${startY}px;width:0;height:0;pointer-events:none;`;
      overlays.appendChild(dragBox);

      const onMove = (ev) => {
        const r2 = hit.getBoundingClientRect();
        let cx = ev.clientX - r2.left;
        let cy = ev.clientY - r2.top;
        // The page is the only valid target, but the pointer may wander onto
        // the pasteboard mid-drag — clamp to the sheet.
        cx = Math.min(Math.max(cx, 0), r2.width);
        cy = Math.min(Math.max(cy, 0), r2.height);
        if (constrainRect) {
          cx = Math.min(Math.max(cx, constrainRect.left), constrainRect.left + constrainRect.width);
          cy = Math.min(Math.max(cy, constrainRect.top), constrainRect.top + constrainRect.height);
        }
        const left = Math.min(cx, startX);
        const top = Math.min(cy, startY);
        dragBox.style.left = left + 'px';
        dragBox.style.top = top + 'px';
        dragBox.style.width = Math.abs(cx - startX) + 'px';
        dragBox.style.height = Math.abs(cy - startY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const l = parseFloat(dragBox.style.left);
        const t = parseFloat(dragBox.style.top);
        const w = parseFloat(dragBox.style.width);
        const h = parseFloat(dragBox.style.height);
        dragBox.remove();
        if (w < 6 || h < 6) return; // too small, ignore accidental clicks
        const pdfRect = screenRectToPdf(viewport, l, t, w, h);
        if (tool === 'redact') actions.onRedactDrawn(idx, pdfRect);
        else actions.onCropDrawn(idx, pdfRect);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

function renderOverlays(overlays, idx, viewport, state, actions, isNewTextEdit, textRuns) {
  overlays.innerHTML = '';

  // Dimming layers are clipped to the page; everything else may overhang the
  // page edge onto the pasteboard.
  const clip = document.createElement('div');
  clip.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
  overlays.appendChild(clip);

  // --- Edit Text: dim the page and highlight only the editable runs, so it's
  // obvious what can be clicked instead of hunting for it with a crosshair.
  if (textRuns && state.activeTool === 'text') {
    const scrim = document.createElement('div');
    scrim.style.cssText = 'position:absolute;inset:0;background:rgba(21,24,26,0.45);pointer-events:none;';
    clip.appendChild(scrim);

    for (const run of textRuns) {
      const screen = pdfRectToScreen(viewport, run.rect);
      const pad = 3;
      const box = document.createElement('button');
      box.type = 'button';
      box.setAttribute('aria-label', `Edit text: ${run.text}`);
      box.style.cssText = `position:absolute;left:${screen.left - pad}px;top:${screen.top - pad}px;width:${screen.width + pad * 2}px;height:${screen.height + pad * 2}px;background:rgba(255,255,255,0.96);border:1.5px solid var(--accent);border-radius:3px;padding:0;cursor:pointer;pointer-events:auto;`;
      box.addEventListener('click', () => actions.onStartTextEdit(idx, run));
      overlays.appendChild(box);
    }
  }

  if (state.textEdit && state.textEdit.pageIndex === idx) {
    // Keep the page dimmed behind the single active edit too, for visual
    // consistency with the browsing view above.
    const scrim = document.createElement('div');
    scrim.style.cssText = 'position:absolute;inset:0;background:rgba(21,24,26,0.45);pointer-events:none;';
    clip.appendChild(scrim);

    const te = state.textEdit;
    if (isNewTextEdit || draftText === null) draftText = te.text;
    const screen = pdfRectToScreen(viewport, te.rect);
    // Sized generously (not just the original run's tight box) since the new
    // text, font or size may not match the original glyphs' footprint —
    // a single-line input, since a text run is never a wrapped paragraph.
    const boxWidth = Math.max(screen.width * 1.6, 160);
    const boxHeight = Math.max(screen.height, te.fontSize * viewport.scale * 1.4);
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${screen.left}px;top:${screen.top}px;width:${boxWidth}px;height:${boxHeight}px;pointer-events:auto;`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = draftText;
    input.style.cssText = `width:100%;height:100%;border:1.5px solid var(--accent);border-radius:3px;padding:0 2px;margin:0;box-sizing:border-box;background:#fff;outline:none;${cssFontString(te, viewport.scale)}`;
    input.addEventListener('input', () => { draftText = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      // Escape is handled globally (see app.js) to fully exit the Edit Text
      // tool — just prevent any native input behaviour here and let it bubble.
      if (e.key === 'Escape') { e.preventDefault(); }
    });
    box.appendChild(input);

    const toolbar = document.createElement('div');
    const below = screen.top + boxHeight + 34 < overlays.clientHeight;
    toolbar.style.cssText = `position:absolute;left:${screen.left}px;top:${below ? screen.top + boxHeight + 6 : Math.max(0, screen.top - 40)}px;display:flex;gap:6px;pointer-events:auto;`;
    toolbar.innerHTML = `
      <button class="btn-primary" style="height:28px;padding:0 12px;font-size:11.5px;" data-role="commit">Apply</button>
      <button class="btn-secondary" style="height:28px;padding:0 12px;font-size:11.5px;" data-role="cancel">Cancel</button>
    `;
    overlays.appendChild(box);
    overlays.appendChild(toolbar);

    function commit() {
      const text = draftText;
      draftText = null;
      actions.onCommitTextEdit(te.pageIndex, te.rect, te.text, text, {
        fontFamily: te.fontFamily, fontSize: te.fontSize, color: te.color, bold: te.bold, italic: te.italic, underline: te.underline,
      });
    }
    function cancel() {
      draftText = null;
      actions.onCancelTextEdit();
    }
    toolbar.querySelector('[data-role="commit"]').addEventListener('click', commit);
    toolbar.querySelector('[data-role="cancel"]').addEventListener('click', cancel);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  if (state.redactDraft && state.redactDraft.pageIndex === idx) {
    const screen = pdfRectToScreen(viewport, state.redactDraft.rect);
    const box = document.createElement('div');
    // "Match page" can't be previewed exactly (the colour is sampled when you
    // confirm), so it's shown as a marked-up region; black/custom show the real fill.
    const fillCss = state.redactFill === 'black' ? '#000'
      : state.redactFill === 'custom' ? state.redactColor
      : 'rgba(192,69,58,0.2)';
    const border = state.redactFill === 'match' ? '2px dashed #C0453A' : 'none';
    box.style.cssText = `position:absolute;left:${screen.left}px;top:${screen.top}px;width:${screen.width}px;height:${screen.height}px;background:${fillCss};border:${border};box-sizing:border-box;pointer-events:none;`;
    overlays.appendChild(box);

    const pill = document.createElement('div');
    pill.style.cssText = `position:absolute;left:${screen.left}px;top:${pillTop(overlays, screen)}px;display:flex;gap:8px;align-items:center;background:var(--dark);padding:8px 10px;border-radius:10px;pointer-events:auto;box-shadow:0 8px 20px rgba(20,22,20,0.25);white-space:nowrap;`;
    pill.innerHTML = `
      <span style="color:#fff;font-size:11.5px;">Permanently remove this area?</span>
      <button class="btn-primary" style="height:26px;padding:0 10px;font-size:11px;background:#C0453A;" data-role="confirm">Redact</button>
      <button class="btn-secondary" style="height:26px;padding:0 10px;font-size:11px;" data-role="cancel">Cancel</button>
    `;
    overlays.appendChild(pill);
    pill.querySelector('[data-role="confirm"]').addEventListener('click', () => actions.onConfirmRedaction(idx, state.redactDraft.rect));
    pill.querySelector('[data-role="cancel"]').addEventListener('click', () => actions.onCancelRedaction());
  }

  if (state.selectedImage && state.selectedImage.pageIndex === idx && !state.cropDraft) {
    const screen = pdfRectToScreen(viewport, state.selectedImage.rect);
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${screen.left}px;top:${screen.top}px;width:${screen.width}px;height:${screen.height}px;pointer-events:none;`;
    const corner = (l, t) => `<div style="position:absolute;left:${l}px;top:${t}px;width:9px;height:9px;border-radius:2px;background:var(--accent);"></div>`;
    box.innerHTML = corner(-5, -5) + corner(screen.width - 4, -5) + corner(-5, screen.height - 4) + corner(screen.width - 4, screen.height - 4);

    const actionsBar = document.createElement('div');
    actionsBar.style.cssText = `position:absolute;top:10px;right:10px;display:flex;gap:4px;background:#fff;padding:5px;border-radius:7px;box-shadow:0 4px 10px rgba(20,22,20,0.12);pointer-events:auto;`;
    actionsBar.innerHTML = `
      <button class="thumb-action-btn" data-role="replace" aria-label="Replace image" title="Replace image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-soft)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg></button>
      <button class="thumb-action-btn" data-role="crop" aria-label="Crop image" title="Crop image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-soft)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg></button>
      <button class="thumb-action-btn danger" data-role="delete" aria-label="Delete image" title="Delete image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C0453A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 13h8l1-13"/></svg></button>
    `;
    box.appendChild(actionsBar);
    overlays.appendChild(box);

    actionsBar.querySelector('[data-role="replace"]').addEventListener('click', () => actions.onReplaceImageClick(idx, state.selectedImage.rect));
    actionsBar.querySelector('[data-role="crop"]').addEventListener('click', () => actions.onStartCrop(idx, state.selectedImage.rect));
    actionsBar.querySelector('[data-role="delete"]').addEventListener('click', () => actions.onDeleteImage(idx, state.selectedImage.rect));
  }

  if (state.cropDraft && state.cropDraft.pageIndex === idx) {
    const screen = pdfRectToScreen(viewport, state.cropDraft.originalRect);

    if (!state.cropDraft.keepRect) {
      const hint = document.createElement('div');
      hint.style.cssText = `position:absolute;left:${screen.left}px;top:${Math.max(0, screen.top - 30)}px;background:var(--dark);color:#fff;font-size:11.5px;padding:6px 10px;border-radius:8px;pointer-events:none;`;
      hint.textContent = 'Drag within the image to choose the part to keep';
      overlays.appendChild(hint);
    } else {
      const keepScreen = pdfRectToScreen(viewport, state.cropDraft.keepRect);
      const mark = document.createElement('div');
      mark.style.cssText = `position:absolute;left:${keepScreen.left}px;top:${keepScreen.top}px;width:${keepScreen.width}px;height:${keepScreen.height}px;border:2px solid var(--accent);box-shadow:0 0 0 2000px rgba(17,17,17,0.45);pointer-events:none;`;
      clip.appendChild(mark);

      const pill = document.createElement('div');
      pill.style.cssText = `position:absolute;left:${screen.left}px;top:${pillTop(overlays, screen)}px;display:flex;gap:8px;align-items:center;background:var(--dark);padding:8px 10px;border-radius:10px;pointer-events:auto;box-shadow:0 8px 20px rgba(20,22,20,0.25);white-space:nowrap;`;
      pill.innerHTML = `
        <span style="color:#fff;font-size:11.5px;">Keep only this part of the image?</span>
        <button class="btn-primary" style="height:26px;padding:0 10px;font-size:11px;" data-role="confirm">Crop</button>
        <button class="btn-secondary" style="height:26px;padding:0 10px;font-size:11px;" data-role="cancel">Cancel</button>
      `;
      overlays.appendChild(pill);
      pill.querySelector('[data-role="confirm"]').addEventListener('click', () => actions.onConfirmCrop(idx, state.cropDraft.originalRect, state.cropDraft.keepRect));
      pill.querySelector('[data-role="cancel"]').addEventListener('click', () => actions.onCancelCrop());
    }
  }
}

function cssFontString(te, scale = 1) {
  const family = te.fontFamily === 'Times New Roman' ? "'Times New Roman', serif" : te.fontFamily === 'Courier' ? "'Courier New', monospace" : "Arial, sans-serif";
  return `font-family:${family};font-size:${te.fontSize * scale}px;color:${te.color};font-weight:${te.bold ? 700 : 400};font-style:${te.italic ? 'italic' : 'normal'};text-decoration:${te.underline ? 'underline' : 'none'};`;
}

// --- Workspace-level input (wired once): wheel scroll/zoom and panning ---------

let spaceDown = false;

export function wireWorkspace(container, state, actions) {
  let zoomFactor = 1;
  let zoomPoint = null;
  let zoomRaf = 0;
  let lastScrollTs = 0;
  let lastWheelTs = 0;
  let lastFlipTs = 0;
  let flipAccum = 0;

  container.addEventListener('scroll', () => { lastScrollTs = performance.now(); }, { passive: true });

  container.addEventListener('wheel', (e) => {
    if (!state.isLoaded) return;

    // Ctrl/Cmd + wheel (and trackpad pinch, which browsers report the same
    // way) zooms toward the pointer. Coalesced to one zoom step per frame.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0025;
      zoomFactor *= Math.exp(-e.deltaY * unit);
      zoomPoint = { x: e.clientX, y: e.clientY };
      if (!zoomRaf) {
        zoomRaf = requestAnimationFrame(() => {
          zoomRaf = 0;
          const f = zoomFactor, p = zoomPoint;
          zoomFactor = 1;
          actions.onZoomBy(f, p);
        });
      }
      return;
    }

    // Plain wheel scrolls the page natively. Once you hit the top/bottom edge
    // (or the whole page already fits), a further deliberate scroll turns to
    // the next/previous page.
    if (e.shiftKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const dir = Math.sign(e.deltaY);
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
    const atTop = container.scrollTop <= 0;
    if (!((dir > 0 && atBottom) || (dir < 0 && atTop))) return;
    const idx = state.selectedPageIndex ?? 0;
    const next = idx + dir;
    if (next < 0 || next >= state.pageCount) return;
    const now = performance.now();
    if (now - lastWheelTs > 300) flipAccum = 0;
    lastWheelTs = now;
    if (now - lastScrollTs < 180 || now - lastFlipTs < 450) return; // still coasting into the edge
    flipAccum += Math.abs(e.deltaY);
    if (flipAccum < 40) return;
    flipAccum = 0;
    lastFlipTs = now;
    e.preventDefault();
    setScrollIntent(dir > 0 ? 'top' : 'bottom');
    actions.onSelectPage(next);
  }, { passive: false });

  // Pan: the Hand tool, the middle mouse button (any tool), or Space + drag.
  container.addEventListener('mousedown', (e) => {
    if (!state.isLoaded) return;
    const wantsPan = e.button === 1 || (e.button === 0 && (state.activeTool === 'pan' || spaceDown));
    if (!wantsPan) return;
    if (e.target.closest('button, input, textarea, select, .nav-pill')) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startL = container.scrollLeft, startT = container.scrollTop;
    document.body.classList.add('panning');
    const onMove = (ev) => {
      container.scrollLeft = startL - (ev.clientX - startX);
      container.scrollTop = startT - (ev.clientY - startY);
    };
    const onUp = () => {
      document.body.classList.remove('panning');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || typing() || !state.isLoaded) return;
    e.preventDefault(); // Space would otherwise scroll the workspace a page down
    if (!spaceDown) { spaceDown = true; document.body.classList.add('space-pan'); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    spaceDown = false;
    document.body.classList.remove('space-pan');
  });
  window.addEventListener('blur', () => { spaceDown = false; document.body.classList.remove('space-pan'); });
}
