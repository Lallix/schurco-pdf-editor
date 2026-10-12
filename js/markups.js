// PDF markups (annotations): reading, creating, moving, restyling and deleting.
//
// These are *standard* PDF annotation dictionaries, written the way Bluebeam
// Revu writes them (same subtypes, intents, defaults and colours seen in real
// reviewed drawings: red #E44234, Helvetica, callouts with a leader, revision
// clouds as Polygon + /BE, arrows as Line + /LineArrow), each with its own
// appearance stream — so Revu, Acrobat and this app all show and edit them.
//
// Everything here works on the pdf-lib document (the source of truth); the
// engine wraps these calls with undo snapshots and a render refresh.

import {
  PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFRef, PDFNumber, PDFStream, StandardFonts,
} from './vendor/pdf-lib.esm.min.js';

export const REVU_RED = '#E44234';
export const REVU_BLUE = '#4E7DE9';
export const REVU_YELLOW = '#FFCC44';

export const STAMPS = [
  { key: 'Draft', text: 'DRAFT', color: '#E44234' },
  { key: 'NotForConstruction', text: 'NOT FOR CONSTRUCTION', color: '#E44234' },
  { key: 'ForReview', text: 'FOR REVIEW', color: '#4E7DE9' },
  { key: 'Revised', text: 'REVISED', color: '#E8820C' },
  { key: 'Approved', text: 'APPROVED', color: '#218240' },
  { key: 'Void', text: 'VOID', color: '#E44234' },
];

const N = (n) => (Math.round(n * 1000) / 1000).toString();
const PDFSTRING_ESC = /[()\\]/g;

export function hexToRgb(hex) {
  const n = parseInt((hex || '#000000').replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c) {
  if (!c || c.length < 3) return null;
  return `#${c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const rg = (hex) => hexToRgb(hex).map(N).join(' ');

function pdfDate(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function textObj(s) {
  return /^[\x20-\x7E]*$/.test(s) ? PDFString.of(s) : PDFHexString.fromText(s);
}

// Text for a content stream literal string: WinAnsi-ish, anything outside it becomes '?'.
function lit(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c < 256 ? ch.replace(PDFSTRING_ESC, '\\$&') : '?';
  }
  return `(${out})`;
}

function bboxOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ---------------------------------------------------------------------------
// reading

const FRIENDLY = {
  FreeText: 'Text box', FreeTextCallout: 'Callout', FreeTextTypeWriter: 'Typewriter',
  Line: 'Line', LineArrow: 'Arrow', Square: 'Rectangle', Circle: 'Ellipse',
  Polygon: 'Polygon', PolygonCloud: 'Cloud', PolyLine: 'Polyline',
  Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikethrough', Squiggly: 'Squiggly',
  Ink: 'Pen', Text: 'Note', Stamp: 'Stamp', Caret: 'Caret', FileAttachment: 'Attachment',
};

const SKIP = new Set(['Link', 'Widget', 'Popup']);

function lookup(doc, v) {
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}
function get(doc, dict, key) {
  return lookup(doc, dict.get(PDFName.of(key)));
}
function getStr(doc, dict, key) {
  const v = get(doc, dict, key);
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return undefined;
}
function getNums(doc, dict, key) {
  const v = get(doc, dict, key);
  if (!(v instanceof PDFArray)) return null;
  return v.asArray().map((x) => {
    x = lookup(doc, x);
    return x instanceof PDFNumber ? x.asNumber() : 0;
  });
}
function getName(doc, dict, key) {
  const v = get(doc, dict, key);
  return v instanceof PDFName ? v.decodeText() : undefined;
}
function getNum(doc, dict, key) {
  const v = get(doc, dict, key);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}
function getDate(doc, dict, key) {
  const v = get(doc, dict, key);
  try {
    if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeDate()?.toISOString() || null;
  } catch { /* unparseable date */ }
  return null;
}

function refKey(ref) { return `${ref.objectNumber} ${ref.generationNumber}`; }

export function refFromKey(key) {
  const [n, g] = key.split(' ').map(Number);
  return PDFRef.of(n, g || 0);
}

function readDA(da) {
  // "0.894 0.259 0.204 rg /Helvetica 10 Tf"
  const out = {};
  if (!da) return out;
  const col = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
  if (col) out.color = rgbToHex([+col[1], +col[2], +col[3]]);
  const g = da.match(/([\d.]+)\s+g\b/);
  if (!col && g) out.color = rgbToHex([+g[1], +g[1], +g[1]]);
  const size = da.match(/([\d.]+)\s+Tf/);
  if (size) out.fontSize = +size[1];
  return out;
}

// Every user-visible markup in the document, as plain objects.
export function readMarkups(doc) {
  const out = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const a = lookup(doc, raw);
      if (!(a instanceof PDFDict)) continue;
      const subtype = getName(doc, a, 'Subtype');
      if (!subtype || SKIP.has(subtype)) continue;
      const intent = getName(doc, a, 'IT');
      const rect = getNums(doc, a, 'Rect');
      if (!rect) continue;
      const be = get(doc, a, 'BE');
      const isCloud = subtype === 'Polygon' && (intent === 'PolygonCloud' || (be instanceof PDFDict && getName(doc, be, 'S') === 'C'));
      const kindKey = isCloud ? 'PolygonCloud' : (intent === 'LineArrow' || intent === 'FreeTextCallout') ? intent : subtype;
      const da = readDA(getStr(doc, a, 'DA'));
      const c = getNums(doc, a, 'C');
      const ic = getNums(doc, a, 'IC');
      const bs = get(doc, a, 'BS');
      const lw = bs instanceof PDFDict ? getNum(doc, bs, 'W') : undefined;
      const lArr = getNums(doc, a, 'L');
      const verts = getNums(doc, a, 'Vertices');
      const rd = getNums(doc, a, 'RD');
      let box = null;
      if (kindKey === 'FreeTextCallout' && rd && rd.length === 4) box = [rect[0] + rd[0], rect[1] + rd[1], rect[2] - rd[2], rect[3] - rd[3]];
      else if (subtype === 'FreeText') box = rect;
      const clArr = getNums(doc, a, 'CL');
      out.push({
        line: lArr && lArr.length >= 4 ? lArr.slice(0, 4) : null,
        points: verts && verts.length >= 6 ? verts : null,
        box,
        tip: clArr && clArr.length >= 4 ? [clArr[0], clArr[1]] : null,
        ref: raw instanceof PDFRef ? refKey(raw) : null,
        pageIndex,
        subtype,
        intent: intent || null,
        kind: kindKey,
        type: FRIENDLY[kindKey] || subtype,
        author: getStr(doc, a, 'T') || '',
        subject: getStr(doc, a, 'Subj') || '',
        contents: getStr(doc, a, 'Contents') || '',
        date: getDate(doc, a, 'M') || getDate(doc, a, 'CreationDate'),
        color: (subtype === 'FreeText' ? da.color : null) || (c && c.length >= 3 ? rgbToHex(c) : null),
        fill: ic && ic.length >= 3 ? rgbToHex(ic) : (subtype === 'FreeText' && c && c.length >= 3 ? rgbToHex(c) : null),
        lineWidth: lw,
        fontSize: da.fontSize,
        rect,
        opacity: getNum(doc, a, 'CA'),
        status: getStr(doc, a, 'State') || null,
        hasReply: !!get(doc, a, 'IRT'),
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// text layout for appearance streams

async function helv(doc, bold = false) {
  doc.__markupFonts ??= {};
  const key = bold ? 'b' : 'r';
  if (!doc.__markupFonts[key]) {
    doc.__markupFonts[key] = await doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  }
  return doc.__markupFonts[key];
}

function wrapLines(font, text, size, maxWidth) {
  const lines = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const trial = line + word;
      if (line && font.widthOfTextAtSize(trial.trimEnd(), size) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = trial;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const PAD = 3;

// Height a text box needs for `text` at `width`.
export async function measureText(doc, text, fontSize, width) {
  const font = await helv(doc);
  const lines = wrapLines(font, text || ' ', fontSize, Math.max(10, width - 2 * PAD - 1));
  return { lines, height: lines.length * fontSize * 1.2 + 2 * PAD };
}

// ---------------------------------------------------------------------------
// appearance streams — each returns { content, bbox: [0,0,w,h], gs?: {name: dict} }
// in a local coordinate system whose origin is the annotation's Rect corner.

function form(doc, { content, w, h, fonts = {}, gs = {} }) {
  const resources = {};
  if (Object.keys(fonts).length) resources.Font = fonts;
  if (Object.keys(gs).length) resources.ExtGState = gs;
  const stream = doc.context.stream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: resources,
  });
  return doc.context.register(stream);
}

function textBoxContent({ w, h, lines, fontSize, color, fill, border, boxX = 0, boxY = 0, boxW = w, boxH = h }) {
  let c = 'q\n';
  if (fill) c += `${rg(fill)} rg ${N(boxX)} ${N(boxY)} ${N(boxW)} ${N(boxH)} re f\n`;
  if (border > 0) c += `${rg(color)} RG ${N(border)} w ${N(boxX + border / 2)} ${N(boxY + border / 2)} ${N(boxW - border)} ${N(boxH - border)} re S\n`;
  c += `BT /Helv ${N(fontSize)} Tf ${rg(color)} rg\n`;
  let y = boxY + boxH - PAD - fontSize * 0.93;
  const lh = fontSize * 1.2;
  let first = true;
  let lastY = 0;
  for (const line of lines) {
    if (first) { c += `${N(boxX + PAD)} ${N(y)} Td\n`; first = false; } else c += `0 ${N(-lh)} Td\n`;
    c += `${lit(line)} Tj\n`;
    lastY = y; y -= lh;
  }
  c += 'ET\nQ\n';
  void lastY;
  return c;
}

function arrowHead(kind, tip, from, size, lw, color) {
  // tip: [x,y] the point; from: [x,y] a point along the line, away from the tip
  const dx = tip[0] - from[0], dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const bx = tip[0] - ux * size, by = tip[1] - uy * size;
  const px = -uy * size * 0.4, py = ux * size * 0.4;
  if (kind === 'ClosedArrow') {
    return `${rg(color)} rg ${N(tip[0])} ${N(tip[1])} m ${N(bx + px)} ${N(by + py)} l ${N(bx - px)} ${N(by - py)} l h f\n`;
  }
  if (kind === 'OpenArrow') {
    return `${N(bx + px)} ${N(by + py)} m ${N(tip[0])} ${N(tip[1])} l ${N(bx - px)} ${N(by - py)} l S\n`;
  }
  void lw;
  return '';
}

// Scalloped cloud outline through `pts` (closed). Returns path operators.
function cloudPath(pts, arc) {
  // orientation: positive area = counter-clockwise (y up); bulge outward
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const dir = area > 0 ? -1 : 1; // outward normal sign
  let path = '';
  let started = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 0.5) continue;
    const n = Math.max(1, Math.round(len / arc));
    const nx = dir * (q[1] - p[1]) / len, ny = dir * -(q[0] - p[0]) / len;
    for (let k = 0; k < n; k++) {
      const a = [p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n];
      const b = [p[0] + (q[0] - p[0]) * (k + 1) / n, p[1] + (q[1] - p[1]) * (k + 1) / n];
      const chord = len / n;
      const off = chord * 0.667; // control offset of a cubic semicircle
      if (!started) { path += `${N(a[0])} ${N(a[1])} m\n`; started = true; }
      path += `${N(a[0] + nx * off)} ${N(a[1] + ny * off)} ${N(b[0] + nx * off)} ${N(b[1] + ny * off)} ${N(b[0])} ${N(b[1])} c\n`;
    }
  }
  return path + 'h\n';
}

function ellipsePath(x, y, w, h) {
  const k = 0.5523;
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  return `${N(cx + rx)} ${N(cy)} m\n`
    + `${N(cx + rx)} ${N(cy + ry * k)} ${N(cx + rx * k)} ${N(cy + ry)} ${N(cx)} ${N(cy + ry)} c\n`
    + `${N(cx - rx * k)} ${N(cy + ry)} ${N(cx - rx)} ${N(cy + ry * k)} ${N(cx - rx)} ${N(cy)} c\n`
    + `${N(cx - rx)} ${N(cy - ry * k)} ${N(cx - rx * k)} ${N(cy - ry)} ${N(cx)} ${N(cy - ry)} c\n`
    + `${N(cx + rx * k)} ${N(cy - ry)} ${N(cx + rx)} ${N(cy - ry * k)} ${N(cx + rx)} ${N(cy)} c h\n`;
}

// ---------------------------------------------------------------------------
// building annotations from a spec
//
// spec: { kind, pageIndex, author, subject?, color, lineWidth, fontSize, fill, opacity,
//         text, rect:[x0,y0,x1,y1], p1:[x,y], p2:[x,y], tip:[x,y], points:[[x,y]...],
//         quads:[[8 numbers]...], strokes:[[[x,y]...]], stampKey, ends:[a,b] }

const DEFAULT_LW = { Line: 2, LineArrow: 2, Square: 2, Circle: 2, PolygonCloud: 2, Ink: 2, FreeText: 0.5, FreeTextCallout: 0.5 };

function styleOf(spec) {
  return {
    color: spec.color || REVU_RED,
    lineWidth: spec.lineWidth ?? DEFAULT_LW[spec.kind] ?? 1,
    fontSize: spec.fontSize || 10,
    fill: spec.fill ?? null,
    opacity: spec.opacity ?? 1,
  };
}

async function buildAppearance(doc, spec, geom) {
  const s = styleOf(spec);
  const [x0, y0, x1, y1] = geom.rect;
  const w = x1 - x0, h = y1 - y0;
  const local = (p) => [p[0] - x0, p[1] - y0];
  const fonts = {};
  const gs = {};
  let content = '';

  const needFont = async (bold) => {
    const f = await helv(doc, bold);
    fonts[bold ? 'HelvB' : 'Helv'] = f.ref;
    return f;
  };

  switch (spec.kind) {
    case 'FreeText':
    case 'FreeTextCallout': {
      await needFont(false);
      const [bx0, by0, bx1, by1] = geom.box;
      content = textBoxContent({
        w, h, lines: geom.lines, fontSize: s.fontSize, color: s.color, fill: s.fill, border: s.lineWidth,
        boxX: bx0 - x0, boxY: by0 - y0, boxW: bx1 - bx0, boxH: by1 - by0,
      });
      if (spec.kind === 'FreeTextCallout' && geom.cl) {
        const pts = [];
        for (let i = 0; i < geom.cl.length; i += 2) pts.push(local([geom.cl[i], geom.cl[i + 1]]));
        content += `q ${rg(s.color)} RG ${N(Math.max(0.75, s.lineWidth))} w ${N(pts[0][0])} ${N(pts[0][1])} m `
          + pts.slice(1).map((p) => `${N(p[0])} ${N(p[1])} l`).join(' ') + ' S Q\n';
      }
      break;
    }
    case 'Line':
    case 'LineArrow': {
      const a = local(spec.p1), b = local(spec.p2);
      const ends = spec.ends || ['None', spec.kind === 'LineArrow' ? 'OpenArrow' : 'None'];
      const head = Math.max(8, s.lineWidth * 4);
      content = `q ${rg(s.color)} RG ${N(s.lineWidth)} w 1 J 1 j ${N(a[0])} ${N(a[1])} m ${N(b[0])} ${N(b[1])} l S\n`;
      content += `${rg(s.color)} RG ${N(Math.max(1, s.lineWidth * 0.8))} w\n`;
      content += arrowHead(ends[0], a, b, head, s.lineWidth, s.color) + arrowHead(ends[1], b, a, head, s.lineWidth, s.color) + 'Q\n';
      break;
    }
    case 'Square':
    case 'Circle': {
      const lw = s.lineWidth;
      const path = spec.kind === 'Square'
        ? `${N(lw / 2)} ${N(lw / 2)} ${N(w - lw)} ${N(h - lw)} re\n`
        : ellipsePath(lw / 2, lw / 2, w - lw, h - lw);
      content = `q ${s.fill ? `${rg(s.fill)} rg ` : ''}${rg(s.color)} RG ${N(lw)} w\n${path}${s.fill ? 'B' : 'S'}\nQ\n`;
      break;
    }
    case 'PolygonCloud': {
      const pts = spec.points.map(local);
      content = `q ${rg(s.color)} RG ${N(s.lineWidth)} w 1 j\n${cloudPath(pts, geom.arc)}S\nQ\n`;
      break;
    }
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut': {
      gs.GS = { Type: 'ExtGState', ca: s.opacity, CA: s.opacity, ...(spec.kind === 'Highlight' ? { BM: 'Multiply' } : {}) };
      content = 'q /GS gs\n';
      for (const q of spec.quads) {
        const P = [[q[0] - x0, q[1] - y0], [q[2] - x0, q[3] - y0], [q[4] - x0, q[5] - y0], [q[6] - x0, q[7] - y0]];
        if (spec.kind === 'Highlight') {
          content += `${rg(s.color)} rg ${N(P[0][0])} ${N(P[0][1])} m ${N(P[1][0])} ${N(P[1][1])} l ${N(P[3][0])} ${N(P[3][1])} l ${N(P[2][0])} ${N(P[2][1])} l h f\n`;
        } else {
          const y = spec.kind === 'Underline' ? 0 : 0.5;
          const lx = (A, B) => [A[0] + (B[0] - A[0]) * 0, A[1] + (B[1] - A[1]) * 0];
          void lx;
          const a = [P[2][0] + (P[0][0] - P[2][0]) * y, P[2][1] + (P[0][1] - P[2][1]) * y];
          const b = [P[3][0] + (P[1][0] - P[3][0]) * y, P[3][1] + (P[1][1] - P[3][1]) * y];
          content += `${rg(s.color)} RG ${N(Math.max(0.75, (P[0][1] - P[2][1]) * 0.07))} w ${N(a[0])} ${N(a[1] + 0.8)} m ${N(b[0])} ${N(b[1] + 0.8)} l S\n`;
        }
      }
      content += 'Q\n';
      break;
    }
    case 'Ink': {
      content = `q ${rg(s.color)} RG ${N(s.lineWidth)} w 1 J 1 j\n`;
      for (const stroke of spec.strokes) {
        stroke.map(local).forEach((p, i) => { content += `${N(p[0])} ${N(p[1])} ${i ? 'l' : 'm'}\n`; });
        content += 'S\n';
      }
      content += 'Q\n';
      break;
    }
    case 'Text': {
      // sticky-note icon: a coloured speech bubble with three text lines
      content = `q ${rg(s.color)} rg 0 0 0 RG 0.8 w 1 5 ${N(w - 2)} ${N(h - 6)} re B\n`
        + `${N(4)} 5 m ${N(9)} 5 l ${N(4)} 1 l h B\n0 0 0 RG 1 w `
        + `${N(4)} ${N(h - 6)} m ${N(w - 4)} ${N(h - 6)} l S ${N(4)} ${N(h - 10)} m ${N(w - 4)} ${N(h - 10)} l S ${N(4)} ${N(h - 14)} m ${N(w - 9)} ${N(h - 14)} l S Q\n`;
      break;
    }
    case 'Stamp': {
      const stamp = STAMPS.find((x) => x.key === spec.stampKey) || STAMPS[0];
      const bold = await needFont(true);
      const lw = 1.5;
      let size = h * 0.55;
      const maxW = w - 2 * lw - 6;
      const tw = bold.widthOfTextAtSize(stamp.text, size);
      if (tw > maxW) size *= maxW / tw;
      const tx = (w - bold.widthOfTextAtSize(stamp.text, size)) / 2;
      const ty = (h - size * 0.72) / 2;
      content = `q ${rg(stamp.color)} RG ${N(lw)} w ${N(lw / 2 + 0.5)} ${N(lw / 2 + 0.5)} ${N(w - lw - 1)} ${N(h - lw - 1)} re S\n`
        + `BT /HelvB ${N(size)} Tf ${rg(stamp.color)} rg ${N(tx)} ${N(ty)} Td ${lit(stamp.text)} Tj ET Q\n`;
      break;
    }
    default:
      throw new Error(`Unsupported markup: ${spec.kind}`);
  }
  return form(doc, { content, w, h, fonts, gs });
}

// Works out the annotation's Rect and any kind-specific geometry.
async function geometryFor(doc, spec) {
  const s = styleOf(spec);
  switch (spec.kind) {
    case 'FreeText':
    case 'FreeTextCallout': {
      let [x0, y0, x1, y1] = spec.rect;
      const m = await measureText(doc, spec.text, s.fontSize, x1 - x0);
      const hh = Math.max(y1 - y0, m.height);
      y0 = y1 - hh; // grow downward from the top edge
      const box = [x0, y0, x1, y1];
      if (spec.kind === 'FreeTextCallout' && spec.tip) {
        const [tx, ty] = spec.tip;
        // leader runs from the nearest edge midpoint of the box to the tip
        const mids = [[x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]];
        const start = mids.reduce((b, p) => (Math.hypot(p[0] - tx, p[1] - ty) < Math.hypot(b[0] - tx, b[1] - ty) ? p : b));
        const cl = [tx, ty, start[0], start[1]];
        const [rx0, ry0, rx1, ry1] = bboxOf([[x0, y0], [x1, y1], [tx, ty]]);
        return { rect: [rx0 - 1, ry0 - 1, rx1 + 1, ry1 + 1], box, lines: m.lines, cl, rd: [x0 - rx0 + 1, y0 - ry0 + 1, rx1 + 1 - x1, ry1 + 1 - y1] };
      }
      return { rect: box, box, lines: m.lines };
    }
    case 'Line':
    case 'LineArrow': {
      const pad = Math.max(10, s.lineWidth * 4) + s.lineWidth;
      const [a, b, c, d] = bboxOf([spec.p1, spec.p2]);
      return { rect: [a - pad, b - pad, c + pad, d + pad] };
    }
    case 'Square':
    case 'Circle':
      return { rect: spec.rect };
    case 'PolygonCloud': {
      const arc = Math.max(10, s.lineWidth * 5);
      const [a, b, c, d] = bboxOf(spec.points);
      const pad = arc * 0.8 + s.lineWidth;
      return { rect: [a - pad, b - pad, c + pad, d + pad], arc };
    }
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut': {
      const pts = spec.quads.flatMap((q) => [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]);
      return { rect: bboxOf(pts) };
    }
    case 'Ink': {
      const [a, b, c, d] = bboxOf(spec.strokes.flat());
      const pad = s.lineWidth + 1;
      return { rect: [a - pad, b - pad, c + pad, d + pad] };
    }
    case 'Text': {
      const [x, y] = spec.p1;
      return { rect: [x, y - 20, x + 20, y] };
    }
    case 'Stamp':
      return { rect: spec.rect };
    default:
      throw new Error(`Unsupported markup: ${spec.kind}`);
  }
}

function annotDict(doc, page, spec, geom, apRef) {
  const s = styleOf(spec);
  const kind = spec.kind;
  const subtype = kind === 'FreeTextCallout' ? 'FreeText' : kind === 'LineArrow' ? 'Line' : kind === 'PolygonCloud' ? 'Polygon' : kind;
  const subj = spec.subject || ({
    FreeText: 'Free Text', FreeTextCallout: 'Callout', Line: 'Line', LineArrow: 'Line', Square: 'Rectangle', Circle: 'Ellipse',
    PolygonCloud: 'Polygon', Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikethrough', Ink: 'Pen', Text: 'Note', Stamp: 'Stamp',
  }[kind] || kind);
  const now = pdfDate();
  const d = {
    Type: 'Annot', Subtype: subtype, Rect: geom.rect, P: page.ref,
    NM: PDFString.of(crypto.randomUUID()), M: PDFString.of(now), CreationDate: PDFString.of(now),
    T: textObj(spec.author || ''), Subj: textObj(subj), F: kind === 'Text' ? 28 : 4,
    AP: { N: apRef },
  };
  if (spec.text !== undefined && kind !== 'Stamp') d.Contents = textObj(spec.text);
  const rgbArr = (hex) => hexToRgb(hex).map((v) => Math.round(v * 1000) / 1000);

  switch (kind) {
    case 'FreeText':
    case 'FreeTextCallout': {
      d.DA = PDFString.of(`${rg(s.color)} rg /Helvetica ${N(s.fontSize)} Tf`);
      d.DS = PDFString.of(`font: Helvetica ${N(s.fontSize)}pt; text-align: left; text-vertical-align: top; color: ${s.color}`);
      d.BS = { W: s.lineWidth };
      d.Q = 0;
      if (s.fill) d.C = rgbArr(s.fill);
      if (kind === 'FreeTextCallout') {
        d.IT = 'FreeTextCallout';
        if (geom.cl) { d.CL = geom.cl; d.RD = geom.rd; }
      }
      break;
    }
    case 'Line':
    case 'LineArrow': {
      d.C = rgbArr(s.color);
      d.L = [...spec.p1, ...spec.p2];
      d.LE = spec.ends || ['None', kind === 'LineArrow' ? 'OpenArrow' : 'None'];
      d.BS = { W: s.lineWidth };
      if (kind === 'LineArrow') d.IT = 'LineArrow';
      break;
    }
    case 'Square':
    case 'Circle':
      d.C = rgbArr(s.color);
      if (s.fill) d.IC = rgbArr(s.fill);
      d.BS = { W: s.lineWidth };
      break;
    case 'PolygonCloud':
      d.C = rgbArr(s.color);
      d.Vertices = spec.points.flat();
      d.BS = { W: s.lineWidth };
      d.BE = { S: 'C', I: 2 };
      d.IT = 'PolygonCloud';
      break;
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
      d.C = rgbArr(s.color);
      d.QuadPoints = spec.quads.flat();
      if (s.opacity < 1) d.CA = s.opacity;
      break;
    case 'Ink':
      d.C = rgbArr(s.color);
      d.InkList = spec.strokes.map((st) => st.flat());
      d.BS = { W: s.lineWidth };
      break;
    case 'Text':
      d.C = rgbArr(s.color);
      d.Name = 'Comment';
      d.Open = false;
      break;
    case 'Stamp':
      d.Name = spec.stampKey || 'Draft';
      break;
    default: break;
  }
  return doc.context.obj(d);
}

function pageOf(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = doc.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  return { page, annots };
}

// Adds a markup; returns its ref key.
export async function createMarkup(doc, spec) {
  const { page, annots } = pageOf(doc, spec.pageIndex);
  const geom = await geometryFor(doc, spec);
  const apRef = await buildAppearance(doc, spec, geom);
  const dict = annotDict(doc, page, spec, geom, apRef);
  const ref = doc.context.register(dict);
  annots.push(ref);
  return refKey(ref);
}

// ---------------------------------------------------------------------------
// editing existing markups

function findAnnot(doc, key) {
  const ref = refFromKey(key);
  const dict = doc.context.lookup(ref);
  if (!(dict instanceof PDFDict)) throw new Error('Markup not found');
  return { ref, dict };
}

function setNums(doc, dict, key, nums) {
  dict.set(PDFName.of(key), doc.context.obj(nums.map((n) => Math.round(n * 1000) / 1000)));
}

function mapNums(doc, dict, key, fn) {
  const v = getNums(doc, dict, key);
  if (v) setNums(doc, dict, key, v.map(fn));
}

const touch = (doc, dict) => dict.set(PDFName.of('M'), PDFString.of(pdfDate()));

// Moves a markup by (dx, dy) in PDF points. The appearance maps onto the Rect,
// so translating Rect (and the geometry arrays) is all that is needed.
export function moveMarkup(doc, key, dx, dy) {
  const { dict } = findAnnot(doc, key);
  const shift = (i) => (v, k) => v + ((k + i) % 2 === 0 ? dx : dy);
  mapNums(doc, dict, 'Rect', shift(0));
  for (const k of ['Vertices', 'L', 'CL', 'QuadPoints']) mapNums(doc, dict, k, shift(0));
  const ink = get(doc, dict, 'InkList');
  if (ink instanceof PDFArray) {
    ink.asArray().forEach((s, i) => {
      const arr = lookup(doc, s);
      if (arr instanceof PDFArray) ink.set(i, doc.context.obj(arr.asArray().map((n, k) => lookup(doc, n).asNumber() + (k % 2 === 0 ? dx : dy))));
    });
  }
  touch(doc, dict);
}

// Rebuilds a markup's spec from its dictionary (for restyling / re-laying-out).
async function specFromDict(doc, dict) {
  const subtype = getName(doc, dict, 'Subtype');
  const intent = getName(doc, dict, 'IT');
  const be = get(doc, dict, 'BE');
  const cloud = subtype === 'Polygon' && (intent === 'PolygonCloud' || be instanceof PDFDict);
  const kind = cloud ? 'PolygonCloud' : intent === 'LineArrow' ? 'LineArrow' : intent === 'FreeTextCallout' ? 'FreeTextCallout' : subtype;
  const da = readDA(getStr(doc, dict, 'DA'));
  const c = getNums(doc, dict, 'C');
  const ic = getNums(doc, dict, 'IC');
  const bs = get(doc, dict, 'BS');
  const lw = bs instanceof PDFDict ? getNum(doc, bs, 'W') : undefined;
  const rect = getNums(doc, dict, 'Rect');
  const spec = {
    kind, pageIndex: 0,
    color: kind === 'FreeText' || kind === 'FreeTextCallout' ? (da.color || REVU_RED) : (c ? rgbToHex(c) : REVU_RED),
    fill: kind === 'FreeText' || kind === 'FreeTextCallout' ? (c ? rgbToHex(c) : null) : (ic ? rgbToHex(ic) : null),
    lineWidth: lw, fontSize: da.fontSize, opacity: getNum(doc, dict, 'CA') ?? 1,
    text: getStr(doc, dict, 'Contents') || '', rect,
  };
  if (kind === 'FreeTextCallout') {
    const cl = getNums(doc, dict, 'CL');
    const rd = getNums(doc, dict, 'RD') || [0, 0, 0, 0];
    if (cl && cl.length >= 4) spec.tip = [cl[0], cl[1]];
    spec.rect = [rect[0] + rd[0], rect[1] + rd[1], rect[2] - rd[2], rect[3] - rd[3]];
  }
  if (kind === 'Line' || kind === 'LineArrow') {
    const l = getNums(doc, dict, 'L');
    spec.p1 = [l[0], l[1]]; spec.p2 = [l[2], l[3]];
    const le = get(doc, dict, 'LE');
    if (le instanceof PDFArray) spec.ends = le.asArray().map((x) => lookup(doc, x).decodeText());
  }
  if (kind === 'PolygonCloud') {
    const v = getNums(doc, dict, 'Vertices') || [];
    spec.points = [];
    for (let i = 0; i + 1 < v.length; i += 2) spec.points.push([v[i], v[i + 1]]);
  }
  if (kind === 'Highlight' || kind === 'Underline' || kind === 'StrikeOut') {
    const q = getNums(doc, dict, 'QuadPoints') || [];
    spec.quads = [];
    for (let i = 0; i + 7 < q.length; i += 8) spec.quads.push(q.slice(i, i + 8));
  }
  if (kind === 'Ink') {
    const ink = get(doc, dict, 'InkList');
    spec.strokes = (ink instanceof PDFArray ? ink.asArray() : []).map((s) => {
      const arr = lookup(doc, s).asArray().map((n) => lookup(doc, n).asNumber());
      const pts = [];
      for (let i = 0; i + 1 < arr.length; i += 2) pts.push([arr[i], arr[i + 1]]);
      return pts;
    });
  }
  if (kind === 'Stamp') { spec.stampKey = getName(doc, dict, 'Name'); }
  if (kind === 'Text') spec.p1 = [rect[0], rect[3]];
  return spec;
}

const REGEN = new Set(['FreeText', 'FreeTextCallout', 'Line', 'LineArrow', 'Square', 'Circle', 'PolygonCloud', 'Highlight', 'Underline', 'StrikeOut', 'Ink', 'Text', 'Stamp']);

// Re-draws a markup's appearance after a style/text/geometry change.
// patch: { color, fill, lineWidth, fontSize, opacity, text, rect, p1, p2 }
export async function restyleMarkup(doc, key, patch) {
  const { dict } = findAnnot(doc, key);
  const spec = await specFromDict(doc, dict);
  if (!REGEN.has(spec.kind)) throw new Error(`Cannot edit a ${spec.kind} markup`);
  const next = { ...spec };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
  const geom = await geometryFor(doc, next);
  const apRef = await buildAppearance(doc, next, geom);
  const s = styleOf(next);
  dict.set(PDFName.of('AP'), doc.context.obj({ N: apRef }));
  dict.set(PDFName.of('Rect'), doc.context.obj(geom.rect));
  // a stale rich-text body would override the new text/colour in other viewers
  dict.delete(PDFName.of('RC'));
  const rgbArr = (hex) => hexToRgb(hex).map((v) => Math.round(v * 1000) / 1000);
  const kind = next.kind;
  if (kind === 'FreeText' || kind === 'FreeTextCallout') {
    dict.set(PDFName.of('Contents'), textObj(next.text || ''));
    dict.set(PDFName.of('DA'), PDFString.of(`${rg(s.color)} rg /Helvetica ${N(s.fontSize)} Tf`));
    dict.set(PDFName.of('DS'), PDFString.of(`font: Helvetica ${N(s.fontSize)}pt; text-align: left; text-vertical-align: top; color: ${s.color}`));
    dict.set(PDFName.of('BS'), doc.context.obj({ W: s.lineWidth }));
    if (s.fill) dict.set(PDFName.of('C'), doc.context.obj(rgbArr(s.fill))); else dict.delete(PDFName.of('C'));
    if (kind === 'FreeTextCallout' && geom.cl) { dict.set(PDFName.of('CL'), doc.context.obj(geom.cl)); dict.set(PDFName.of('RD'), doc.context.obj(geom.rd)); }
  } else {
    if (kind !== 'Stamp') dict.set(PDFName.of('C'), doc.context.obj(rgbArr(s.color)));
    if (kind === 'Square' || kind === 'Circle') { if (s.fill) dict.set(PDFName.of('IC'), doc.context.obj(rgbArr(s.fill))); else dict.delete(PDFName.of('IC')); }
    if (['Line', 'LineArrow', 'Square', 'Circle', 'PolygonCloud', 'Ink'].includes(kind)) dict.set(PDFName.of('BS'), doc.context.obj({ W: s.lineWidth }));
    if (kind === 'Line' || kind === 'LineArrow') dict.set(PDFName.of('L'), doc.context.obj([...next.p1, ...next.p2]));
    if (next.text !== undefined && kind === 'Text') dict.set(PDFName.of('Contents'), textObj(next.text));
    if (s.opacity < 1) dict.set(PDFName.of('CA'), PDFNumber.of(s.opacity));
  }
  touch(doc, dict);
}

// Sets only the note/comment text of any markup (no re-draw for non-text kinds).
export async function setMarkupText(doc, key, text) {
  const { dict } = findAnnot(doc, key);
  const sub = getName(doc, dict, 'Subtype');
  if (sub === 'FreeText') return restyleMarkup(doc, key, { text });
  dict.set(PDFName.of('Contents'), textObj(text));
  dict.delete(PDFName.of('RC'));
  touch(doc, dict);
  return undefined;
}

export function deleteMarkup(doc, key) {
  const ref = refFromKey(key);
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i);
      if (r instanceof PDFRef && r.objectNumber === ref.objectNumber) {
        // also drop a popup that belonged to it
        annots.remove(i);
        const dict = doc.context.lookup(ref);
        if (dict instanceof PDFDict) {
          const popup = dict.get(PDFName.of('Popup'));
          if (popup instanceof PDFRef) {
            for (let j = annots.size() - 1; j >= 0; j--) {
              const pr = annots.get(j);
              if (pr instanceof PDFRef && pr.objectNumber === popup.objectNumber) annots.remove(j);
            }
          }
        }
        return true;
      }
    }
  }
  return false;
}

void PDFStream;
