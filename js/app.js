import { state, update, subscribe } from './state.js';
import { engine } from './pdf-engine.js';
import { renderToolbar } from './ui/toolbar.js';
import { renderSidebar } from './ui/sidebar.js';
import { renderCanvas, wireWorkspace, captureZoomAnchor, setScrollIntent, MIN_ZOOM, MAX_ZOOM } from './ui/canvas.js';
import { renderPropertiesPanel } from './ui/properties-panel.js';
import { openInsertPageModal, openMergeModal, openOcrModal, openExportOptionsModal } from './ui/modals.js';
import { supportsFileSystemAccess, pickPdfToOpen, pickPdfSaveLocation, writeToHandle } from './file-io.js';
import { buildDocxBlob, buildXlsxBlob } from './export-formats.js';

const els = {
  toolbar: document.getElementById('toolbar'),
  sidebar: document.getElementById('sidebar'),
  canvasArea: document.getElementById('canvas-area'),
  propertiesPanel: document.getElementById('properties-panel'),
  fileInput: document.getElementById('file-input'),
  openFileInput: document.getElementById('open-file-input'),
  imageInput: document.getElementById('image-input'),
  busyOverlay: document.getElementById('busy-overlay'),
  busyMessage: document.getElementById('busy-message'),
};

let pendingImageReplace = null; // { pageIndex, rect } captured just before opening the image file picker
let fileHandle = null; // FileSystemFileHandle for the open document, if opened/saved via that API

function resetToolOverlays() {
  update({ textEdit: null, redactDraft: null, selectedImage: null, cropDraft: null });
}

function confirmDiscardIfDirty(message) {
  return !state.isDirty || window.confirm(message);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function downloadBytes(bytes, filename) {
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function withBusy(message, fn) {
  update({ isBusy: true, busyMessage: message });
  try {
    return await fn();
  } finally {
    update({ isBusy: false, busyMessage: '' });
  }
}

async function refreshAll(preferredSelectedIndex) {
  const pageCount = engine.getPageCount();
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => engine.getPageInfo(i))
  );
  let selectedPageIndex = preferredSelectedIndex ?? state.selectedPageIndex;
  if (pageCount === 0) selectedPageIndex = null;
  else selectedPageIndex = clamp(selectedPageIndex ?? 0, 0, pageCount - 1);

  update({
    pageCount,
    pages,
    selectedPageIndex,
    isLoaded: pageCount > 0,
    fileName: engine.getFileName(),
    docRevision: state.docRevision + 1,
    isDirty: engine.isDirty(),
    canUndo: engine.canUndo(),
    canRedo: engine.canRedo(),
    checkedPages: new Set(),
  });
}

// Pages the page-level toolbar actions (delete / extract) apply to: the
// ctrl/shift-selected set if there is one, else just the open page.
function targetPages() {
  if (state.checkedPages.size) return [...state.checkedPages].sort((a, b) => a - b);
  return state.selectedPageIndex === null ? [] : [state.selectedPageIndex];
}

function containerCenter() {
  const r = els.canvasArea.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

async function openOrMergeFiles(fileList) {
  const files = Array.from(fileList).filter(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
  if (!files.length) return;

  await withBusy('Loading…', async () => {
    let start = 0;
    if (!state.isLoaded) {
      const first = files[0];
      await engine.loadFromBytes(new Uint8Array(await first.arrayBuffer()), first.name);
      update({ zoom: 1 });
      start = 1;
    }
    for (let i = start; i < files.length; i++) {
      const f = files[i];
      const extDoc = await engine.loadExternalDocument(new Uint8Array(await f.arrayBuffer()));
      await engine.mergeAppend(extDoc);
    }
    await refreshAll(state.isLoaded ? state.selectedPageIndex : 0);
  });
}

async function runOcrOnPages(indices, onProgress) {
  await withBusy('Running OCR…', async () => {
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      update({ busyMessage: `Running OCR on page ${idx + 1} (${i + 1} of ${indices.length})…` });
      await engine.runOcr(idx, (pct) => onProgress?.(idx, i + 1, indices.length, pct));
    }
    await refreshAll(state.selectedPageIndex);
  });
}

// Runs a Word/Excel conversion for the chosen pages and downloads the result,
// then tells the user about anything that couldn't be converted properly.
async function runConversion(label, ext, build, options) {
  const indices = options.scope === 'selected' && state.checkedPages.size
    ? [...state.checkedPages].sort((x, y) => x - y)
    : Array.from({ length: state.pageCount }, (_, i) => i);
  let warnings = [];
  try {
    await withBusy(`Converting to ${label}…`, async () => {
      const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
      const result = await build(indices, (n, total) => update({ busyMessage: `Converting to ${label} — page ${n} of ${total}…` }));
      warnings = result.warnings || [];
      downloadBlob(result.blob, `${base}.${ext}`);
    });
  } catch (err) {
    window.alert(`Could not convert to ${label}: ${err.message}`);
    return;
  }
  if (warnings.length) window.alert(`Exported, with notes:\n\n• ${[...new Set(warnings)].join('\n• ')}`);
}

const STICKY_TOOLS = ['select', 'pan', 'text', 'redact', 'image'];

const actions = {
  onToolClick(key) {
    if (STICKY_TOOLS.includes(key)) {
      update({ activeTool: key, textEdit: null, redactDraft: null, selectedImage: null, cropDraft: null });
      return;
    }
    if (key === 'deletePages') {
      actions.onDeleteSelectedPages();
      return;
    }
    if (key === 'extractPages') {
      actions.onExtractSelectedPages();
      return;
    }
    if (key === 'rotate') {
      if (state.selectedPageIndex === null) return;
      actions.onRotatePage(state.selectedPageIndex, 90);
      return;
    }
    if (key === 'insertPage') {
      openInsertPageModal({
        selectedPageIndex: state.selectedPageIndex,
        pageCount: state.pageCount,
        onDone: async (payload) => {
          await withBusy('Inserting page…', async () => {
            if (payload.type === 'blank') {
              await engine.insertBlankPage(payload.atIndex, payload.size);
            } else {
              await engine.insertPagesFrom(payload.externalDoc, payload.indices, payload.atIndex);
            }
            await refreshAll(payload.atIndex);
          });
        },
      });
      return;
    }
    if (key === 'merge') {
      openMergeModal({
        onDone: async ({ files }) => {
          await withBusy('Merging…', async () => {
            for (const f of files) {
              const extDoc = await engine.loadExternalDocument(f.bytes);
              await engine.mergeAppend(extDoc);
            }
            await refreshAll(state.selectedPageIndex);
          });
        },
      });
      return;
    }
    if (key === 'ocr') {
      // Never refuse: detection is a heuristic, and the user knows better than
      // it does whether a page is really a picture of text. Pages that look
      // scanned come pre-ticked; if none do, the open page is pre-ticked.
      const pages = state.pages.map((p, i) => ({
        index: i,
        scanned: !!p.likelyScanned,
        ocrDone: !!p.ocrDone,
        textChars: p.textChars || 0,
      }));
      openOcrModal({
        pages,
        currentIndex: state.selectedPageIndex ?? 0,
        onRun: (indices, onProgress) => runOcrOnPages(indices, onProgress),
      });
    }
  },

  onExport() {
    engine.getBytes().then((bytes) => {
      downloadBytes(bytes, state.fileName || 'document.pdf');
    });
  },

  onExportPage(idx) {
    engine.exportPages([idx]).then((bytes) => {
      const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
      downloadBytes(bytes, `${base}-page-${idx + 1}.pdf`);
    });
  },

  onExportWord() {
    if (!state.isLoaded) return;
    openExportOptionsModal({
      kind: 'word',
      pageCount: state.pageCount,
      selectedCount: state.checkedPages.size,
      onRun: (o) => runConversion('Word', 'docx', (indices, progress) => buildDocxBlob(engine, indices, o, progress), o),
    });
  },

  onExportExcel() {
    if (!state.isLoaded) return;
    openExportOptionsModal({
      kind: 'excel',
      pageCount: state.pageCount,
      selectedCount: state.checkedPages.size,
      onRun: (o) => runConversion('Excel', 'xlsx', (indices, progress) => buildXlsxBlob(engine, indices, o, progress), o),
    });
  },

  async onOpenFileClick() {
    if (!confirmDiscardIfDirty('You have unsaved changes. Open a different PDF and discard them?')) return;

    if (supportsFileSystemAccess()) {
      const result = await pickPdfToOpen();
      if (!result || result.cancelled) return;
      await withBusy('Loading…', async () => {
        await engine.loadFromBytes(result.bytes, result.name);
        fileHandle = result.handle;
        update({ activeTool: 'select', zoom: 1 });
        resetToolOverlays();
        await refreshAll(0);
      });
      return;
    }
    fileHandle = null;
    els.openFileInput.click();
  },

  onSelectPage(i) {
    if (state.pageCount === 0) return;
    update({ selectedPageIndex: clamp(i, 0, state.pageCount - 1) });
  },

  // Zoom by a factor around a screen point (the pointer for Ctrl+wheel, the
  // workspace centre for the +/- buttons) so what you're looking at stays put.
  onZoomBy(factor, point) {
    const next = clamp(Math.round(state.zoom * factor * 100) / 100, MIN_ZOOM, MAX_ZOOM);
    if (next === state.zoom) return;
    const p = point || containerCenter();
    captureZoomAnchor(els.canvasArea, p.x, p.y);
    update({ zoom: next });
  },

  onZoomStep(direction) {
    actions.onZoomBy(direction > 0 ? 1.25 : 1 / 1.25);
  },

  // 100% is "whole page fits the workspace", so fitting is just zoom = 1
  // with the view recentred.
  onFit() {
    if (state.zoom === 1) {
      // Nothing to re-render (the render signature is unchanged) — just recentre.
      els.canvasArea.scrollTo({ left: 0, top: 0 });
      return;
    }
    setScrollIntent('reset');
    update({ zoom: 1 });
  },

  // Plain click selects one page; Ctrl/Cmd-click toggles it in a multi-selection;
  // Shift-click selects the range from the open page.
  onPageClick(i, { ctrl = false, shift = false } = {}) {
    if (state.pageCount === 0) return;
    if (shift && state.selectedPageIndex !== null) {
      const from = Math.min(state.selectedPageIndex, i);
      const to = Math.max(state.selectedPageIndex, i);
      const range = new Set();
      for (let k = from; k <= to; k++) range.add(k);
      update({ checkedPages: range });
      return;
    }
    if (ctrl) {
      const next = new Set(state.checkedPages);
      if (!next.size && state.selectedPageIndex !== null) next.add(state.selectedPageIndex);
      if (next.has(i)) next.delete(i); else next.add(i);
      update({ checkedPages: next, selectedPageIndex: i });
      return;
    }
    update({ checkedPages: new Set(), selectedPageIndex: clamp(i, 0, state.pageCount - 1) });
  },

  async onDeleteSelectedPages() {
    const indices = targetPages();
    if (!indices.length) return;
    const label = indices.length === state.pageCount
      ? (indices.length === 1 ? 'Delete the only page in this document?' : `Delete all ${indices.length} pages in this document?`)
      : indices.length === 1 ? `Delete page ${indices[0] + 1}?` : `Delete ${indices.length} pages (${indices.map((n) => n + 1).join(', ')})?`;
    if (!window.confirm(label)) return;
    await withBusy('Deleting…', async () => {
      await engine.deletePages(indices);
      await refreshAll(Math.max(0, indices[0] - 1));
    });
  },

  async onExtractSelectedPages() {
    const indices = targetPages();
    if (!indices.length) return;
    await withBusy('Extracting…', async () => {
      const bytes = await engine.exportPages(indices);
      const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
      const tag = indices.length === 1 ? `page-${indices[0] + 1}` : `${indices.length}-pages`;
      downloadBytes(bytes, `${base}-${tag}.pdf`);
    });
  },

  async onRotatePage(idx, delta) {
    await withBusy('Rotating…', async () => {
      await engine.rotatePage(idx, delta);
      await refreshAll(idx);
    });
  },

  async onDeletePage(idx) {
    const label = state.pageCount <= 1 ? 'Delete the only page in this document?' : `Delete page ${idx + 1}?`;
    if (!window.confirm(label)) return;
    await withBusy('Deleting…', async () => {
      await engine.deletePage(idx);
      await refreshAll(Math.max(0, idx - 1));
    });
  },

  async onReorderPage(from, to) {
    if (from === to || from + 1 === to) return;
    const order = Array.from({ length: state.pageCount }, (_, i) => i);
    const [moved] = order.splice(from, 1);
    const insertAt = to > from ? to - 1 : to;
    order.splice(insertAt, 0, moved);
    await withBusy('Reordering…', async () => {
      await engine.reorderPages(order);
      await refreshAll(insertAt);
    });
  },

  onInsertPageClick() {
    actions.onToolClick('insertPage');
  },

  async onSetPageSize(idx, sizeKey) {
    await withBusy('Resizing…', async () => {
      await engine.setPageSize(idx, sizeKey);
      await refreshAll(idx);
    });
  },

  onRunOcr(idx) {
    return runOcrOnPages([idx]);
  },

  // --- Text editing ---------------------------------------------------

  async onStartTextEdit(pageIndex, run) {
    // Pick up the original's ink colour so the replacement matches it.
    const { inkHex } = await engine.sampleTextStyle(pageIndex, run.rect);
    update({
      textEdit: {
        pageIndex,
        rect: run.rect,
        text: run.text,
        fontFamily: run.fontFamily || 'Helvetica',
        fontSize: run.fontSize,
        color: inkHex,
        bold: run.bold,
        italic: run.italic,
        underline: false,
      },
    });
  },

  onTextStyleChange(patch) {
    if (!state.textEdit) return;
    update({ textEdit: { ...state.textEdit, ...patch } });
  },

  onCancelTextEdit() {
    update({ textEdit: null });
  },

  async onCommitTextEdit(pageIndex, rect, originalText, text, style) {
    await withBusy('Applying edit…', async () => {
      await engine.commitTextEdit(pageIndex, rect, originalText, text, style);
      update({ textEdit: null });
      await refreshAll(pageIndex);
    });
  },

  // --- Redaction --------------------------------------------------------

  onRedactDrawn(pageIndex, rect) {
    update({ redactDraft: { pageIndex, rect } });
  },

  onCancelRedaction() {
    update({ redactDraft: null });
  },

  onRedactColorChange(hex) {
    update({ redactColor: hex, redactFill: 'custom' });
  },

  onRedactFillChange(mode) {
    update({ redactFill: mode });
  },

  async onConfirmRedaction(pageIndex, rect) {
    await withBusy('Redacting…', async () => {
      // 'match' passes no colour: the engine samples the page background.
      const colorHex = state.redactFill === 'black' ? '#000000' : state.redactFill === 'custom' ? state.redactColor : null;
      await engine.applyRedaction(pageIndex, rect, colorHex);
      update({ redactDraft: null });
      await refreshAll(pageIndex);
    });
  },

  // --- Image editing ------------------------------------------------------

  onSelectImage(pageIndex, rect) {
    update({ selectedImage: pageIndex !== null ? { pageIndex, rect } : null, cropDraft: null });
  },

  onReplaceImageClick(pageIndex, rect) {
    pendingImageReplace = { pageIndex, rect };
    els.imageInput.click();
  },

  async onDeleteImage(pageIndex, rect) {
    if (!window.confirm('Permanently delete this image?')) return;
    await withBusy('Deleting image…', async () => {
      await engine.deleteImage(pageIndex, rect);
      update({ selectedImage: null });
      await refreshAll(pageIndex);
    });
  },

  onStartCrop(pageIndex, rect) {
    update({ cropDraft: { pageIndex, originalRect: rect } });
  },

  onCropDrawn(pageIndex, rect) {
    if (!state.cropDraft) return;
    update({ cropDraft: { ...state.cropDraft, keepRect: rect } });
  },

  onCancelCrop() {
    update({ cropDraft: null });
  },

  async onConfirmCrop(pageIndex, originalRect, keepRect) {
    await withBusy('Cropping…', async () => {
      await engine.cropImage(pageIndex, originalRect, keepRect);
      update({ cropDraft: null, selectedImage: null });
      await refreshAll(pageIndex);
    });
  },

  // --- Undo / redo ------------------------------------------------------

  async onUndo() {
    await withBusy('Undoing…', async () => {
      const ok = await engine.undo();
      if (!ok) return;
      resetToolOverlays();
      await refreshAll(state.selectedPageIndex);
    });
  },

  async onRedo() {
    await withBusy('Redoing…', async () => {
      const ok = await engine.redo();
      if (!ok) return;
      resetToolOverlays();
      await refreshAll(state.selectedPageIndex);
    });
  },

  // --- Save / Close -------------------------------------------------------

  async onSave() {
    if (!state.isLoaded) return;
    await withBusy('Saving…', async () => {
      const bytes = await engine.getBytes();
      let saved = false;

      if (fileHandle) {
        try {
          await writeToHandle(fileHandle, bytes);
          saved = true;
        } catch {
          // Handle may have lost permission or its file may have moved — fall back to Save As.
          const handle = await pickPdfSaveLocation(state.fileName || 'document.pdf', bytes);
          if (handle && !handle.cancelled) { fileHandle = handle; saved = true; }
          else if (!handle) { downloadBytes(bytes, state.fileName || 'document.pdf'); saved = true; }
        }
      } else if (supportsFileSystemAccess()) {
        const handle = await pickPdfSaveLocation(state.fileName || 'document.pdf', bytes);
        if (handle && !handle.cancelled) { fileHandle = handle; saved = true; }
        else if (!handle) { downloadBytes(bytes, state.fileName || 'document.pdf'); saved = true; }
      } else {
        downloadBytes(bytes, state.fileName || 'document.pdf');
        saved = true;
      }

      // A cancelled Save As dialog leaves nothing actually written — don't
      // clear the dirty flag for a save that didn't happen.
      if (saved) {
        engine.markSaved();
        update({ isDirty: engine.isDirty() });
      }
    });
  },

  async onCloseDocument() {
    if (!state.isLoaded) return;
    if (!confirmDiscardIfDirty('You have unsaved changes. Close this document and discard them?')) return;
    fileHandle = null;
    engine.close();
    update({
      pageCount: 0,
      pages: [],
      selectedPageIndex: null,
      isLoaded: false,
      fileName: null,
      docRevision: state.docRevision + 1,
      activeTool: 'select',
      isDirty: false,
      canUndo: false,
      canRedo: false,
      checkedPages: new Set(),
      zoom: 1,
      textEdit: null,
      redactDraft: null,
      selectedImage: null,
      cropDraft: null,
    });
  },
};

function render() {
  renderToolbar(els.toolbar, state, actions);
  renderSidebar(els.sidebar, state, actions);
  renderCanvas(els.canvasArea, state, actions);
  renderPropertiesPanel(els.propertiesPanel, state, actions);
  els.busyOverlay.classList.toggle('visible', state.isBusy);
  els.busyMessage.textContent = state.busyMessage;
}

subscribe(render);
render();
wireWorkspace(els.canvasArea, state, actions);

// Re-fit when the window or a side panel changes the workspace size.
let resizeRaf = 0;
new ResizeObserver(() => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; render(); });
}).observe(els.canvasArea);

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) openOrMergeFiles(els.fileInput.files);
  els.fileInput.value = '';
});

// Dedicated single-file input for the toolbar's "Open" action (browsers
// without the File System Access API) — always replaces the current
// document, unlike the drag-and-drop/empty-state input above which merges
// into an already-open one.
els.openFileInput.addEventListener('change', async () => {
  const file = els.openFileInput.files[0];
  els.openFileInput.value = '';
  if (!file) return;
  await withBusy('Loading…', async () => {
    await engine.loadFromBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    update({ activeTool: 'select', zoom: 1 });
    resetToolOverlays();
    await refreshAll(0);
  });
});

els.imageInput.addEventListener('change', async () => {
  const file = els.imageInput.files[0];
  const target = pendingImageReplace;
  pendingImageReplace = null;
  els.imageInput.value = '';
  if (!file || !target) return;
  const mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  await withBusy('Replacing image…', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await engine.replaceImage(target.pageIndex, target.rect, bytes, mimeType);
    update({ selectedImage: null });
    await refreshAll(target.pageIndex);
  });
});

els.canvasArea.addEventListener('dragover', (e) => e.preventDefault());
els.canvasArea.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) openOrMergeFiles(e.dataTransfer.files);
});

window.addEventListener('keydown', (e) => {
  // Escape always backs all the way out of whichever tool is active (Edit
  // Text, Redact, Edit Image) — works whether you're mid-edit (an input may
  // have already handled/bubbled the key) or just browsing, e.g. the Edit
  // Text tool's highlighted-runs view with nothing selected yet.
  if (e.key === 'Escape' && state.activeTool !== 'select') {
    e.preventDefault();
    actions.onToolClick('select');
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (state.isLoaded && ['0', '=', '+', '-'].includes(e.key)) {
    e.preventDefault(); // replace the browser's own page zoom with the document zoom
    if (e.key === '0') actions.onFit();
    else actions.onZoomStep(e.key === '-' ? -1 : 1);
    return;
  }
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return; // let the field handle its own undo/select-all
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); actions.onUndo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); actions.onRedo(); }
  else if (key === 's') { e.preventDefault(); actions.onSave(); }
  else if (key === 'o') { e.preventDefault(); actions.onOpenFileClick(); }
});

window.addEventListener('beforeunload', (e) => {
  if (!state.isDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
