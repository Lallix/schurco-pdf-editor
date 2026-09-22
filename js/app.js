import { state, update, subscribe } from './state.js';
import { engine } from './pdf-engine.js';
import { renderToolbar } from './ui/toolbar.js';
import { renderSidebar } from './ui/sidebar.js';
import { renderCanvas } from './ui/canvas.js';
import { renderPropertiesPanel } from './ui/properties-panel.js';
import { openInsertPageModal, openMergeModal } from './ui/modals.js';

const els = {
  toolbar: document.getElementById('toolbar'),
  sidebar: document.getElementById('sidebar'),
  canvasArea: document.getElementById('canvas-area'),
  propertiesPanel: document.getElementById('properties-panel'),
  fileInput: document.getElementById('file-input'),
  busyOverlay: document.getElementById('busy-overlay'),
  busyMessage: document.getElementById('busy-message'),
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
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
  });
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

const actions = {
  onToolClick(key) {
    if (key === 'select') {
      update({ activeTool: 'select' });
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
    // Edit text / Redact / Edit images / OCR are disabled in Phase 1 — no-op.
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

  onOpenFileClick() {
    els.fileInput.click();
  },

  onSelectPage(i) {
    if (state.pageCount === 0) return;
    update({ selectedPageIndex: clamp(i, 0, state.pageCount - 1) });
  },

  onZoom(delta) {
    update({ zoom: clamp(Math.round((state.zoom + delta) * 100) / 100, 0.25, 3) });
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

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) openOrMergeFiles(els.fileInput.files);
  els.fileInput.value = '';
});

els.canvasArea.addEventListener('dragover', (e) => e.preventDefault());
els.canvasArea.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) openOrMergeFiles(e.dataTransfer.files);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
