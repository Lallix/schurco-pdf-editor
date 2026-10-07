// Wraps pdf.js (rendering) and pdf-lib (mutation/export). The two libraries
// parse the file independently, so after any mutation we re-save the pdf-lib
// document to bytes and reload a fresh pdf.js document from those bytes for
// display. That round trip is what keeps thumbnails/canvas in sync with edits.

import * as pdfjsLib from './vendor/pdf.min.mjs';
import { OPS } from './vendor/pdf.min.mjs';
import { PDFDocument, degrees, rgb, StandardFonts } from './vendor/pdf-lib.esm.min.js';
import Tesseract from './vendor/tesseract/tesseract.esm.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './js/vendor/pdf.worker.min.mjs';

// pdf.js needs these for anything beyond the simplest PDFs: wasmUrl for its
// WASM image decoders (JBIG2, OpenJPEG/JPX, qcms colour management —
// without it, e.g. a JBIG2-masked scanned image silently fails to decode
// and renders washed out instead of throwing), cMapUrl for CJK/non-Latin
// embedded fonts, and standardFontDataUrl for text using a standard font
// that isn't embedded in the file. None of these have a default — pdf.js
// throws (or, worse, quietly degrades) unless every one is provided.
// pdf.js validates these as real http(s) URLs (see isValidFetchUrl in its
// source) — a plain relative string like './js/vendor/...' fails that check
// silently and falls back to a broken code path, so these must be resolved
// to absolute URLs against the page's own location first.
const abs = (path) => new URL(path, window.location.href).href;
const PDFJS_DOC_OPTIONS = {
  wasmUrl: abs('./js/vendor/pdfjs-data/wasm/'),
  cMapUrl: abs('./js/vendor/pdfjs-data/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: abs('./js/vendor/pdfjs-data/standard_fonts/'),
};

// All three vendored locally (runtime, WASM core, English trained data) —
// no network call is ever made for OCR. corePath points at one specific
// prebuilt core (SIMD+LSTM) rather than a directory of every variant, which
// is a deliberate size trade-off (~4MB instead of ~15MB): every browser this
// app targets (current Chrome/Edge on staff Windows machines) supports WASM
// SIMD, so the other combinations Tesseract.js could auto-pick never apply.
const TESSERACT_PATHS = {
  workerPath: './js/vendor/tesseract/worker.min.js',
  corePath: './js/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  langPath: './js/vendor/tesseract/lang-data',
};

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
};

// Page resolution used when a dirty page is rasterized for export — about
// 180 DPI (72 * 2.5), sharp enough for on-screen and print.
const FLATTEN_SCALE = 2.5;

// Page resolution fed to Tesseract for OCR — higher than the flatten scale
// since recognition accuracy benefits from more pixels per glyph.
const OCR_SCALE = 3;

const FONT_VARIANTS = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  'Times New Roman': [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

function pickStandardFont(family, bold, italic) {
  const variants = FONT_VARIANTS[family] || FONT_VARIANTS.Helvetica;
  const i = (bold ? 1 : 0) + (italic ? 2 : 0);
  return variants[i];
}

function hexToRgb01(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;
}

// Tesseract's `blocks` output nests words under block -> paragraph -> line
// -> word; there's no flat `data.words` on the result. Lines are kept (with
// their baseline) because placing every word on its line's shared baseline
// gives far cleaner text than each word's own bounding-box bottom, which
// wanders with descenders (g, y, p) and makes one line look like several.
function flattenOcrLines(data) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) lines.push(line);
    }
  }
  return lines;
}

// Composes a `cm` operand (applied first) with the current CTM — standard
// PDF affine matrix concatenation, used to walk the operator list's save/
// restore/transform stack when locating image placements.
function composeMatrix(m, cur) {
  const [a1, b1, c1, d1, e1, f1] = m;
  const [a2, b2, c2, d2, e2, f2] = cur;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

function applyMatrix([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}

// Most common colour among the pixels `include(x, y)` selects, bucketed to 5
// bits per channel so antialiasing noise doesn't split a flat colour, then
// averaged within the winning bucket for the exact shade.
function dominantColor(data, w, h, include) {
  const buckets = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!include(x, y)) continue;
      const i = (y * w + x) * 4;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      const b = buckets.get(key);
      if (b) { b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; }
      else buckets.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
    }
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best) return null;
  return { r: best.r / best.n / 255, g: best.g / best.n / 255, b: best.b / best.n / 255 };
}

function ptToMm(pt) {
  return Math.round(pt * 0.352778);
}

function describeSize(widthPt, heightPt) {
  const w = Math.round(widthPt);
  const h = Math.round(heightPt);
  for (const [name, [sw, sh]] of Object.entries(PAGE_SIZES)) {
    const match = (a, b) => Math.abs(a - b) <= 2;
    if ((match(w, Math.round(sw)) && match(h, Math.round(sh))) ||
        (match(w, Math.round(sh)) && match(h, Math.round(sw)))) {
      return `${name} (${ptToMm(widthPt)} × ${ptToMm(heightPt)} mm)`;
    }
  }
  return `Custom (${ptToMm(widthPt)} × ${ptToMm(heightPt)} mm)`;
}

class PdfEngine {
  constructor() {
    this.doc = null;       // pdf-lib PDFDocument — source of truth for edits
    this.renderDoc = null; // pdf.js document — used for rendering only
    this.fileName = null;
    // Pages with edits/redactions drawn live (so they stay fully editable in
    // the working doc) that must be rasterized to guarantee removal of the
    // original content once the file is actually exported. See getBytes().
    this.dirtyPages = new Set();
    // PDF-space rects already covered by an edit, per page index — excluded
    // from future hit-testing so a replaced/redacted run can't be re-clicked.
    this.coveredRegions = new Map();
    // Pages OCR has been run on — so they stop being flagged as "scanned".
    this.ocrPages = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
  }

  static MAX_HISTORY = 20;

  async loadFromBytes(bytes, fileName) {
    this.doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    this.fileName = fileName;
    this.dirtyPages = new Set();
    this.coveredRegions = new Map();
    this.ocrPages = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    await this._refreshRenderDoc();
  }

  close() {
    this.doc = null;
    this.renderDoc = null;
    this.fileName = null;
    this.dirtyPages = new Set();
    this.coveredRegions = new Map();
    this.ocrPages = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
  }

  // Snapshots the document + edit bookkeeping onto the undo stack — called at
  // the top of every mutating method, before the change is made. A fresh
  // action always invalidates redo history, same as any standard editor.
  async _snapshot() {
    if (!this.doc) return;
    this.undoStack.push({
      bytes: await this.doc.save(),
      dirtyPages: new Set(this.dirtyPages),
      ocrPages: new Set(this.ocrPages),
      coveredRegions: new Map(Array.from(this.coveredRegions, ([k, v]) => [k, v.slice()])),
    });
    if (this.undoStack.length > PdfEngine.MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  async _currentSnapshot() {
    return {
      bytes: await this.doc.save(),
      dirtyPages: new Set(this.dirtyPages),
      ocrPages: new Set(this.ocrPages),
      coveredRegions: new Map(Array.from(this.coveredRegions, ([k, v]) => [k, v.slice()])),
    };
  }

  async _restoreSnapshot(snapshot) {
    this.doc = await PDFDocument.load(snapshot.bytes, { ignoreEncryption: true });
    this.dirtyPages = new Set(snapshot.dirtyPages);
    this.ocrPages = new Set(snapshot.ocrPages || []);
    this.coveredRegions = new Map(Array.from(snapshot.coveredRegions, ([k, v]) => [k, v.slice()]));
    await this._refreshRenderDoc();
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  isDirty() { return this.dirty; }
  markSaved() { this.dirty = false; }

  async undo() {
    if (!this.canUndo()) return false;
    this.redoStack.push(await this._currentSnapshot());
    await this._restoreSnapshot(this.undoStack.pop());
    this.dirty = true;
    return true;
  }

  async redo() {
    if (!this.canRedo()) return false;
    this.undoStack.push(await this._currentSnapshot());
    await this._restoreSnapshot(this.redoStack.pop());
    this.dirty = true;
    return true;
  }

  // Remaps dirty/covered-region bookkeeping when page indices shift (insert,
  // delete, reorder). `mapFn(oldIndex) => newIndex | null` (null = dropped).
  _remapIndices(mapFn) {
    const newDirty = new Set();
    for (const idx of this.dirtyPages) {
      const m = mapFn(idx);
      if (m !== null) newDirty.add(m);
    }
    this.dirtyPages = newDirty;

    const newOcr = new Set();
    for (const idx of this.ocrPages) {
      const m = mapFn(idx);
      if (m !== null) newOcr.add(m);
    }
    this.ocrPages = newOcr;

    const newCovered = new Map();
    for (const [idx, rects] of this.coveredRegions) {
      const m = mapFn(idx);
      if (m !== null) newCovered.set(m, rects);
    }
    this.coveredRegions = newCovered;
  }

  // `originalText`, when set, means this covered region should only exclude
  // hit-testing for text matching that exact original string — so a freshly
  // *replaced* run (different text, same spot) stays clickable and can be
  // re-edited again, while the stale original can't resurface. Redaction and
  // image edits omit it, since those regions should stay excluded outright.
  _markDirty(index, rect, originalText) {
    this.dirtyPages.add(index);
    if (!this.coveredRegions.has(index)) this.coveredRegions.set(index, []);
    if (rect) this.coveredRegions.get(index).push({ ...rect, originalText });
  }

  async _refreshRenderDoc() {
    const bytes = await this.doc.save();
    this.renderDoc = await pdfjsLib.getDocument({ data: bytes, ...PDFJS_DOC_OPTIONS }).promise;
  }

  getPageCount() {
    return this.doc ? this.doc.getPageCount() : 0;
  }

  getFileName() {
    return this.fileName;
  }

  async getPageInfo(index) {
    const page = this.doc.getPage(index);
    const { width, height } = page.getSize();
    const rotation = page.getRotation().angle;
    const { scanned: likelyScanned, textChars } = await this._scanStatus(index);
    return {
      widthPt: width,
      heightPt: height,
      rotation,
      sizeLabel: describeSize(width, height),
      likelyScanned,
      textChars,
      ocrDone: this.ocrPages.has(index),
    };
  }

  // A page "needs OCR" when it has no real text layer. That's not only
  // "zero characters": scanners/PDF printers often leave a few stray characters
  // (a stamp, a footer, a signature block) on top of what is really a full-page
  // picture — so a page that is mostly one big image with little text counts too.
  async _scanStatus(index) {
    try {
      const page = await this.renderDoc.getPage(index + 1);
      const content = await page.getTextContent();
      const textChars = content.items.map((i) => i.str).join('').trim().length;
      if (this.ocrPages.has(index)) return { scanned: false, textChars };
      if (textChars < 3) return { scanned: true, textChars };
      if (textChars >= 400) return { scanned: false, textChars };
      const vp = page.getViewport({ scale: 1 });
      const imgs = await this.getImageRects(index);
      const biggest = imgs.reduce((m, r) => Math.max(m, (r.width * r.height) / (vp.width * vp.height)), 0);
      return { scanned: biggest >= 0.6, textChars };
    } catch {
      return { scanned: false, textChars: 0 };
    }
  }

  async renderPageToCanvas(index, canvas, targetWidth, opts) {
    return renderPageOfDoc(this.renderDoc, index, canvas, targetWidth, opts);
  }

  // Raw pdf.js text items + style table, for building the selectable text layer.
  async getTextItems(index) {
    const page = await this.renderDoc.getPage(index + 1);
    const { items, styles } = await page.getTextContent();
    return { items: items.filter((i) => i.str), styles: styles || {} };
  }

  // Computes the viewport without painting anything — cheap (no canvas
  // compositing), so UI code can wire up click/drag interactions and know
  // page geometry immediately, instead of waiting on the much slower
  // page.render() call to paint pixels before the page becomes interactive.
  async getPageViewport(index, targetWidth) {
    const page = await this.renderDoc.getPage(index + 1);
    const baseViewport = page.getViewport({ scale: 1 });
    return page.getViewport({ scale: targetWidth / baseViewport.width });
  }

  async rotatePage(index, deltaDegrees) {
    await this._snapshot();
    const page = this.doc.getPage(index);
    const current = page.getRotation().angle;
    const next = (((current + deltaDegrees) % 360) + 360) % 360;
    page.setRotation(degrees(next));
    await this._refreshRenderDoc();
  }

  async deletePage(index) {
    await this._snapshot();
    this.doc.removePage(index);
    this._remapIndices((i) => (i === index ? null : i > index ? i - 1 : i));
    await this._refreshRenderDoc();
  }

  // Deletes several pages under a single undo step.
  async deletePages(indices) {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    if (!sorted.length) return;
    await this._snapshot();
    for (let k = sorted.length - 1; k >= 0; k--) this.doc.removePage(sorted[k]);
    const gone = new Set(sorted);
    this._remapIndices((i) => {
      if (gone.has(i)) return null;
      let shift = 0;
      for (const d of sorted) if (d < i) shift++;
      return i - shift;
    });
    await this._refreshRenderDoc();
  }

  async insertBlankPage(atIndex, sizeKey = 'A4') {
    await this._snapshot();
    const size = PAGE_SIZES[sizeKey] || PAGE_SIZES.A4;
    this.doc.insertPage(atIndex, size);
    this._remapIndices((i) => (i >= atIndex ? i + 1 : i));
    await this._refreshRenderDoc();
  }

  async setPageSize(index, sizeKey) {
    await this._snapshot();
    const [w, h] = PAGE_SIZES[sizeKey] || PAGE_SIZES.A4;
    this.doc.getPage(index).setSize(w, h);
    await this._refreshRenderDoc();
  }

  // Reorders pages by rebuilding the page tree in the given order — pdf-lib
  // has no direct "move" API, so this is the standard technique.
  async reorderPages(newOrder) {
    await this._snapshot();
    const rebuilt = await PDFDocument.create();
    const copied = await rebuilt.copyPages(this.doc, newOrder);
    copied.forEach((p) => rebuilt.addPage(p));
    this.doc = rebuilt;

    const oldToNew = new Map(newOrder.map((oldIdx, newIdx) => [oldIdx, newIdx]));
    this._remapIndices((i) => (oldToNew.has(i) ? oldToNew.get(i) : null));

    await this._refreshRenderDoc();
  }

  async loadExternalDocument(bytes) {
    return PDFDocument.load(bytes, { ignoreEncryption: true });
  }

  async insertPagesFrom(externalDoc, pageIndices, atIndex) {
    await this._snapshot();
    const copied = await this.doc.copyPages(externalDoc, pageIndices);
    copied.forEach((p, i) => this.doc.insertPage(atIndex + i, p));
    this._remapIndices((i) => (i >= atIndex ? i + copied.length : i));
    await this._refreshRenderDoc();
  }

  async mergeAppend(externalDoc) {
    await this._snapshot();
    const indices = externalDoc.getPageIndices();
    const copied = await this.doc.copyPages(externalDoc, indices);
    copied.forEach((p) => this.doc.addPage(p));
    await this._refreshRenderDoc();
  }

  async exportPages(indices) {
    const exportDoc = await this._buildExportDoc();
    const out = await PDFDocument.create();
    const copied = await out.copyPages(exportDoc, indices);
    copied.forEach((p) => out.addPage(p));
    return out.save();
  }

  async getBytes() {
    const exportDoc = await this._buildExportDoc();
    return exportDoc.save();
  }

  // Builds the document actually handed to save()/download. Pages with live
  // edits are rasterized here, on a throwaway copy, so the working doc (and
  // its original hit-testable text) stays intact for further editing — only
  // the file that actually leaves the browser gets the content stripped.
  async _buildExportDoc() {
    if (this.dirtyPages.size === 0) return this.doc;

    const allIndices = this.doc.getPageIndices();
    const cleanIndices = allIndices.filter((i) => !this.dirtyPages.has(i));
    const exportDoc = await PDFDocument.create();
    const copiedClean = cleanIndices.length ? await exportDoc.copyPages(this.doc, cleanIndices) : [];
    const cleanByIndex = new Map(cleanIndices.map((idx, k) => [idx, copiedClean[k]]));

    for (const idx of allIndices) {
      if (this.dirtyPages.has(idx)) {
        const { pngBytes, width, height } = await this._rasterizePage(idx);
        const img = await exportDoc.embedPng(pngBytes);
        const page = exportDoc.addPage([width, height]);
        page.drawImage(img, { x: 0, y: 0, width, height });
      } else {
        exportDoc.addPage(cleanByIndex.get(idx));
      }
    }
    return exportDoc;
  }

  async _rasterizePage(index) {
    const page = await this.renderDoc.getPage(index + 1);
    const viewport = page.getViewport({ scale: FLATTEN_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    return { pngBytes, width: viewport.width / FLATTEN_SCALE, height: viewport.height / FLATTEN_SCALE };
  }

  // Loads a pdf.js render doc for an external file's bytes (e.g. for the
  // "insert pages from another PDF" picker), independent of the working doc.
  async loadExternalRenderDoc(bytes) {
    return pdfjsLib.getDocument({ data: bytes, ...PDFJS_DOC_OPTIONS }).promise;
  }

  // --- Text editing (redact-and-replace) -----------------------------------

  // Returns clickable text runs in PDF-space, excluding anything already
  // covered by a prior edit/redaction on this page. Font/size are read
  // straight off pdf.js's text content — an approximation of the original
  // (arbitrary embedded fonts can't generally be reused for new text), which
  // is the "approximate match" the redact-and-replace model calls for.
  async getTextRuns(index) {
    const page = await this.renderDoc.getPage(index + 1);
    const { items, styles } = await page.getTextContent();
    const covered = this.coveredRegions.get(index) || [];
    const runs = [];
    const fontCache = new Map();
    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      const [, b, , d, e, f] = item.transform;
      const height = item.height || Math.hypot(b, d) || 10;
      const width = item.width || 1;
      const rect = { x: e, y: f - height * 0.25, width, height: height * 1.15 };
      const cx = e + width / 2;
      const isCovered = covered.some((r) => {
        if (!pointInRect(cx, f, r)) return false;
        return r.originalText === undefined || r.originalText === item.str;
      });
      if (isCovered) continue;
      const style = (styles && styles[item.fontName]) || {};
      let guess = fontCache.get(item.fontName);
      if (!guess) {
        guess = await this.getFontGuess(index, item.fontName, style.fontFamily);
        fontCache.set(item.fontName, guess);
      }
      runs.push({
        text: item.str,
        rect,
        fontSize: Math.max(4, Math.round(height * 10) / 10),
        fontFamily: guess.family,
        bold: guess.bold,
        italic: guess.italic,
      });
    }
    return runs;
  }

  // Groups the page's text items into reading-order lines by clustering on
  // baseline Y — a single visual line is often split into several pdf.js
  // items by font/spacing changes. Used by the Word/Excel exporters, which
  // need whole lines rather than individual runs.
  async getTextLines(index) {
    const page = await this.renderDoc.getPage(index + 1);
    const { items } = await page.getTextContent();
    const lines = [];
    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      const y = item.transform[5];
      const fontSize = item.height || Math.hypot(item.transform[1], item.transform[3]) || 10;
      let line = lines.find((l) => Math.abs(l.y - y) < Math.max(2, fontSize * 0.4));
      if (!line) {
        line = { y, fontSize, items: [] };
        lines.push(line);
      }
      line.fontSize = Math.max(line.fontSize, fontSize);
      line.items.push(item);
    }
    lines.sort((a, b) => b.y - a.y); // PDF y is bottom-up; descending = top to bottom
    return lines
      .map((line) => {
        line.items.sort((a, b) => a.transform[4] - b.transform[4]);
        let text = '';
        let lastEndX = null;
        for (const item of line.items) {
          const x = item.transform[4];
          if (lastEndX !== null && x - lastEndX > line.fontSize * 0.3) text += ' ';
          text += item.str;
          lastEndX = x + (item.width || 0);
        }
        return { text: text.trim(), y: line.y, x: line.items[0].transform[4], fontSize: line.fontSize };
      })
      .filter((l) => l.text);
  }

  // Samples the current page's rendered appearance around `rect` to pick a
  // plausible cover colour (so a patch on a tinted report page blends in
  // instead of leaving a stark white/black box).
  async sampleBackgroundColor(index, rect) {
    try {
      const { data, w, h, inner } = await this._renderRegion(index, rect);
      const bg = dominantColor(data, w, h, (x, y) => x < inner.x0 || x >= inner.x1 || y < inner.y0 || y >= inner.y1)
        || dominantColor(data, w, h, () => true);
      return bg || { r: 1, g: 1, b: 1 };
    } catch {
      return { r: 1, g: 1, b: 1 };
    }
  }

  // Renders just the neighbourhood of `rect` and returns its pixels, plus
  // where `rect` itself sits inside that crop. Far cheaper than rendering the
  // whole page (an A3 drawing is millions of pixels) just to read a few.
  async _renderRegion(index, rect, margin = 6, scale = 2) {
    const page = await this.renderDoc.getPage(index + 1);
    const base = page.getViewport({ scale });
    const p1 = base.convertToViewportPoint(rect.x, rect.y);
    const p2 = base.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
    const minX = Math.min(p1[0], p2[0]), maxX = Math.max(p1[0], p2[0]);
    const minY = Math.min(p1[1], p2[1]), maxY = Math.max(p1[1], p2[1]);
    const L = Math.max(0, Math.floor(minX) - margin);
    const T = Math.max(0, Math.floor(minY) - margin);
    const R = Math.min(Math.floor(base.width), Math.ceil(maxX) + margin);
    const B = Math.min(Math.floor(base.height), Math.ceil(maxY) + margin);
    const w = Math.max(1, R - L), h = Math.max(1, B - T);
    const viewport = page.getViewport({ scale, offsetX: -L, offsetY: -T });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const data = ctx.getImageData(0, 0, w, h).data;
    return {
      data, w, h, viewport,
      inner: { x0: Math.floor(minX) - L, y0: Math.floor(minY) - T, x1: Math.ceil(maxX) - L, y1: Math.ceil(maxY) - T },
    };
  }

  // The area to paint over when replacing a text run: the run's box, pulled
  // in from any edge where it would otherwise paint over a ruled line (e.g.
  // the borders of a title-block cell the text sits in) — a text run's box is
  // the full line height, which often reaches past the cell the glyphs are in.
  // A "line" is a pixel row/column that is inked across nearly the whole crop.
  async sampleCoverArea(index, rect) {
    const fallback = { bg: { r: 1, g: 1, b: 1 }, cover: rect };
    try {
      const { data, w, h, inner, viewport } = await this._renderRegion(index, rect);
      const outside = (x, y) => x < inner.x0 || x >= inner.x1 || y < inner.y0 || y >= inner.y1;
      const bg = dominantColor(data, w, h, outside) || fallback.bg;
      const br = bg.r * 255, bgG = bg.g * 255, bb = bg.b * 255;
      const isInk = (x, y) => {
        const i = (y * w + x) * 4;
        return Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb) > 90;
      };
      const rowInk = new Array(h).fill(0);
      const colInk = new Array(w).fill(0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isInk(x, y)) { rowInk[y]++; colInk[x]++; }
      const LINE = 0.75;
      const isRowLine = (y) => rowInk[y] >= w * LINE;
      const isColLine = (x) => colInk[x] >= h * LINE;
      let { x0, y0, x1, y1 } = inner;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
      const innerW = x1 - x0, innerH = y1 - y0;
      // Only edges: a line must sit in the outer 40% of the box to count as its border.
      for (let y = y0; y < y0 + innerH * 0.4; y++) if (isRowLine(y)) y0 = Math.max(y0, y + 2);
      for (let y = y1 - 1; y >= y1 - innerH * 0.4; y--) if (isRowLine(y)) y1 = Math.min(y1, y - 1);
      for (let x = x0; x < x0 + innerW * 0.4; x++) if (isColLine(x)) x0 = Math.max(x0, x + 2);
      for (let x = x1 - 1; x >= x1 - innerW * 0.4; x--) if (isColLine(x)) x1 = Math.min(x1, x - 1);
      if (x1 <= x0 || y1 <= y0) return { bg, cover: rect };
      const [ax, ay] = viewport.convertToPdfPoint(x0, y0);
      const [bx, by] = viewport.convertToPdfPoint(x1, y1);
      return { bg, cover: { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) } };
    } catch {
      return fallback;
    }
  }

  // Background plus ink colour of a text run, so a replacement can look like
  // the original. Ink = average of the pixels inside the run that differ most
  // from the background.
  async sampleTextStyle(index, rect) {
    const fallback = { bg: { r: 1, g: 1, b: 1 }, inkHex: '#000000' };
    try {
      const { data, w, h, inner } = await this._renderRegion(index, rect);
      const bg = dominantColor(data, w, h, (x, y) => x < inner.x0 || x >= inner.x1 || y < inner.y0 || y >= inner.y1)
        || fallback.bg;
      const br = bg.r * 255, bgG = bg.g * 255, bb = bg.b * 255;
      const px = [];
      for (let y = Math.max(0, inner.y0); y < Math.min(h, inner.y1); y++) {
        for (let x = Math.max(0, inner.x0); x < Math.min(w, inner.x1); x++) {
          const i = (y * w + x) * 4;
          const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb);
          px.push([d, data[i], data[i + 1], data[i + 2]]);
        }
      }
      if (!px.length) return { bg, inkHex: fallback.inkHex };
      px.sort((a, b) => b[0] - a[0]);
      const top = px.slice(0, Math.max(1, Math.floor(px.length * 0.08)));
      if (top[0][0] < 90) return { bg, inkHex: fallback.inkHex }; // barely any contrast — keep default
      const sum = top.reduce((acc, p) => [acc[0] + p[1], acc[1] + p[2], acc[2] + p[3]], [0, 0, 0]);
      const hex = sum.map((v) => Math.round(v / top.length).toString(16).padStart(2, '0')).join('');
      return { bg, inkHex: `#${hex}` };
    } catch {
      return fallback;
    }
  }

  // Maps pdf.js's view of a run's font onto the closest of the three standard
  // families we can actually embed, plus bold/italic. pdf.js knows the real
  // font (name, serif/mono flags); fall back to matching on the name itself.
  async getFontGuess(index, fontName, styleFamily) {
    let family = 'Helvetica', bold = false, italic = false;
    try {
      const page = await this.renderDoc.getPage(index + 1);
      const f = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
      const name = (f?.name || '').toLowerCase();
      // pdf.js classifies every font as serif / sans-serif / monospace (its
      // `fallbackName`, mirrored in the text style table) — trust that first,
      // and only use the font's own name where that says nothing. (Matching
      // on the name alone misfires: "Century Gothic" is a sans.)
      const generic = (f?.fallbackName || styleFamily || '').toLowerCase();
      if (generic === 'monospace' || /courier|mono|consol|typewriter/.test(name)) family = 'Courier';
      else if (generic === 'serif' || (!generic && /times|georgia|garamond|palatino|bookman|cambria/.test(name))) family = 'Times New Roman';
      bold = !!(f?.bold || f?.black || /bold|black|heavy|semibold|demi/.test(name));
      italic = !!(f?.italic || /italic|oblique/.test(name));
    } catch { /* keep defaults */ }
    return { family, bold, italic };
  }

  // Covers the original run's box and draws the new text in its place, then
  // marks the page dirty so export rasterizes it and the original glyphs are
  // guaranteed gone from the file (see _buildExportDoc).
  async commitTextEdit(index, originalRect, originalText, text, style) {
    await this._snapshot();
    const page = this.doc.getPage(index);
    const { bg, cover } = await this.sampleCoverArea(index, originalRect);
    page.drawRectangle({
      x: cover.x,
      y: cover.y,
      width: cover.width,
      height: cover.height,
      color: rgb(bg.r, bg.g, bg.b),
    });
    if (text.trim()) {
      const font = await this.doc.embedFont(pickStandardFont(style.fontFamily, style.bold, style.italic));
      page.drawText(text, {
        x: originalRect.x,
        y: originalRect.y + originalRect.height * 0.2,
        size: style.fontSize,
        font,
        color: hexToRgb01(style.color),
      });
      if (style.underline) {
        const width = font.widthOfTextAtSize(text, style.fontSize);
        const underlineY = originalRect.y + originalRect.height * 0.18;
        page.drawLine({
          start: { x: originalRect.x, y: underlineY },
          end: { x: originalRect.x + width, y: underlineY },
          thickness: Math.max(0.5, style.fontSize * 0.05),
          color: hexToRgb01(style.color),
        });
      }
    }
    this._markDirty(index, originalRect, originalText);
    await this._refreshRenderDoc();
  }

  // --- Redaction -------------------------------------------------------------

  // `colorHex` null/undefined = blend in: fill with the page's own background.
  async applyRedaction(index, rect, colorHex) {
    await this._snapshot();
    const page = this.doc.getPage(index);
    let color;
    if (colorHex) color = hexToRgb01(colorHex);
    else { const bg = await this.sampleBackgroundColor(index, rect); color = rgb(bg.r, bg.g, bg.b); }
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color });
    this._markDirty(index, rect);
    await this._refreshRenderDoc();
  }

  // --- Image editing -----------------------------------------------------

  // Walks the page's operator list tracking the save/restore/transform
  // stack to find where each image XObject is actually placed — pdf.js
  // doesn't expose image placement directly, but always resolves this much
  // to render the page, so it's reliably available here too.
  async getImageRects(index) {
    const covered = this.coveredRegions.get(index) || [];
    const rects = [];
    let page, opList;
    try {
      page = await this.renderDoc.getPage(index + 1);
      opList = await page.getOperatorList();
    } catch {
      return rects;
    }
    const stack = [[1, 0, 0, 1, 0, 0]];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      if (fn === OPS.save) {
        stack.push(stack[stack.length - 1].slice());
      } else if (fn === OPS.restore) {
        if (stack.length > 1) stack.pop();
      } else if (fn === OPS.transform) {
        const cur = stack[stack.length - 1];
        stack[stack.length - 1] = composeMatrix(opList.argsArray[i], cur);
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
        const ctm = stack[stack.length - 1];
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => applyMatrix(ctm, x, y));
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const width = Math.max(...xs) - x;
        const height = Math.max(...ys) - y;
        if (width < 4 || height < 4) continue; // skip slivers (tiling artifacts, hairlines)
        const cx = x + width / 2;
        const cy = y + height / 2;
        if (covered.some((r) => pointInRect(cx, cy, r))) continue;
        rects.push({ x, y, width, height });
      }
    }
    return rects;
  }

  async replaceImage(index, rect, imageBytes, mimeType) {
    await this._snapshot();
    const page = this.doc.getPage(index);
    const img = mimeType === 'image/png' ? await this.doc.embedPng(imageBytes) : await this.doc.embedJpg(imageBytes);
    const scaled = img.scaleToFit(rect.width, rect.height);
    const x = rect.x + (rect.width - scaled.width) / 2;
    const y = rect.y + (rect.height - scaled.height) / 2;
    const bg = await this.sampleBackgroundColor(index, rect);
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: rgb(bg.r, bg.g, bg.b) });
    page.drawImage(img, { x, y, width: scaled.width, height: scaled.height });
    this._markDirty(index, rect);
    await this._refreshRenderDoc();
  }

  // Renders the page and crops out the pixels under `rect` (PDF-space) as a
  // PNG — used both for cropping an image in place and for lifting an
  // image's pixels out for the Word exporter (see export-formats.js).
  async extractRegionPng(index, rect, scale = 3) {
    const page = await this.renderDoc.getPage(index + 1);
    const viewport = page.getViewport({ scale });
    const full = document.createElement('canvas');
    full.width = viewport.width;
    full.height = viewport.height;
    await page.render({ canvasContext: full.getContext('2d'), viewport }).promise;

    const p1 = viewport.convertToViewportPoint(rect.x, rect.y);
    const p2 = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
    const left = Math.max(0, Math.round(Math.min(p1[0], p2[0])));
    const top = Math.max(0, Math.round(Math.min(p1[1], p2[1])));
    const w = Math.max(1, Math.round(Math.abs(p2[0] - p1[0])));
    const h = Math.max(1, Math.round(Math.abs(p2[1] - p1[1])));

    const cropped = document.createElement('canvas');
    cropped.width = w;
    cropped.height = h;
    cropped.getContext('2d').drawImage(full, left, top, w, h, 0, 0, w, h);
    const blob = await new Promise((resolve) => cropped.toBlob(resolve, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // Keeps only the `keepRect` portion (PDF-space, within the original image's
  // rect) by rasterizing the current page's pixels for that sub-region and
  // re-embedding just that slice, then covering the rest of the original box.
  async cropImage(index, originalRect, keepRect) {
    await this._snapshot();
    const pngBytes = await this.extractRegionPng(index, keepRect);

    const docPage = this.doc.getPage(index);
    const bg = await this.sampleBackgroundColor(index, originalRect);
    docPage.drawRectangle({ x: originalRect.x, y: originalRect.y, width: originalRect.width, height: originalRect.height, color: rgb(bg.r, bg.g, bg.b) });
    const img = await this.doc.embedPng(pngBytes);
    docPage.drawImage(img, { x: keepRect.x, y: keepRect.y, width: keepRect.width, height: keepRect.height });
    this._markDirty(index, originalRect);
    await this._refreshRenderDoc();
  }

  async deleteImage(index, rect) {
    await this._snapshot();
    const page = this.doc.getPage(index);
    const bg = await this.sampleBackgroundColor(index, rect);
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: rgb(bg.r, bg.g, bg.b) });
    this._markDirty(index, rect);
    await this._refreshRenderDoc();
  }

  // --- OCR -----------------------------------------------------------------

  // Adds an invisible, positioned text layer over a scanned page so it
  // becomes searchable/selectable/copyable without changing how it looks.
  // Unlike text/image edits, this doesn't mark the page dirty for export —
  // that mechanism exists to guarantee removal of covered content, which is
  // the opposite of what OCR is doing (adding non-sensitive text), and
  // flattening would rasterize away the very text layer just added.
  async runOcr(index, onProgress) {
    await this._snapshot();

    const renderPage = await this.renderDoc.getPage(index + 1);
    const viewport = renderPage.getViewport({ scale: OCR_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await renderPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
      ...TESSERACT_PATHS,
      logger: (m) => {
        if (onProgress && m.status === 'recognizing text') onProgress(m.progress);
      },
    });

    let data;
    try {
      ({ data } = await worker.recognize(canvas, {}, { blocks: true }));
    } finally {
      await worker.terminate();
    }

    // Real text already on the page (a partly-scanned page) must not be doubled
    // up by an OCR copy of the same words, so OCR words landing on it are dropped.
    const existing = [];
    try {
      const { items } = await renderPage.getTextContent();
      for (const it of items) {
        if (!it.str || !it.str.trim()) continue;
        existing.push({ x: it.transform[4] - 1, y: it.transform[5] - 1, w: (it.width || 0) + 2, h: (it.height || 10) + 2 });
      }
    } catch { /* no existing text to avoid */ }

    const docPage = this.doc.getPage(index);
    const font = await this.doc.embedFont(StandardFonts.Helvetica);
    const median = (arr) => { const t = [...arr].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
    for (const line of flattenOcrLines(data)) {
      // drop what the recogniser itself doesn't believe: low-confidence words
      // and stray one-character marks ("|", "=") are scan noise, not text
      const words = (line.words || []).filter((w) => {
        const t = (w.text || '').trim();
        if (!t) return false;
        const conf = w.confidence ?? 100;
        if (conf < 45) return false;
        if (t.length === 1 && !/[A-Za-z0-9]/.test(t) && conf < 85) return false;
        return true;
      });
      if (!words.length) continue;

      // the line's baseline (image space, y down) — a sloped line on a skewed
      // scan, so its height is worked out per word from x below
      const bl = line.baseline;
      const hasSlope = !!(bl && bl.has_baseline !== false && Number.isFinite(bl.y0) && Number.isFinite(bl.x0) && Math.abs(bl.x1 - bl.x0) > 20);
      const slope = hasSlope ? (bl.y1 - bl.y0) / (bl.x1 - bl.x0) : 0;
      const baseAt = (x) => (hasSlope ? bl.y0 + (x - bl.x0) * slope
        : (bl && bl.has_baseline !== false && Number.isFinite(bl.y0)) ? (bl.y0 + bl.y1) / 2
        : median(words.map((w) => w.bbox.y1)));
      const lineBase = baseAt(median(words.map((w) => w.bbox.x0)));
      // font size from ascender/cap height: the median distance from the
      // baseline to the top of words that have one
      const tall = words.filter((w) => /[A-Z0-9bdfhklt]/.test(w.text));
      const rises = (tall.length ? tall : words).map((w) => baseAt(w.bbox.x0) - w.bbox.y0).filter((v) => v > 0);
      const lineFs = rises.length ? Math.max(4, median(rises) / 0.72 / OCR_SCALE) : 0;

      // The recogniser works on the rendered (y-down, scaled, and — if the
      // page has a /Rotate — turned) image; the viewport maps that back to
      // PDF user space, and the baseline direction there says how far to
      // turn the text so it reads upright in the view.
      const [bx, by] = viewport.convertToPdfPoint(0, lineBase);
      const [bx2, by2] = viewport.convertToPdfPoint(1, lineBase);
      const angle = (Math.atan2(by2 - by, bx2 - bx) * 180) / Math.PI;

      // Words that already have real text under them are skipped; the rest are
      // grouped into runs of closely spaced words. Each run is one string with
      // real spaces in it — separately drawn words get merged by pdf.js with
      // their spaces dropped ("CARDNO"), a string keeps them.
      const fresh = words
        .filter((w) => {
          const [cx, cy] = viewport.convertToPdfPoint((w.bbox.x0 + w.bbox.x1) / 2, (w.bbox.y0 + w.bbox.y1) / 2);
          return !existing.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
        })
        .sort((p, q) => p.bbox.x0 - q.bbox.x0);
      const runs = [];
      for (const w of fresh) {
        const last = runs[runs.length - 1];
        const gapPt = last ? (w.bbox.x0 - last.x1) / OCR_SCALE : Infinity;
        if (last && gapPt < Math.max(6, 1.1 * (lineFs || 8))) {
          last.text += ` ${w.text}`;
          last.x1 = Math.max(last.x1, w.bbox.x1);
          last.h = Math.max(last.h, w.bbox.y1 - w.bbox.y0);
        } else {
          runs.push({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1, h: w.bbox.y1 - w.bbox.y0 });
        }
      }
      for (const run of runs) {
        const widthPt = (run.x1 - run.x0) / OCR_SCALE;
        if (widthPt <= 0) continue;
        const [x, y] = viewport.convertToPdfPoint(run.x0, baseAt(run.x0));
        // The line's font size, shrunk if Helvetica at that size would run
        // well past the run's real width (pdf-lib can't squeeze glyphs).
        const fitSize = widthPt / (font.widthOfTextAtSize(run.text, 1) || 1);
        const fontSize = Math.max(4, lineFs ? Math.min(lineFs, fitSize * 1.25) : Math.min(fitSize, (run.h / OCR_SCALE) * 1.3));
        docPage.drawText(run.text, { x, y, size: fontSize, font, opacity: 0, rotate: Math.abs(angle) > 0.5 ? degrees(angle) : undefined });
      }
    }

    this.ocrPages.add(index);
    await this._refreshRenderDoc();
  }
}

// `outputScale` renders at higher pixel density than the CSS size (sharper on
// hi-DPI screens); `onTask` hands back the pdf.js render task so a caller can
// cancel a render that a newer zoom level has made obsolete.
async function renderPageOfDoc(renderDoc, index, canvas, targetWidth, { outputScale = 1, onTask } = {}) {
  const page = await renderDoc.getPage(index + 1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  const ctx = canvas.getContext('2d');
  const task = page.render({
    canvasContext: ctx,
    viewport,
    transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
  });
  onTask?.(task);
  await task.promise;
  return { width: viewport.width, height: viewport.height, viewport };
}

export { renderPageOfDoc, PAGE_SIZES, FONT_VARIANTS };
export const engine = new PdfEngine();
