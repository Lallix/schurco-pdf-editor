import { engine } from '../pdf-engine.js';

const BASE_WIDTH_AT_100 = 600;

let lastSignature = null;
// Bumped on every renderCanvas call; a call checks this after each await and
// bails if a newer one has since started. Without this, two overlapping
// renders (e.g. opening a file and immediately clicking a tool) can race:
// the older call's container.innerHTML already got replaced by the newer
// one, but it doesn't know that, so it goes on to wire click/drag listeners
// onto its own now-detached, invisible canvas — leaving the actual visible
// one never wired up. That's exactly what "the tool looks selected but
// nothing happens" looks like from the outside.
let renderGeneration = 0;

// The text the user is actively typing during a text edit. Kept outside
// global state so keystrokes never trigger a re-render (which would rebuild
// the textarea and drop focus/cursor position) — only style changes from the
// properties panel do that, and those are infrequent discrete clicks.
let draftText = null;
let lastTextEditKey = null;

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
    state.redactDraft, state.selectedImage, state.cropDraft,
  ]);
  if (signature === lastSignature && container.dataset.rendered === '1') {
    window.__renderCanvasSkipped = (window.__renderCanvasSkipped || 0) + 1;
    return;
  }
  lastSignature = signature;
  container.dataset.rendered = '1';
  const myGeneration = ++renderGeneration;
  window.__renderCanvasProceeded = (window.__renderCanvasProceeded || 0) + 1;

  const textEditKey = state.textEdit ? `${state.textEdit.pageIndex}:${state.textEdit.rect.x}:${state.textEdit.rect.y}` : null;
  const isNewTextEdit = textEditKey !== lastTextEditKey;
  lastTextEditKey = textEditKey;
  if (!state.textEdit) draftText = null;

  if (!state.isLoaded) {
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
  const targetWidth = BASE_WIDTH_AT_100 * state.zoom;

  container.innerHTML = `
    <div class="page-sheet-wrap" style="position:relative;overflow:hidden;">
      <canvas class="page-sheet"></canvas>
      <div class="page-overlays" style="position:absolute;inset:0;pointer-events:none;"></div>
    </div>
    <div class="nav-pill">
      <button class="nav-pill-btn" data-role="prev" aria-label="Previous page" ${idx <= 0 ? 'disabled' : ''}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <span class="nav-pill-label">Page ${idx + 1} of ${state.pageCount}</span>
      <button class="nav-pill-btn" data-role="next" aria-label="Next page" ${idx >= state.pageCount - 1 ? 'disabled' : ''}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <div class="nav-pill-divider"></div>
      <button class="nav-pill-btn" data-role="zoom-out" aria-label="Zoom out">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>
      </button>
      <span class="nav-pill-label">${Math.round(state.zoom * 100)}%</span>
      <button class="nav-pill-btn" data-role="zoom-in" aria-label="Zoom in">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  `;

  container.querySelector('[data-role="prev"]').addEventListener('click', () => actions.onSelectPage(idx - 1));
  container.querySelector('[data-role="next"]').addEventListener('click', () => actions.onSelectPage(idx + 1));
  container.querySelector('[data-role="zoom-out"]').addEventListener('click', () => actions.onZoom(-0.1));
  container.querySelector('[data-role="zoom-in"]').addEventListener('click', () => actions.onZoom(0.1));

  const canvas = container.querySelector('.page-sheet');
  const overlays = container.querySelector('.page-overlays');

  // Viewport geometry is cheap (no canvas compositing) — get it and wire up
  // interactions immediately so the tool is usable right away, rather than
  // waiting on the much slower page.render() below to paint pixels first.
  // Without this split, a slow render left the canvas with no listeners at
  // all for however long painting took — the tool would look selected but
  // silently do nothing if you moved fast (or the page was complex/slow).
  const viewport = await engine.getPageViewport(idx, targetWidth);
  if (myGeneration !== renderGeneration) return; // a newer render has since taken over this container

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const textRuns = (state.activeTool === 'text' && !state.textEdit) ? await engine.getTextRuns(idx) : null;
  if (myGeneration !== renderGeneration) return;

  wireToolInteractions(canvas, overlays, idx, viewport, state, actions);
  renderOverlays(overlays, idx, viewport, state, actions, isNewTextEdit, textRuns);

  engine.renderPageToCanvas(idx, canvas, targetWidth).catch(() => {});
}

function wireToolInteractions(canvas, overlays, idx, viewport, state, actions) {
  canvas.style.cursor = state.activeTool === 'select' ? 'default' : 'crosshair';

  if (state.activeTool === 'image') {
    canvas.addEventListener('click', async (e) => {
      if (state.cropDraft) return;
      const rectC = canvas.getBoundingClientRect();
      const x = (e.clientX - rectC.left) * (canvas.width / rectC.width);
      const y = (e.clientY - rectC.top) * (canvas.height / rectC.height);
      const [px, py] = viewport.convertToPdfPoint(x, y);
      const rects = await engine.getImageRects(idx);
      const hit = rects.find((r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height);
      actions.onSelectImage(hit ? idx : null, hit || null);
    });
  }

  if (state.activeTool === 'redact' || (state.activeTool === 'image' && state.cropDraft)) {
    let dragBox = null;
    let startX = 0, startY = 0;
    const constrainRect = state.cropDraft ? pdfRectToScreen(viewport, state.cropDraft.originalRect) : null;

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      if (constrainRect) {
        startX = Math.min(Math.max(startX, constrainRect.left), constrainRect.left + constrainRect.width);
        startY = Math.min(Math.max(startY, constrainRect.top), constrainRect.top + constrainRect.height);
      }
      dragBox = document.createElement('div');
      dragBox.style.cssText = `position:absolute;border:2px dashed ${state.activeTool === 'redact' ? '#111' : '#218240'};background:${state.activeTool === 'redact' ? 'rgba(17,17,17,0.35)' : 'rgba(33,130,64,0.15)'};left:${startX}px;top:${startY}px;width:0;height:0;pointer-events:none;`;
      overlays.appendChild(dragBox);

      const onMove = (ev) => {
        const r2 = canvas.getBoundingClientRect();
        let cx = ev.clientX - r2.left;
        let cy = ev.clientY - r2.top;
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
      const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const l = parseFloat(dragBox.style.left);
        const t = parseFloat(dragBox.style.top);
        const w = parseFloat(dragBox.style.width);
        const h = parseFloat(dragBox.style.height);
        dragBox.remove();
        if (w < 6 || h < 6) return; // too small, ignore accidental clicks
        const pdfRect = screenRectToPdf(viewport, l, t, w, h);
        if (state.activeTool === 'redact') actions.onRedactDrawn(idx, pdfRect);
        else actions.onCropDrawn(idx, pdfRect);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

function renderOverlays(overlays, idx, viewport, state, actions, isNewTextEdit, textRuns) {
  overlays.innerHTML = '';

  // --- Edit Text: dim the page and highlight only the editable runs, so it's
  // obvious what can be clicked instead of hunting for it with a crosshair.
  if (textRuns && state.activeTool === 'text') {
    const scrim = document.createElement('div');
    scrim.style.cssText = 'position:absolute;inset:0;background:rgba(21,24,26,0.45);pointer-events:none;';
    overlays.appendChild(scrim);

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
    overlays.appendChild(scrim);

    const te = state.textEdit;
    if (isNewTextEdit || draftText === null) draftText = te.text;
    const screen = pdfRectToScreen(viewport, te.rect);
    // Sized generously (not just the original run's tight box) since the new
    // text, font or size may not match the original glyphs' footprint —
    // a single-line input, since a text run is never a wrapped paragraph.
    const boxWidth = Math.max(screen.width * 1.6, 160);
    const boxHeight = Math.max(screen.height, te.fontSize * 1.4);
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${screen.left}px;top:${screen.top}px;width:${boxWidth}px;height:${boxHeight}px;pointer-events:auto;`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = draftText;
    input.style.cssText = `width:100%;height:100%;border:1.5px solid var(--accent);border-radius:3px;padding:0 2px;margin:0;box-sizing:border-box;background:#fff;outline:none;${cssFontString(te)}`;
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
    box.style.cssText = `position:absolute;left:${screen.left}px;top:${screen.top}px;width:${screen.width}px;height:${screen.height}px;background:rgba(17,17,17,0.85);pointer-events:none;`;
    overlays.appendChild(box);

    const pill = document.createElement('div');
    pill.style.cssText = `position:absolute;left:${screen.left}px;top:${pillTop(overlays, screen)}px;display:flex;gap:8px;align-items:center;background:var(--dark);padding:8px 10px;border-radius:10px;pointer-events:auto;box-shadow:0 8px 20px rgba(20,22,20,0.25);`;
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
      <button class="thumb-action-btn" data-role="replace" aria-label="Replace image"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-soft)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg></button>
      <button class="thumb-action-btn" data-role="crop" aria-label="Crop image"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-soft)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg></button>
      <button class="thumb-action-btn danger" data-role="delete" aria-label="Delete image"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#C0453A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 13h8l1-13"/></svg></button>
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
      overlays.appendChild(mark);

      const pill = document.createElement('div');
      pill.style.cssText = `position:absolute;left:${screen.left}px;top:${pillTop(overlays, screen)}px;display:flex;gap:8px;align-items:center;background:var(--dark);padding:8px 10px;border-radius:10px;pointer-events:auto;box-shadow:0 8px 20px rgba(20,22,20,0.25);`;
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

function cssFontString(te) {
  const family = te.fontFamily === 'Times New Roman' ? "'Times New Roman', serif" : te.fontFamily === 'Courier' ? "'Courier New', monospace" : "Arial, sans-serif";
  return `font-family:${family};font-size:${te.fontSize}px;color:${te.color};font-weight:${te.bold ? 700 : 400};font-style:${te.italic ? 'italic' : 'normal'};text-decoration:${te.underline ? 'underline' : 'none'};`;
}
