// Page tools that edit the PDF itself: flatten / unflatten markups, crop and
// deskew. All work on the pdf-lib document (source of truth).
//
// Flatten is reversible: the markups' appearance streams are drawn into the
// page through a stream of our own, and the annotation objects are kept
// (detached) in a /SCHFlat record on the page. Unflatten removes that stream
// and puts the annotations back. (Markups flattened by other software can't
// be unflattened — their original data is gone.)

import { PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, PDFStream } from './vendor/pdf-lib.esm.min.js';

const SKIP_SUBTYPES = new Set(['Link', 'Widget', 'Popup']);
const N = (n) => (Math.round(n * 10000) / 10000).toString();

const lookup = (doc, v) => (v instanceof PDFRef ? doc.context.lookup(v) : v);

function nums(doc, v) {
  v = lookup(doc, v);
  if (!(v instanceof PDFArray)) return null;
  return v.asArray().map((x) => { x = lookup(doc, x); return x instanceof PDFNumber ? x.asNumber() : 0; });
}

// ---------------------------------------------------------------------------
// flatten / unflatten

function flatRecord(doc, page) {
  const rec = lookup(doc, page.node.get(PDFName.of('SCHFlat')));
  return rec instanceof PDFDict ? rec : null;
}

export function flattenedCount(doc, pageIndex) {
  const rec = flatRecord(doc, doc.getPage(pageIndex));
  if (!rec) return 0;
  const a = lookup(doc, rec.get(PDFName.of('Annots')));
  return a instanceof PDFArray ? a.size() : 0;
}

// Appearance stream to draw for an annotation (handles per-state /AP /N dicts).
function appearanceOf(doc, annot) {
  const ap = lookup(doc, annot.get(PDFName.of('AP')));
  if (!(ap instanceof PDFDict)) return null;
  let n = ap.get(PDFName.of('N'));
  let nObj = lookup(doc, n);
  if (nObj instanceof PDFDict && !(nObj instanceof PDFStream)) {
    const as = annot.get(PDFName.of('AS'));
    const key = as instanceof PDFName ? as : null;
    n = key ? nObj.get(key) : undefined;
    nObj = lookup(doc, n);
  }
  return n instanceof PDFRef && nObj instanceof PDFStream ? { ref: n, stream: nObj } : null;
}

// Matrix that places an appearance's transformed BBox onto the annotation Rect
// (PDF 32000-1 section 12.5.5). The form's own /Matrix is applied by `Do`.
function placement(doc, annot, stream) {
  const rect = nums(doc, annot.get(PDFName.of('Rect')));
  const bbox = nums(doc, stream.dict.get(PDFName.of('BBox')));
  const m = nums(doc, stream.dict.get(PDFName.of('Matrix'))) || [1, 0, 0, 1, 0, 0];
  if (!rect || !bbox || rect.length < 4 || bbox.length < 4) return null;
  const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
    .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const x0 = Math.min(...corners.map((c) => c[0])), x1 = Math.max(...corners.map((c) => c[0]));
  const y0 = Math.min(...corners.map((c) => c[1])), y1 = Math.max(...corners.map((c) => c[1]));
  const rx0 = Math.min(rect[0], rect[2]), rx1 = Math.max(rect[0], rect[2]);
  const ry0 = Math.min(rect[1], rect[3]), ry1 = Math.max(rect[1], rect[3]);
  if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return null;
  const sx = (rx1 - rx0) / (x1 - x0), sy = (ry1 - ry0) / (y1 - y0);
  return [sx, 0, 0, sy, rx0 - sx * x0, ry0 - sy * y0];
}

// Bakes every markup on the page into its content. Returns how many were flattened.
export function flattenMarkups(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  const { Annots, XObject } = page.node.normalizedEntries();
  if (!Annots || !Annots.size()) return 0;
  let ops = '';
  const names = [];
  const taken = [];
  for (let i = Annots.size() - 1; i >= 0; i--) { // walk backwards so removal keeps indices valid
    const raw = Annots.get(i);
    const annot = lookup(doc, raw);
    if (!(annot instanceof PDFDict) || !(raw instanceof PDFRef)) continue;
    const sub = annot.get(PDFName.of('Subtype'));
    if (!(sub instanceof PDFName) || SKIP_SUBTYPES.has(sub.decodeText())) continue;
    const flags = lookup(doc, annot.get(PDFName.of('F')));
    const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
    if (f & 2 || f & 32) continue; // Hidden / NoView: not visible, so not baked in
    const ap = appearanceOf(doc, annot);
    if (!ap) continue;
    const a = placement(doc, annot, ap.stream);
    if (!a) continue;
    const name = `SCHFlat_${raw.objectNumber}`;
    XObject.set(PDFName.of(name), ap.ref);
    names.unshift(name);
    taken.unshift(raw);
    ops = `q ${a.map(N).join(' ')} cm /${name} Do Q\n${ops}`; // keeps original stacking order
    Annots.remove(i);
  }
  if (!taken.length) return 0;
  const streamRef = doc.context.register(doc.context.stream(ops));
  page.node.addContentStream(streamRef);

  let rec = flatRecord(doc, page);
  if (!rec) {
    rec = doc.context.obj({ Streams: [], Names: [], Annots: [] });
    page.node.set(PDFName.of('SCHFlat'), rec);
  }
  const push = (key, items) => {
    const arr = lookup(doc, rec.get(PDFName.of(key)));
    for (const it of items) arr.push(it);
  };
  push('Streams', [streamRef]);
  push('Names', names.map((n) => PDFName.of(n)));
  push('Annots', taken);
  return taken.length;
}

// Puts flattened markups back as editable annotations. Returns how many.
export function unflattenMarkups(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  const rec = flatRecord(doc, page);
  if (!rec) return 0;
  const { Annots, XObject, Contents } = page.node.normalizedEntries();
  const streams = lookup(doc, rec.get(PDFName.of('Streams')));
  const namesArr = lookup(doc, rec.get(PDFName.of('Names')));
  const annots = lookup(doc, rec.get(PDFName.of('Annots')));
  let restored = 0;

  if (streams instanceof PDFArray && Contents instanceof PDFArray) {
    for (const s of streams.asArray()) {
      for (let i = Contents.size() - 1; i >= 0; i--) {
        const c = Contents.get(i);
        if (c instanceof PDFRef && s instanceof PDFRef && c.objectNumber === s.objectNumber) Contents.remove(i);
      }
    }
  }
  if (namesArr instanceof PDFArray) for (const n of namesArr.asArray()) XObject.delete(n);
  if (annots instanceof PDFArray) {
    for (const a of annots.asArray()) { Annots.push(a); restored++; }
  }
  page.node.delete(PDFName.of('SCHFlat'));
  return restored;
}

// ---------------------------------------------------------------------------
// crop

// box: { x, y, width, height } in user space (the visible area).
export function setCrop(doc, pageIndex, box) {
  const page = doc.getPage(pageIndex);
  page.setCropBox(box.x, box.y, Math.max(1, box.width), Math.max(1, box.height));
}

// Removes a crop, so the whole MediaBox shows again.
export function resetCrop(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  page.node.delete(PDFName.of('CropBox'));
}

export function cropBoxOf(doc, pageIndex) {
  const b = doc.getPage(pageIndex).getCropBox();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

// True only when the crop actually trims the page (many files carry a CropBox
// that is identical to the MediaBox, which isn't a crop in any useful sense).
export function hasCrop(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  if (!page.node.has(PDFName.of('CropBox'))) return false;
  const c = page.getCropBox(), m = page.getMediaBox();
  const d = (a, b) => Math.abs(a - b) > 0.5;
  return d(c.x, m.x) || d(c.y, m.y) || d(c.width, m.width) || d(c.height, m.height);
}

// ---------------------------------------------------------------------------
// deskew

// Rotates a page's content by `degrees` clockwise about the page centre (so a
// scan that leans anticlockwise is straightened by a positive angle). Markups
// are not rotated with it.
export function deskewContent(doc, pageIndex, degrees) {
  const page = doc.getPage(pageIndex);
  const box = page.getCropBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const a = (-degrees * Math.PI) / 180; // clockwise in a y-up page is a negative rotation
  const cos = Math.cos(a), sin = Math.sin(a);
  const e = cx - cx * cos + cy * sin;
  const f = cy - cx * sin - cy * cos;
  page.node.normalizedEntries(); // make Contents an array first
  const start = doc.context.register(doc.context.stream(`q ${N(cos)} ${N(sin)} ${N(-sin)} ${N(cos)} ${N(e)} ${N(f)} cm\n`));
  const end = doc.context.register(doc.context.stream('Q\n'));
  page.node.wrapContentStreams(start, end);
}
