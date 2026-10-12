// Finds text in the document and returns where it is on the page, so it can be
// marked for redaction. Works from pdf.js's text items (so it also finds the
// text layer added by OCR). Positions inside an item are proportional to
// character count — close enough for marking, and marks are padded slightly so
// a proportional font's rounding errs on the side of covering more, not less.

export const PRESETS = [
  { key: 'email', label: 'Email addresses', pattern: String.raw`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`, regex: true },
  { key: 'phone', label: 'Phone numbers', pattern: String.raw`(?:\+?\d{1,3}[\s\-]?)?(?:\(?0?\d{2,3}\)?[\s\-]?)\d{3}[\s\-]?\d{3,4}`, regex: true },
  { key: 'said', label: 'South African ID numbers (13 digits)', pattern: String.raw`\b\d{13}\b`, regex: true },
  { key: 'vat', label: 'VAT numbers (10 digits starting 4)', pattern: String.raw`\b4\d{9}\b`, regex: true },
  { key: 'amount', label: 'Amounts (R / $ / € values)', pattern: String.raw`[R$€£]\s?\d[\d\s,.]*\d`, regex: true },
  { key: 'date', label: 'Dates (2026/01/27, 27-01-2026 …)', pattern: String.raw`\b(?:\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b`, regex: true },
  { key: 'account', label: 'Long numbers (card / account, 9+ digits)', pattern: String.raw`\b\d[\d\s\-]{7,}\d\b`, regex: true },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildRegex(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
  if (!query) throw new Error('Type something to search for.');
  let src = regex ? query : escapeRegex(query);
  if (wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, `g${matchCase ? '' : 'i'}`);
}

// A rectangle (PDF user space) for characters [c0, c1) of a text item.
function itemRect(item, c0, c1, pad) {
  const [a, b, c, d, e, f] = item.transform;
  const len = item.str.length || 1;
  const w = item.width || 0;
  const dl = Math.hypot(a, b) || 1;
  const ul = Math.hypot(c, d) || 1;
  const dir = [a / dl, b / dl];
  const up = [c / ul, d / ul];
  const h = item.height || ul;
  const p0 = [e + dir[0] * (w * c0) / len, f + dir[1] * (w * c0) / len];
  const p1 = [e + dir[0] * (w * c1) / len, f + dir[1] * (w * c1) / len];
  const pts = [
    [p0[0] - up[0] * 0.22 * h, p0[1] - up[1] * 0.22 * h],
    [p1[0] - up[0] * 0.22 * h, p1[1] - up[1] * 0.22 * h],
    [p0[0] + up[0] * 0.92 * h, p0[1] + up[1] * 0.92 * h],
    [p1[0] + up[0] * 0.92 * h, p1[1] + up[1] * 0.92 * h],
  ];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
  const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Returns [{ pageIndex, rects: [{x,y,width,height}], text, before, after }].
export async function findText(engine, query, options = {}, onProgress) {
  const re = buildRegex(query, options);
  const results = [];
  const total = engine.getPageCount();
  const LIMIT = 5000;
  for (let p = 0; p < total; p++) {
    onProgress?.(p + 1, total);
    const page = await engine.renderDoc.getPage(p + 1);
    const { items } = await page.getTextContent();
    let full = '';
    const segs = [];
    for (const item of items) {
      if (!item.str) { if (item.hasEOL) full += '\n'; continue; }
      const start = full.length;
      full += item.str;
      segs.push({ start, end: full.length, item });
      full += item.hasEOL ? '\n' : (/\s$/.test(item.str) ? '' : ' ');
    }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(full)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      const s = m.index, e = m.index + m[0].length;
      const rects = [];
      for (const seg of segs) {
        if (seg.end <= s || seg.start >= e) continue;
        const c0 = Math.max(s, seg.start) - seg.start;
        const c1 = Math.min(e, seg.end) - seg.start;
        if (c1 > c0) rects.push(itemRect(seg.item, c0, c1, 1));
      }
      if (rects.length) {
        results.push({
          pageIndex: p,
          rects,
          text: m[0].replace(/\s+/g, ' '),
          before: full.slice(Math.max(0, s - 24), s).replace(/\s+/g, ' '),
          after: full.slice(e, e + 24).replace(/\s+/g, ' '),
        });
      }
      if (results.length >= LIMIT) return results;
    }
  }
  return results;
}
