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
// -> word; there's no flat `data.words` on the result.
function flattenOcrWords(data) {
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) words.push(word);
      }
    }
  }
  return words;
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
      coveredRegions: new Map(Array.from(this.coveredRegions, ([k, v]) => [k, v.slice()])),
    };
  }

  async _restoreSnapshot(snapshot) {
    this.doc = await PDFDocument.load(snapshot.bytes, { ignoreEncryption: true });
    this.dirtyPages = new Set(snapshot.dirtyPages);
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

    const newCovered = new Map();
    for (const [idx, rects] of this.coveredRegions) {
      const m = mapFn(idx);
      if (m !== null) newCovered.set(m, rects);
    }
    this.coveredRegions = newCovered;
  }

  _markDirty(index, rect) {
    this.dirtyPages.add(index);
    if (!this.coveredRegions.has(index)) this.coveredRegions.set(index, []);
    if (rect) this.coveredRegions.get(index).push(rect);
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
    const likelyScanned = await this._isLikelyScanned(index);
    return {
      widthPt: width,
      heightPt: height,
      rotation,
      sizeLabel: describeSize(width, height),
      likelyScanned,
    };
  }

  async _isLikelyScanned(index) {
    try {
      const page = await this.renderDoc.getPage(index + 1);
      const content = await page.getTextContent();
      const text = content.items.map((i) => i.str).join('').trim();
      return text.length < 3;
    } catch {
      return false;
    }
  }

  async renderPageToCanvas(index, canvas, targetWidth) {
    return renderPageOfDoc(this.renderDoc, index, canvas, targetWidth);
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
    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      const [, b, , d, e, f] = item.transform;
      const height = item.height || Math.hypot(b, d) || 10;
      const width = item.width || 1;
      const rect = { x: e, y: f - height * 0.25, width, height: height * 1.15 };
      if (covered.some((r) => pointInRect(e + width / 2, f, r))) continue;
      const style = (styles && styles[item.fontName]) || {};
      const family = (style.fontFamily || '').toLowerCase();
      runs.push({
        text: item.str,
        rect,
        fontSize: Math.max(6, Math.round(height)),
        bold: /bold/.test(family),
        italic: /italic|oblique/.test(family),
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
    const page = await this.renderDoc.getPage(index + 1);
    const scale = 1;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const p1 = viewport.convertToViewportPoint(rect.x, rect.y);
    const p2 = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
    const left = Math.max(0, Math.floor(Math.min(p1[0], p2[0])) - 2);
    const top = Math.max(0, Math.floor(Math.min(p1[1], p2[1])) - 2);
    const w = Math.min(canvas.width - left, Math.ceil(Math.abs(p2[0] - p1[0])) + 4) || 1;
    const h = Math.min(canvas.height - top, Math.ceil(Math.abs(p2[1] - p1[1])) + 4) || 1;
    try {
      const data = ctx.getImageData(left, top, w, h).data;
      let r = 0, g = 0, bl = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; bl += data[i + 2]; n++;
      }
      return { r: Math.round(r / n) / 255, g: Math.round(g / n) / 255, b: Math.round(bl / n) / 255 };
    } catch {
      return { r: 1, g: 1, b: 1 };
    }
  }

  // Covers the original run's box and draws the new text in its place, then
  // marks the page dirty so export rasterizes it and the original glyphs are
  // guaranteed gone from the file (see _buildExportDoc).
  async commitTextEdit(index, originalRect, text, style) {
    await this._snapshot();
    const page = this.doc.getPage(index);
    const bg = await this.sampleBackgroundColor(index, originalRect);
    page.drawRectangle({
      x: originalRect.x - 1,
      y: originalRect.y - 1,
      width: originalRect.width + 2,
      height: originalRect.height + 2,
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
    this._markDirty(index, originalRect);
    await this._refreshRenderDoc();
  }

  // --- Redaction -------------------------------------------------------------

  async applyRedaction(index, rect, colorHex = '#111111') {
    await this._snapshot();
    const page = this.doc.getPage(index);
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: hexToRgb01(colorHex) });
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

    const docPage = this.doc.getPage(index);
    const font = await this.doc.embedFont(StandardFonts.Helvetica);
    for (const word of flattenOcrWords(data)) {
      if (!word.text || !word.text.trim()) continue;
      const { x0, y0, x1, y1 } = word.bbox;
      const widthPt = (x1 - x0) / OCR_SCALE;
      const heightPt = (y1 - y0) / OCR_SCALE;
      if (widthPt <= 0 || heightPt <= 0) continue;
      // Canvas is top-left-origin/y-down at OCR_SCALE; PDF space is
      // bottom-left-origin/y-up at 1:1 — flip and undo the render scale.
      const x = x0 / OCR_SCALE;
      const y = (viewport.height - y1) / OCR_SCALE;
      // Pick a font size so Helvetica's natural width roughly matches the
      // word's actual pixel width — pdf-lib has no text-scale (Tz) option to
      // fit it exactly, and an invisible layer only needs to be close enough
      // for selection/search, not pixel-perfect.
      const naturalWidthAt1pt = font.widthOfTextAtSize(word.text, 1) || 1;
      const fontSize = Math.max(4, Math.min(widthPt / naturalWidthAt1pt, heightPt * 1.3));
      docPage.drawText(word.text, { x, y, size: fontSize, font, opacity: 0 });
    }

    await this._refreshRenderDoc();
  }
}

async function renderPageOfDoc(renderDoc, index, canvas, targetWidth) {
  const page = await renderDoc.getPage(index + 1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { width: viewport.width, height: viewport.height, viewport };
}

export { renderPageOfDoc, PAGE_SIZES, FONT_VARIANTS };
export const engine = new PdfEngine();
