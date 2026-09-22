// Wraps pdf.js (rendering) and pdf-lib (mutation/export). The two libraries
// parse the file independently, so after any mutation we re-save the pdf-lib
// document to bytes and reload a fresh pdf.js document from those bytes for
// display. That round trip is what keeps thumbnails/canvas in sync with edits.

import * as pdfjsLib from './vendor/pdf.min.mjs';
import { PDFDocument, degrees } from './vendor/pdf-lib.esm.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './js/vendor/pdf.worker.min.mjs';

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
};

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
  }

  async loadFromBytes(bytes, fileName) {
    this.doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    this.fileName = fileName;
    await this._refreshRenderDoc();
  }

  async _refreshRenderDoc() {
    const bytes = await this.doc.save();
    this.renderDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
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
    const page = this.doc.getPage(index);
    const current = page.getRotation().angle;
    const next = (((current + deltaDegrees) % 360) + 360) % 360;
    page.setRotation(degrees(next));
    await this._refreshRenderDoc();
  }

  async deletePage(index) {
    this.doc.removePage(index);
    await this._refreshRenderDoc();
  }

  async insertBlankPage(atIndex, sizeKey = 'A4') {
    const size = PAGE_SIZES[sizeKey] || PAGE_SIZES.A4;
    this.doc.insertPage(atIndex, size);
    await this._refreshRenderDoc();
  }

  async setPageSize(index, sizeKey) {
    const [w, h] = PAGE_SIZES[sizeKey] || PAGE_SIZES.A4;
    this.doc.getPage(index).setSize(w, h);
    await this._refreshRenderDoc();
  }

  // Reorders pages by rebuilding the page tree in the given order — pdf-lib
  // has no direct "move" API, so this is the standard technique.
  async reorderPages(newOrder) {
    const rebuilt = await PDFDocument.create();
    const copied = await rebuilt.copyPages(this.doc, newOrder);
    copied.forEach((p) => rebuilt.addPage(p));
    this.doc = rebuilt;
    await this._refreshRenderDoc();
  }

  async loadExternalDocument(bytes) {
    return PDFDocument.load(bytes, { ignoreEncryption: true });
  }

  async insertPagesFrom(externalDoc, pageIndices, atIndex) {
    const copied = await this.doc.copyPages(externalDoc, pageIndices);
    copied.forEach((p, i) => this.doc.insertPage(atIndex + i, p));
    await this._refreshRenderDoc();
  }

  async mergeAppend(externalDoc) {
    const indices = externalDoc.getPageIndices();
    const copied = await this.doc.copyPages(externalDoc, indices);
    copied.forEach((p) => this.doc.addPage(p));
    await this._refreshRenderDoc();
  }

  async exportPages(indices) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(this.doc, indices);
    copied.forEach((p) => out.addPage(p));
    return out.save();
  }

  async getBytes() {
    return this.doc.save();
  }

  // Loads a pdf.js render doc for an external file's bytes (e.g. for the
  // "insert pages from another PDF" picker), independent of the working doc.
  async loadExternalRenderDoc(bytes) {
    return pdfjsLib.getDocument({ data: bytes }).promise;
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
  return { width: viewport.width, height: viewport.height };
}

export { renderPageOfDoc, PAGE_SIZES };
export const engine = new PdfEngine();
