// Page layout analysis, used by the Word and Excel exporters.
//
// A PDF has no paragraphs, tables or columns — only glyphs placed at
// coordinates and lines drawn on a page. To export something editable we have
// to recover that structure:
//
//   1. text items (pdf.js)  -> runs with font / size / bold / italic / colour
//   2. ruled tables         -> found from the *rendered pixels*: long thin dark
//                              horizontal + vertical lines that meet. Working
//                              from pixels (not the drawing commands) means the
//                              same code finds the grid in a scanned table,
//                              which is just a picture of lines.
//   3. images & line-art    -> images from the page's operator list; vector
//                              artwork (logos, diagrams) from ink left over
//                              once text, tables and images are accounted for
//   4. XY-cut               -> everything else is split by whitespace into
//                              bands (stacked) and columns (side by side),
//                              recursively, giving reading order and layout
//   5. paragraphs           -> lines inside a block are merged into paragraphs
//                              with alignment, indent and spacing
//
// All coordinates here are in points, origin top-left, y down.

const ASC = 0.8;  // fraction of font size above the baseline used for a text box
const DESC = 0.2; // ... and below it

// ---------------------------------------------------------------------------
// small helpers

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function bbox(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0);
    x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1);
  }
  return { x0, y0, x1, y1 };
}

function rectArea(r) { return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0); }

function intersectArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

// Groups sorted-able numbers into clusters whose neighbours are within `tol`.
function clusterValues(values, tol) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  let cur = [];
  for (const v of sorted) {
    if (cur.length && v - cur[cur.length - 1] > tol) { out.push(cur); cur = []; }
    cur.push(v);
  }
  if (cur.length) out.push(cur);
  return out.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

// Most common colour (5 bits/channel buckets, then averaged) among the pixels
// `include(x, y)` selects. Returns [r, g, b] in 0-255, or null.
function dominantRgb(data, w, x0, y0, x1, y1, include) {
  const buckets = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (include && !include(x, y)) continue;
      const i = (y * w + x) * 4;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      const b = buckets.get(key);
      if (b) { b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; }
      else buckets.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
    }
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
}

const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const rgbHex = (c) => `${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`.toUpperCase();

// ---------------------------------------------------------------------------
// rendering the page for pixel analysis

async function renderRaster(page, W, H) {
  // 2 px per point normally; capped so a huge drawing sheet stays affordable.
  const s = Math.min(2, Math.sqrt(14e6 / (W * H)));
  const viewport = page.getViewport({ scale: s });
  const w = Math.ceil(viewport.width);
  const h = Math.ceil(viewport.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return { canvas, ctx, data, gray, w, h, s };
}

// ---------------------------------------------------------------------------
// skew (scans)

// Finds the rotation that makes the page's dark pixels line up in horizontal
// rows (text lines and table rules): the angle whose row-histogram is the
// most "peaky". Returns radians to rotate by (0 if the page is already straight).
function estimateSkew(raster) {
  const { gray, w, h } = raster;
  const pts = [];
  for (let y = 0; y < h; y += 2) {
    const row = y * w;
    for (let x = 0; x < w; x += 2) if (gray[row + x] < 150) pts.push(x, y);
  }
  if (pts.length < 4000) return 0;
  const cx = w / 2, cy = h / 2;
  const nb = Math.ceil(h * 1.3) + 16;
  const off = h * 0.15;
  const score = (phi) => {
    const sin = Math.sin(phi), cos = Math.cos(phi);
    const bins = new Float64Array(nb);
    for (let i = 0; i < pts.length; i += 2) {
      const y = sin * (pts[i] - cx) + cos * (pts[i + 1] - cy) + cy + off;
      const b = (y / 2) | 0;
      if (b >= 0 && b < nb) bins[b]++;
    }
    let sum = 0;
    for (let i = 0; i < nb; i++) sum += bins[i] * bins[i];
    return sum;
  };
  const deg = Math.PI / 180;
  const base = score(0);
  let best = 0, bestScore = base;
  for (let d = -3; d <= 3.0001; d += 0.25) {
    const sc = score(d * deg);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  for (let d = best - 0.25; d <= best + 0.2501; d += 0.05) {
    const sc = score(d * deg);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  if (Math.abs(best) < 0.2 || bestScore < base * 1.02) return 0;
  return best * deg;
}

// Rotates the analysis raster in place (about its centre) by phi radians.
function rotateRaster(raster, phi) {
  const { canvas, w, h } = raster;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(phi);
  ctx.translate(-w / 2, -h / 2);
  ctx.drawImage(canvas, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  canvas.width = canvas.height = 0;
  raster.canvas = out;
  raster.ctx = ctx;
  raster.data = data;
  raster.gray = gray;
}

// ---------------------------------------------------------------------------
// text

function cleanFontName(raw, generic) {
  let n = (raw || '').replace(/^[A-Z]{6}\+/, '');
  let prev;
  do {
    prev = n;
    n = n.replace(/[-,_ ]?(Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|Medium|Semibold|SemiBold|Black|Heavy|Light|Book|MT|PS|PSMT|Std|Pro|Cond|Condensed)$/i, '');
  } while (n !== prev && n);
  // symbol fonts: the text already carries real Unicode (a bullet is U+2022), and
  // Word would draw it from a symbol font that lacks it — use an ordinary one
  if (/^(symbol|wingdings|webdings|zapfdingbats|dingbats|marlett)/i.test(n)) return 'Arial';
  if (/^arial/i.test(n) || /^helvetica/i.test(n)) return 'Arial';
  if (/^times/i.test(n)) return 'Times New Roman';
  if (/^courier/i.test(n)) return 'Courier New';
  n = n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
  if (!n || /^g_d\d/i.test(n)) {
    return generic === 'monospace' ? 'Courier New' : generic === 'serif' ? 'Times New Roman' : 'Arial';
  }
  return n;
}

function describeFont(page, fontName, style) {
  let raw = '';
  try {
    if (page.commonObjs.has(fontName)) raw = page.commonObjs.get(fontName)?.name || '';
  } catch { /* font object not available */ }
  const generic = style?.fontFamily || 'sans-serif';
  const lower = raw.toLowerCase();
  return {
    name: cleanFontName(raw, generic),
    bold: /bold|black|heavy|semibold|demi|[-,]bd/.test(lower),
    italic: /italic|oblique|[-,]it(?![a-z])/.test(lower),
    generic,
  };
}

async function extractItems(page, vp) {
  const tc = await page.getTextContent();
  const m = vp.transform;
  const fontCache = new Map();
  const items = [];
  let rotated = 0;
  for (const it of tc.items) {
    if (!it.str) continue;
    if (!it.str.trim()) {
      // a space between two items: remember it on the one before, so the gap
      // isn't mistaken for "no space" (word spacing is rebuilt from these)
      const last = items[items.length - 1];
      if (last && !/\s$/.test(last.str)) {
        const base = vp.transform[1] * it.transform[4] + vp.transform[3] * it.transform[5] + vp.transform[5];
        if (Math.abs(base - last.base) < 0.3 * last.fs) last.str += ' ';
      }
      continue;
    }
    const t = it.transform;
    const a = m[0] * t[0] + m[2] * t[1];
    const b = m[1] * t[0] + m[3] * t[1];
    const c = m[0] * t[2] + m[2] * t[3];
    const d = m[1] * t[2] + m[3] * t[3];
    const fs = Math.hypot(c, d);
    if (!fs || fs < 1) continue;
    if (Math.abs(Math.atan2(b, a)) > 0.12) { rotated++; continue; } // sideways/vertical text isn't part of the flow
    let font = fontCache.get(it.fontName);
    if (!font) {
      font = describeFont(page, it.fontName, tc.styles[it.fontName]);
      fontCache.set(it.fontName, font);
    }
    const x = m[0] * t[4] + m[2] * t[5] + m[4];
    const y = m[1] * t[4] + m[3] * t[5] + m[5];
    const trailing = (it.str.match(/\s+$/) || [''])[0].length;
    const symbolic = /[\uE000-\uF8FF]/.test(it.str);
    if (symbolic) font = { ...font, name: 'Arial', bold: false, italic: false };
    items.push({ str: it.str.replace(/[\uE000-\uF8FF]/g, '\u2022'), x0: x, x1: x + (it.width || 0) * vp.scale - trailing * 0.28 * fs, base: y, fs, font });
  }
  return { items, rotated };
}

// A run of text can straddle a table's column border (OCR in particular joins
// "1300,00" and the next cell's "CPT Client Visits" into one run). Cut it at
// each border it crosses so every piece lands in the cell it belongs to.
function splitAtCuts(it, cuts) {
  const len = it.str.length;
  const w = it.x1 - it.x0;
  if (len < 2 || w <= 0) return [it];
  const idxs = [];
  for (const cut of cuts) {
    if (cut <= it.x0 + 2 || cut >= it.x1 - 2) continue;
    let i = Math.round(((cut - it.x0) / w) * len);
    for (let d = 0; d <= 3; d++) {
      if (it.str[i + d] === ' ') { i += d; break; }
      if (it.str[i - d] === ' ') { i -= d; break; }
    }
    if (i > 0 && i < len && !idxs.includes(i)) idxs.push(i);
  }
  if (!idxs.length) return [it];
  idxs.sort((a, b) => a - b);
  const out = [];
  let from = 0;
  for (const i of [...idxs, len]) {
    const str = it.str.slice(from, i);
    if (str.trim()) {
      out.push({ ...it, str: str.trim(), x0: it.x0 + (w * from) / len, x1: it.x0 + (w * i) / len });
    }
    from = i;
  }
  return out;
}

// Items that sit on the same baseline form a line.
function groupLines(items) {
  const sorted = [...items].sort((p, q) => p.base - q.base || p.x0 - q.x0);
  const lines = [];
  for (const it of sorted) {
    let line = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 6; k--) {
      const l = lines[k];
      if (Math.abs(l.base - it.base) <= 0.35 * Math.min(l.fs, it.fs)) { line = l; break; }
    }
    if (!line) { line = { items: [], base: it.base, fs: it.fs }; lines.push(line); }
    line.items.push(it);
    line.fs = Math.max(line.fs, it.fs);
  }
  for (const l of lines) finishLine(l);
  return lines.sort((p, q) => p.base - q.base);
}

function finishLine(l) {
  l.items.sort((p, q) => p.x0 - q.x0);
  l.base = median(l.items.map((i) => i.base));
  l.fs = Math.max(...l.items.map((i) => i.fs));
  l.x0 = l.items[0].x0;
  l.x1 = Math.max(...l.items.map((i) => i.x1));
  l.top = l.base - ASC * l.fs;
  l.bottom = l.base + DESC * l.fs;
  return l;
}

// Turns a line's items into styled runs; adjacent items in the same style
// merge, ordinary word gaps become spaces, and a wide gap (a label and its
// value, say) becomes a tab, with its stop position recorded in `tabs` so Word
// can line the value up exactly where it was.
function buildRuns(items, tabs) {
  const runs = [];
  let prev = null;
  for (const it of items) {
    let pre = '';
    if (prev) {
      const gap = it.x0 - prev.x1;
      if (gap >= Math.max(1.0 * it.fs, 6)) {
        pre = '\t';
        tabs?.push(it.x0);
      } else if (gap > 0.12 * it.fs && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) {
        pre = ' '.repeat(Math.max(1, Math.min(4, Math.round(gap / (0.28 * it.fs)))));
      }
    }
    const cur = runs[runs.length - 1];
    const sameStyle = cur && cur.font.name === it.font.name && cur.font.bold === it.font.bold
      && cur.font.italic === it.font.italic && Math.abs(cur.fs - it.fs) < 0.6
      && (cur.color || null) === (it.color || null) && !!cur.underline === !!it.underline;
    if (sameStyle) {
      cur.text += pre + it.str;
      cur.x1 = it.x1;
    } else {
      if (cur) cur.text += pre;
      runs.push({ text: it.str, font: it.font, fs: it.fs, x0: it.x0, x1: it.x1, base: it.base, color: it.color || null, underline: !!it.underline });
    }
    prev = it;
  }
  return runs;
}

// Ink colour of a run: the pixels that differ most from the run's own
// background. Returns a 'RRGGBB' string, or null for ordinary black text.
function sampleRunColor(raster, run) {
  const { data, w, h, s } = raster;
  const x0 = Math.max(0, Math.floor(run.x0 * s));
  const x1 = Math.min(w, Math.ceil(run.x1 * s));
  const y0 = Math.max(0, Math.floor((run.base - ASC * run.fs) * s));
  const y1 = Math.min(h, Math.ceil((run.base + DESC * run.fs) * s));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const bg = dominantRgb(data, w, x0, y0, x1, y1);
  if (!bg) return null;
  const px = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > 150) px.push([d, data[i], data[i + 1], data[i + 2]]);
    }
  }
  if (px.length < 4) return null;
  px.sort((p, q) => q[0] - p[0]);
  const top = px.slice(0, Math.max(3, Math.floor(px.length * 0.15)));
  const c = [0, 1, 2].map((k) => top.reduce((sum, p) => sum + p[k + 1], 0) / top.length);
  if (c[0] < 80 && c[1] < 80 && c[2] < 80) return null; // black
  if (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 28 && c[0] < 110) return null; // dark grey ≈ black
  return rgbHex(c);
}

function lineText(l) {
  return l.runs.map((r) => r.text).join('').replace(/\t/g, ' ');
}

// ---------------------------------------------------------------------------
// ruled tables, from pixels

// Finds long thin dark runs (horizontal or vertical). Runs in consecutive
// rows that overlap are stacked into one segment, and segments that turn out
// thick (a filled bar) are discarded. Segments are returned as
// {a0, a1, c, t}: extent along the line, position across it, thickness.
function findSegments(mask, w, h, horizontal, minLen, maxThick) {
  const nOuter = horizontal ? h : w;
  const nInner = horizontal ? w : h;
  const at = horizontal ? (o, i) => mask[o * w + i] : (o, i) => mask[i * w + o];
  let active = [];
  const done = [];
  for (let o = 0; o < nOuter; o++) {
    const runs = [];
    let i = 0;
    while (i < nInner) {
      if (!at(o, i)) { i++; continue; }
      const start = i;
      let end = i;
      let k = i + 1;
      while (k < nInner) {
        if (at(o, k)) { end = k; k++; }
        else if (k + 1 < nInner && at(o, k + 1)) k++; // bridge a one-pixel gap
        else break;
      }
      if (end - start + 1 >= minLen) runs.push([start, end]);
      i = end + 1;
    }
    const next = [];
    const taken = new Set();
    for (const [a, b] of runs) {
      let seg = null;
      for (const s of active) {
        if (taken.has(s)) continue;
        const ov = Math.min(s.a1, b) - Math.max(s.a0, a) + 1;
        if (ov >= 0.5 * Math.min(s.a1 - s.a0 + 1, b - a + 1)) { seg = s; break; }
      }
      if (seg) {
        taken.add(seg);
        seg.a0 = Math.min(seg.a0, a);
        seg.a1 = Math.max(seg.a1, b);
        seg.t++;
        seg.sum += o;
        next.push(seg);
      } else {
        next.push({ a0: a, a1: b, t: 1, sum: o });
      }
    }
    for (const s of active) if (!taken.has(s)) done.push(s);
    active = next;
  }
  for (const s of active) done.push(s);
  return done
    .filter((s) => s.t <= maxThick)
    .map((s) => ({ a0: s.a0, a1: s.a1, c: s.sum / s.t, t: s.t }));
}

// Re-joins collinear segments broken by a gap (dashed borders, or a line
// interrupted where another crosses it).
function mergeCollinear(segs, posTol, gapTol) {
  const sorted = [...segs].sort((p, q) => p.c - q.c);
  const groups = [];
  for (const s of sorted) {
    const g = groups[groups.length - 1];
    if (g && s.c - g[g.length - 1].c <= posTol) g.push(s); else groups.push([s]);
  }
  const out = [];
  for (const g of groups) {
    g.sort((p, q) => p.a0 - q.a0);
    let cur = null;
    for (const s of g) {
      if (cur && s.a0 - cur.a1 <= gapTol) {
        cur.a1 = Math.max(cur.a1, s.a1);
        cur.t = Math.max(cur.t, s.t);
        cur.c = (cur.c * cur.n + s.c) / (cur.n + 1);
        cur.n++;
      } else {
        if (cur) out.push(cur);
        cur = { ...s, n: 1 };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function coverage(segs, c, tol, a0, a1) {
  // fraction of [a0, a1] covered by segments lying on position c
  const iv = segs
    .filter((s) => Math.abs(s.c - c) <= tol && s.a1 >= a0 && s.a0 <= a1)
    .map((s) => [Math.max(s.a0, a0), Math.min(s.a1, a1)])
    .sort((p, q) => p[0] - q[0]);
  let covered = 0;
  let end = -Infinity;
  for (const [p, q] of iv) {
    const from = Math.max(p, end);
    if (q > from) covered += q - from;
    end = Math.max(end, q);
  }
  return a1 > a0 ? covered / (a1 - a0) : 0;
}

function detectTables(raster, photoRects, W, H) {
  const { gray, data, w, h, s } = raster;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = gray[i] < 175 ? 1 : 0;
  // photos make a mess of "lines" — blank them out (scans are kept: they're mostly white)
  for (const r of photoRects) {
    const x0 = Math.max(0, Math.floor(r.x0 * s)), x1 = Math.min(w, Math.ceil(r.x1 * s));
    const y0 = Math.max(0, Math.floor(r.y0 * s)), y1 = Math.min(h, Math.ceil(r.y1 * s));
    for (let y = y0; y < y1; y++) mask.fill(0, y * w + x0, y * w + x1);
  }

  const minLen = Math.round(10 * s);
  const maxThick = Math.round(3.2 * s) + 1;
  let Hs = mergeCollinear(findSegments(mask, w, h, true, minLen, maxThick), 2, 6 * s / 2);
  let Vs = mergeCollinear(findSegments(mask, w, h, false, minLen, maxThick), 2, 6 * s / 2);
  const hsegs = Hs.map((g) => ({ x0: g.a0 / s, x1: g.a1 / s, y: g.c / s }));
  if (Hs.length + Vs.length > 2500 || Hs.length * Vs.length > 1.5e6) return { tables: [], hsegs }; // a drawing, not a form

  // union-find over segments that touch
  const n = Hs.length + Vs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const tol = 4;
  for (let i = 0; i < Hs.length; i++) {
    const hs = Hs[i];
    for (let j = 0; j < Vs.length; j++) {
      const vs = Vs[j];
      if (vs.c >= hs.a0 - tol && vs.c <= hs.a1 + tol && hs.c >= vs.a0 - tol && hs.c <= vs.a1 + tol) {
        parent[find(i)] = find(Hs.length + j);
      }
    }
  }
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, { H: [], V: [] });
    if (i < Hs.length) comps.get(r).H.push(Hs[i]); else comps.get(r).V.push(Vs[i - Hs.length]);
  }

  const tables = [];
  for (const comp of comps.values()) {
    if (comp.H.length < 2 || comp.V.length < 2) continue;
    const xs = clusterValues(comp.V.map((v) => v.c), 3);
    const ys = clusterValues(comp.H.map((v) => v.c), 3);
    if (xs.length < 2 || ys.length < 2) continue;
    const nr = ys.length - 1;
    const nc = xs.length - 1;
    if (nr * nc > 2500) continue;
    const spanW = xs[xs.length - 1] - xs[0];
    const spanH = ys[ys.length - 1] - ys[0];
    if (spanW < 12 * s || spanH < 6 * s) continue;

    // walls between neighbouring grid cells
    const wallR = Array.from({ length: nr }, () => new Array(nc).fill(false));
    const wallB = Array.from({ length: nr }, () => new Array(nc).fill(false));
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) {
        wallR[r][c] = c === nc - 1 || coverage(comp.V, xs[c + 1], 4, ys[r] + 2, ys[r + 1] - 2) >= 0.6;
        wallB[r][c] = r === nr - 1 || coverage(comp.H, ys[r + 1], 4, xs[c] + 2, xs[c + 1] - 2) >= 0.6;
      }
    }
    // merge un-walled neighbours into spanning cells (greedy rectangles)
    const seen = Array.from({ length: nr }, () => new Array(nc).fill(false));
    const cells = [];
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) {
        if (seen[r][c]) continue;
        let cs = 1;
        while (c + cs < nc && !wallR[r][c + cs - 1] && !seen[r][c + cs]) cs++;
        let rs = 1;
        while (r + rs < nr) {
          let ok = true;
          for (let cc = c; cc < c + cs && ok; cc++) {
            if (wallB[r + rs - 1][cc] || seen[r + rs][cc]) ok = false;
            if (cc < c + cs - 1 && wallR[r + rs][cc]) ok = false;
          }
          if (ok && !wallR[r + rs][c + cs - 1]) ok = false;
          if (!ok) break;
          rs++;
        }
        for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) seen[rr][cc] = true;
        cells.push({ r, c, rs, cs });
      }
    }

    // appearance: line thickness and per-cell shading
    const thick = median([...comp.H, ...comp.V].map((q) => q.t)) / s;
    const t = {
      xs: xs.map((v) => v / s),
      ys: ys.map((v) => v / s),
      lineWidth: Math.max(0.5, Math.min(2.5, thick)),
      cells: cells.map((cell) => {
        const rect = { x0: xs[cell.c] / s, y0: ys[cell.r] / s, x1: xs[cell.c + cell.cs] / s, y1: ys[cell.r + cell.rs] / s };
        const inset = Math.round(3 * s);
        const px0 = Math.round(xs[cell.c] + inset), px1 = Math.round(xs[cell.c + cell.cs] - inset);
        const py0 = Math.round(ys[cell.r] + inset), py1 = Math.round(ys[cell.r + cell.rs] - inset);
        let bg = null;
        if (px1 - px0 > 4 && py1 - py0 > 4) {
          const ring = Math.min(4, Math.floor((px1 - px0) / 3), Math.floor((py1 - py0) / 3));
          const c = dominantRgb(data, w, px0, py0, px1, py1,
            (x, y) => x < px0 + ring || x >= px1 - ring || y < py0 + ring || y >= py1 - ring);
          if (c && !(c[0] > 238 && c[1] > 238 && c[2] > 238)) bg = rgbHex(c);
        }
        return { ...cell, rect, bg, items: [] };
      }),
    };
    t.rect = { x0: t.xs[0], y0: t.ys[0], x1: t.xs[t.xs.length - 1], y1: t.ys[t.ys.length - 1] };
    tables.push(t);
  }
  // discard tables nested inside a larger one (inner grids are already cells' content)
  const kept = tables
    .filter((a) => !tables.some((b) => b !== a && rectArea(b.rect) > rectArea(a.rect)
      && intersectArea(a.rect, b.rect) > 0.9 * rectArea(a.rect)))
    .sort((a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0);
  return { tables: kept, hsegs };
}

// ---------------------------------------------------------------------------
// paragraphs

const BULLET = /^\s*([•●○◦▪■□–—\-*·]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s/;

// Lines are only joined into one flowing paragraph when the block really looks
// like wrapped prose: several lines running right up to the same right edge,
// and the next line's first word genuinely wouldn't have fitted on the
// previous one. Anything else (addresses, footers, lists, headings) keeps its
// own line breaks — Word would otherwise re-wrap it with different font metrics.
function shouldMerge(prev, next, blockLeft, blockRight, longLines) {
  const pitch = next.base - prev.base;
  if (pitch > prev.fs * 1.65 || pitch < prev.fs * 0.5) return false;
  if (Math.abs(next.fs - prev.fs) > 1.2) return false;
  if (longLines < 2) return false;
  const width = blockRight - blockLeft;
  if (prev.x1 < blockRight - Math.max(0.04 * width, 1.2 * prev.fs)) return false; // previous line stopped short: paragraph ended
  const firstWord = lineText(next).trim().split(/\s+/)[0] || '';
  if (blockRight - prev.x1 > firstWord.length * 0.5 * prev.fs * 1.1) return false; // there was room: the break was deliberate
  if (next.x0 > blockLeft + 1.5 * prev.fs && prev.x0 <= blockLeft + 1) return false; // first-line indent
  if (BULLET.test(lineText(next))) return false;
  const dom = (l) => l.runs.reduce((a, r) => (r.text.length > a.text.length ? r : a), l.runs[0]);
  if (dom(prev).font.bold !== dom(next).font.bold) return false;
  return true;
}

function buildParagraphs(lines, container) {
  if (!lines.length) return [];
  const blockLeft = Math.min(...lines.map((l) => l.x0));
  const blockRight = Math.max(...lines.map((l) => l.x1));
  const groups = [];
  const longLines = lines.filter((l) => l.x1 >= blockRight - Math.max(0.08 * (blockRight - blockLeft), 2 * l.fs)).length;
  for (const ln of lines) {
    const g = groups[groups.length - 1];
    if (g && shouldMerge(g[g.length - 1], ln, blockLeft, blockRight, longLines)) g.push(ln); else groups.push([ln]);
  }
  const cw = container.x1 - container.x0;
  const paras = groups.map((g) => {
    const x0 = Math.min(...g.map((l) => l.x0));
    const x1 = Math.max(...g.map((l) => l.x1));
    const fs = median(g.map((l) => l.fs));
    const pitches = g.slice(1).map((l, i) => l.base - g[i].base);
    const lineH = pitches.length ? Math.max(fs, median(pitches)) : Math.round(fs * 1.2 * 10) / 10;
    const tol = Math.max(3, 0.015 * cw);
    const centre = (container.x0 + container.x1) / 2;
    const left = x0 - container.x0;
    let align = 'left';
    if (g.every((l) => Math.abs((l.x0 + l.x1) / 2 - centre) <= tol) && left > 4 * tol) align = 'center';
    else if (g.every((l) => Math.abs(container.x1 - l.x1) <= tol) && left > 4 * tol) align = 'right';
    else if (g.length >= 2 && g.slice(0, -1).every((l) => Math.abs(l.x1 - x1) <= tol) && g.every((l, i) => i === 0 || Math.abs(l.x0 - x0) <= tol)) align = 'justify';
    let firstLine = 0;
    if (g.length > 1) {
      const rest = Math.min(...g.slice(1).map((l) => l.x0));
      const d = g[0].x0 - rest;
      if (d > 0.8 * fs && d < 8 * fs) firstLine = d;
    }
    return {
      lines: g, x0, x1, fs, lineH, align, firstLine, container,
      indentLeft: align === 'center' || align === 'right' ? 0 : Math.max(0, x0 - container.x0 + (firstLine < 0 ? firstLine : 0)),
      indentRight: align === 'left' || align === 'justify' ? (g.length > 1 ? Math.max(0, container.x1 - x1) : 0) : 0,
      firstBase: g[0].base,
      lastBase: g[g.length - 1].base,
      // where Word's exact-height line box would put the paragraph's top / bottom edge
      top: g[0].base - lineH + 0.21 * g[0].fs,
      bottom: g[g.length - 1].base + 0.21 * g[g.length - 1].fs,
    };
  });
  // paragraph spacing: distance between baselines beyond one line height
  for (let i = 0; i < paras.length; i++) {
    paras[i].spaceBefore = i === 0 ? 0 : Math.max(0, paras[i].firstBase - paras[i - 1].lastBase - paras[i].lineH);
  }
  return paras;
}

function paraText(p) {
  let out = '';
  p.lines.forEach((l, i) => {
    const t = lineText(l);
    if (i > 0 && !/-$/.test(out)) out += ' ';
    out += t.trim();
  });
  return out;
}

// ---------------------------------------------------------------------------
// XY-cut

// Splits elements into bands along an axis wherever whitespace is wide enough.
function splitAxis(els, axis, thrText, thrObj) {
  const key = axis === 'y' ? ['y0', 'y1'] : ['x0', 'x1'];
  const sorted = [...els].sort((p, q) => p.rect[key[0]] - q.rect[key[0]]);
  const bands = [];
  let cur = [];
  let end = -Infinity;
  let curObj = false;
  for (const e of sorted) {
    const isObj = e.kind !== 'seg';
    if (cur.length) {
      const gap = e.rect[key[0]] - end;
      const thr = (curObj || isObj) ? thrObj : thrText;
      if (gap >= thr) { bands.push(cur); cur = []; curObj = false; end = -Infinity; }
    }
    cur.push(e);
    curObj = curObj || isObj;
    end = Math.max(end, e.rect[key[1]]);
  }
  if (cur.length) bands.push(cur);
  return bands;
}

// A narrow column of list markers ("•", "10.1", "(a)") is the hanging indent of
// the text beside it, not a column of its own — rejoin it to its neighbour.
function joinMarkerColumns(cols, ctx) {
  const isMarker = (col) => {
    const segs = col.filter((e) => e.kind === 'seg');
    if (segs.length !== col.length) return false;
    const w = Math.max(...col.map((e) => e.rect.x1)) - Math.min(...col.map((e) => e.rect.x0));
    return w < 4.5 * ctx.fs0 && segs.every((e) => e.items.map((i) => i.str).join('').trim().length <= 6);
  };
  const out = [];
  for (let i = 0; i < cols.length; i++) {
    if (i < cols.length - 1 && isMarker(cols[i])) {
      cols[i + 1] = [...cols[i], ...cols[i + 1]];
      continue;
    }
    out.push(cols[i]);
  }
  return out;
}

function makeLeaf(els, ctx) {
  const segs = els.filter((e) => e.kind === 'seg');
  const objs = els.filter((e) => e.kind !== 'seg');
  const parts = [];
  if (segs.length) {
    // segments that were split off one line by a wide gap, but couldn't be cut
    // into columns (another line spans the gap), are joined back into that line
    const byLine = new Map();
    for (const sg of segs) {
      if (!byLine.has(sg.lineId)) byLine.set(sg.lineId, []);
      byLine.get(sg.lineId).push(...sg.items);
    }
    const lines = [...byLine.values()].map((items) => finishLine({ items, base: 0, fs: 0 })).sort((p, q) => p.base - q.base);
    const rect = bbox(segs.map((e) => e.rect));
    parts.push({ kind: 'lines', rect, lines, container: ctx.container });
  }
  for (const o of objs) parts.push({ kind: o.kind, rect: o.rect, ref: o.ref });
  if (parts.length === 1) return parts[0];
  parts.sort((p, q) => p.rect.y0 - q.rect.y0);
  return { kind: 'seq', rect: bbox(parts.map((p) => p.rect)), children: parts };
}

function xyCut(els, ctx) {
  if (!els.length) return null;
  const bands = splitAxis(els, 'y', ctx.thrYText, 0.3);
  if (bands.length > 1) {
    return { kind: 'seq', rect: bbox(els.map((e) => e.rect)), children: bands.map((b) => xyCut(b, ctx)) };
  }
  const nLines = new Set(els.filter((e) => e.kind === 'seg').map((e) => e.lineId)).size;
  const cols = joinMarkerColumns(splitAxis(els, 'x', nLines >= 4 ? ctx.thrXLines : ctx.thrXText, 3), ctx);
  if (cols.length > 1) {
    return {
      kind: 'cols',
      rect: bbox(els.map((e) => e.rect)),
      cols: cols.map((c) => {
        const rect = bbox(c.map((e) => e.rect));
        return { rect, node: xyCut(c, { ...ctx, container: rect }) };
      }),
    };
  }
  return makeLeaf(els, ctx);
}

// Fills in paragraphs for every text leaf, once the page's runs/colours exist.
function finishTree(node, raster, hsegs) {
  if (!node) return;
  if (node.kind === 'seq') node.children.forEach((c) => finishTree(c, raster, hsegs));
  else if (node.kind === 'cols') node.cols.forEach((c) => finishTree(c.node, raster, hsegs));
  else if (node.kind === 'lines') {
    prepareLines(node.lines, raster, hsegs);
    node.paragraphs = buildParagraphs(node.lines, node.container);
    node.rect = { ...node.rect, y0: Math.min(node.rect.y0, node.paragraphs[0]?.top ?? node.rect.y0) };
  }
}

function prepareLines(lines, raster, hsegs = []) {
  for (const l of lines) {
    if (l.runs) continue;
    for (const it of l.items) {
      if (it.color === undefined) it.color = sampleRunColor(raster, it);
      if (it.underline === undefined) it.underline = hasUnderline(hsegs, it);
    }
    l.tabs = [];
    l.runs = buildRuns(l.items, l.tabs);
  }
}

// A thin horizontal rule just under a piece of text, about as wide as it, is an underline.
function hasUnderline(hsegs, it) {
  const w = it.x1 - it.x0;
  if (w < 3) return false;
  for (const g of hsegs) {
    if (g.y < it.base + 0.02 * it.fs || g.y > it.base + 0.34 * it.fs) continue;
    const overlap = Math.min(g.x1, it.x1) - Math.max(g.x0, it.x0);
    if (overlap < 0.8 * w) continue;
    if (g.x1 - g.x0 > 1.4 * w + 6) continue; // far wider than the text: a rule or border, not an underline
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// images and artwork

function pageImages(rects, vp, raster) {
  const { gray, w, h, s } = raster;
  const out = [];
  for (const r of rects) {
    const p1 = vp.convertToViewportPoint(r.x, r.y);
    const p2 = vp.convertToViewportPoint(r.x + r.width, r.y + r.height);
    const rect = { x0: Math.min(p1[0], p2[0]), y0: Math.min(p1[1], p2[1]), x1: Math.max(p1[0], p2[0]), y1: Math.max(p1[1], p2[1]) };
    if (rect.x1 - rect.x0 < 4 || rect.y1 - rect.y0 < 4) continue;
    // how much of it is near-white? mostly-white = a scan / line drawing, not a photo
    let white = 0, total = 0;
    const x0 = Math.max(0, Math.floor(rect.x0 * s)), x1 = Math.min(w, Math.ceil(rect.x1 * s));
    const y0 = Math.max(0, Math.floor(rect.y0 * s)), y1 = Math.min(h, Math.ceil(rect.y1 * s));
    const stepX = Math.max(1, Math.floor((x1 - x0) / 80)), stepY = Math.max(1, Math.floor((y1 - y0) / 80));
    for (let y = y0; y < y1; y += stepY) for (let x = x0; x < x1; x += stepX) { total++; if (gray[y * w + x] > 225) white++; }
    out.push({ rect, whiteFrac: total ? white / total : 1, areaFrac: 0 });
  }
  return out;
}

// Ink that is none of: text, a table, or an image — i.e. vector artwork.
function findGraphics(raster, W, H, maskRects) {
  const { gray, w, h, s } = raster;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] < 200 ? 1 : 0;
  for (const r of maskRects) {
    const x0 = Math.max(0, Math.floor(r.x0 * s)), x1 = Math.min(w, Math.ceil(r.x1 * s));
    const y0 = Math.max(0, Math.floor(r.y0 * s)), y1 = Math.min(h, Math.ceil(r.y1 * s));
    for (let y = y0; y < y1; y++) ink.fill(0, y * w + x0, y * w + x1);
  }
  const g = Math.max(4, Math.round(4 * s));
  const gw = Math.ceil(w / g), gh = Math.ceil(h / g);
  const counts = new Uint16Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const gy = Math.floor(y / g) * gw;
    for (let x = 0; x < w; x++) if (ink[row + x]) counts[gy + Math.floor(x / g)]++;
  }
  const marked = new Uint8Array(gw * gh);
  for (let i = 0; i < counts.length; i++) marked[i] = counts[i] >= 3 ? 1 : 0;
  // grow by two cells so parts of one drawing join up
  const grown = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!marked[y * gw + x]) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) grown[yy * gw + xx] = 1;
      }
    }
  }
  const seen = new Uint8Array(gw * gh);
  const out = [];
  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let gx0 = gw, gy0 = gh, gx1 = -1, gy1 = -1, inkPx = 0;
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % gw, cy = (cur - cx) / gw;
      if (marked[cur]) {
        gx0 = Math.min(gx0, cx); gx1 = Math.max(gx1, cx);
        gy0 = Math.min(gy0, cy); gy1 = Math.max(gy1, cy);
        inkPx += counts[cur];
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (grown[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    if (gx1 < 0 || inkPx < 40) continue;
    const rect = { x0: (gx0 * g) / s, y0: (gy0 * g) / s, x1: Math.min(W, ((gx1 + 1) * g) / s), y1: Math.min(H, ((gy1 + 1) * g) / s) };
    const rw = rect.x1 - rect.x0, rh = rect.y1 - rect.y0;
    if (Math.min(rw, rh) < 7) continue;        // a rule or a speck, not artwork
    if (rw > W * 0.95 && rh > H * 0.95) continue; // whole-page background wash
    out.push({ rect, inkPx });
  }
  return out.sort((a, b) => b.inkPx - a.inkPx).slice(0, 40);
}

// ---------------------------------------------------------------------------
// the entry point

export async function analysePage(engine, index) {
  const page = await engine.renderDoc.getPage(index + 1);
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const raster = await renderRaster(page, W, H);
  const { items, rotated } = await extractItems(page, vp);

  const imgRects = await engine.getImageRects(index);
  const images = pageImages(imgRects, vp, raster);
  for (const im of images) im.areaFrac = rectArea(im.rect) / (W * H);
  const photos = images.filter((im) => im.whiteFrac < 0.5).map((im) => im.rect);

  // A scanned page is rarely straight. Estimate its skew and straighten both the
  // pixels and the text positions, so table rules and text lines are level and
  // every piece of text sits in the right cell.
  const scanLike = images.some((im) => im.areaFrac >= 0.35 && im.whiteFrac >= 0.6);
  const phi = scanLike ? estimateSkew(raster) : 0;
  if (phi) {
    rotateRaster(raster, phi);
    const cx = W / 2, cy = H / 2;
    const sin = Math.sin(phi), cos = Math.cos(phi);
    for (const it of items) {
      const dx = it.x0 - cx, dy = it.base - cy;
      const w = it.x1 - it.x0;
      it.x0 = cos * dx - sin * dy + cx;
      it.base = sin * dx + cos * dy + cy;
      it.x1 = it.x0 + w * cos;
    }
  }

  const detected = detectTables(raster, photos, W, H);
  // A "table" that is mostly one huge cell and fills the page is a page border
  // (a frame round the whole page), not data: its contents flow normally, and
  // the border itself is kept as a page border in Word.
  const frames = [];
  const tables = detected.tables.filter((t) => {
    const area = rectArea(t.rect);
    const biggest = Math.max(...t.cells.map((c) => rectArea(c.rect)));
    if (area >= 0.55 * W * H && biggest >= 0.6 * area) { frames.push(t); return false; }
    return true;
  });
  // rules that belong to a table are not underlines
  const hsegs = detected.hsegs.filter((g) => !detected.tables.some((t) => t.ys.some((y) => Math.abs(y - g.y) < 1.5)
    && g.x1 > t.rect.x0 - 2 && g.x0 < t.rect.x1 + 2));

  // text -> table cells, or loose
  let loose = items;
  if (tables.length) {
    loose = [];
    const pieces = [];
    for (const it of items) {
      const cy = it.base - 0.3 * it.fs;
      const cuts = [];
      for (const t of tables) {
        if (cy < t.rect.y0 || cy > t.rect.y1 || it.x1 < t.rect.x0 || it.x0 > t.rect.x1) continue;
        for (const c of t.cells) if (cy >= c.rect.y0 && cy <= c.rect.y1) cuts.push(c.rect.x1);
      }
      if (cuts.length) pieces.push(...splitAtCuts(it, [...new Set(cuts.map((v) => Math.round(v * 2) / 2))]));
      else pieces.push(it);
    }
    for (const it of pieces) {
      const cx = (it.x0 + it.x1) / 2;
      const cy = it.base - 0.3 * it.fs;
      let home = null;
      for (const t of tables) {
        if (cx < t.rect.x0 - 1 || cx > t.rect.x1 + 1 || cy < t.rect.y0 - 1 || cy > t.rect.y1 + 1) continue;
        home = t.cells.find((c) => cx >= c.rect.x0 && cx <= c.rect.x1 && cy >= c.rect.y0 && cy <= c.rect.y1)
          || t.cells.reduce((best, c) => {
            const d = Math.hypot(cx - (c.rect.x0 + c.rect.x1) / 2, cy - (c.rect.y0 + c.rect.y1) / 2);
            return !best || d < best.d ? { c, d } : best;
          }, null)?.c;
        break;
      }
      if (home) home.items.push(it); else loose.push(it);
    }
  }

  const fsCounts = new Map();
  for (const it of items) {
    const k = Math.round(it.fs * 2) / 2;
    fsCounts.set(k, (fsCounts.get(k) || 0) + it.str.length);
  }
  let fs0 = 10, best = 0;
  for (const [k, n] of fsCounts) if (n > best) { best = n; fs0 = k; }

  // table cells -> paragraphs
  for (const t of tables) {
    const tableFs = median(t.cells.flatMap((c) => c.items.map((i) => i.fs)));
    for (const cell of t.cells) {
      const pad = 2.5;
      const inner = { x0: cell.rect.x0 + pad, x1: cell.rect.x1 - pad };
      // text can't be taller than the cell it's in — OCR of a low-resolution scan
      // sometimes reports glyphs far bigger than the cell, which would blow the
      // row (and the exported table) up
      const maxFs = Math.max(4, Math.min(0.8 * (cell.rect.y1 - cell.rect.y0), tableFs ? 1.8 * tableFs : Infinity));
      for (const it of cell.items) if (it.fs > maxFs) it.fs = maxFs;
      const lines = groupLines(cell.items);
      prepareLines(lines, raster, hsegs);
      cell.paragraphs = buildParagraphs(lines, inner);
      cell.text = cell.paragraphs.map(paraText).join('\n');
      cell.inner = inner;
      cell.contentRect = lines.length ? bbox(lines.map((l) => ({ x0: l.x0, y0: l.top, x1: l.x1, y1: l.bottom }))) : null;
    }
  }

  // loose text -> lines -> segments (split at wide gutters) -> elements
  const thrXText = Math.max(1.8 * fs0, 12);
  // Words on one line are split into segments wherever the gap is wider than a
  // word space; a vertical cut then needs the gap to line up across several
  // lines (a real column gutter) — a narrower gap is enough when it does.
  const thrXLines = Math.max(7, 0.9 * fs0);
  const thrYText = 1.15 * fs0;
  const looseLines = groupLines(loose);
  const els = [];
  looseLines.forEach((ln, lineId) => {
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      els.push({
        kind: 'seg', lineId,
        items: cur,
        rect: { x0: cur[0].x0, x1: Math.max(...cur.map((i) => i.x1)), y0: ln.top, y1: ln.bottom },
      });
      cur = [];
    };
    for (const it of ln.items) {
      if (cur.length && it.x0 - Math.max(...cur.map((i) => i.x1)) >= thrXLines) flush();
      cur.push(it);
    }
    flush();
  });

  // images and artwork
  const textRects = items.map((it) => ({ x0: it.x0, y0: it.base - ASC * it.fs, x1: it.x1, y1: it.base + DESC * it.fs }));
  const overlapsText = (rect) => textRects.some((tr) => intersectArea(tr, rect) > 0.25 * rectArea(tr));
  const floats = [];
  const flowObjects = [];
  const graphicMasks = [...textRects.map((r) => ({ x0: r.x0 - 1.5, y0: r.y0 - 1.5, x1: r.x1 + 1.5, y1: r.y1 + 1.5 })),
    // a table's rules extend a little past the rect measured to their centres
    ...tables.map((t) => ({ x0: t.rect.x0 - 4, y0: t.rect.y0 - 4, x1: t.rect.x1 + 4, y1: t.rect.y1 + 4 })),
    ...images.map((im) => im.rect)];
  // a page border: mask a band along each of its four edges
  for (const fr of frames) {
    const r = fr.rect, band = 8;
    graphicMasks.push(
      { x0: r.x0 - band, y0: r.y0 - band, x1: r.x1 + band, y1: r.y0 + band },
      { x0: r.x0 - band, y0: r.y1 - band, x1: r.x1 + band, y1: r.y1 + band },
      { x0: r.x0 - band, y0: r.y0 - band, x1: r.x0 + band, y1: r.y1 + band },
      { x0: r.x1 - band, y0: r.y0 - band, x1: r.x1 + band, y1: r.y1 + band },
    );
  }
  const graphics = findGraphics(raster, W, H, graphicMasks);

  for (const im of images) {
    const obj = { kind: 'image', rect: im.rect, ref: { type: 'image', whiteFrac: im.whiteFrac, areaFrac: im.areaFrac } };
    if (im.areaFrac >= 0.8) floats.push({ ...obj, role: 'background' });
    // a mostly-white picture with text on top is a scan of that text (typically
    // OCR'd): the text and table are exported, the picture of them is not
    else if (im.whiteFrac >= 0.7 && overlapsText(im.rect)) floats.push({ ...obj, role: 'scan' });
    else if (overlapsText(im.rect) || tables.some((t) => intersectArea(t.rect, im.rect) > 0.3 * rectArea(im.rect))) floats.push({ ...obj, role: 'behind', overText: overlapsText(im.rect) });
    else flowObjects.push(obj);
  }
  for (const gr of graphics) {
    // what is left over inside a table is its own rules and shading, which the
    // table already reproduces — not artwork
    if (tables.some((t) => intersectArea(t.rect, gr.rect) > 0.5 * rectArea(gr.rect))) continue;
    const obj = { kind: 'graphic', rect: gr.rect, ref: { type: 'graphic' } };
    if (overlapsText(gr.rect) || tables.some((t) => intersectArea(t.rect, gr.rect) > 0.3 * rectArea(gr.rect))) floats.push({ ...obj, role: 'behind', eraseText: true, overText: overlapsText(gr.rect) });
    else flowObjects.push(obj);
  }

  const tableEls = tables.map((t) => ({ kind: 'table', rect: t.rect, ref: t }));
  const all = [...els, ...tableEls, ...flowObjects.map((o) => ({ kind: o.kind, rect: o.rect, ref: o.ref }))];

  // page margins = the content's extent (so the layout starts where it did)
  let contentRect = all.length ? bbox(all.map((e) => e.rect)) : { x0: 36, y0: 36, x1: W - 36, y1: H - 36 };
  const margins = {
    left: Math.max(0, Math.floor(contentRect.x0)),
    top: Math.max(0, Math.floor(contentRect.y0 - 1)),
    right: Math.max(0, Math.floor(W - contentRect.x1)),
    bottom: Math.max(4, Math.min(Math.floor(H - contentRect.y1), 14)),
  };
  const container = { x0: margins.left, x1: W - margins.right };
  const tree = xyCut(all, { thrXText, thrXLines, thrYText, container, fs0 });
  finishTree(tree, raster, hsegs);

  const hasText = items.length > 0;
  const warnings = [];
  if (!hasText) warnings.push(`Page ${index + 1} has no text layer — run OCR on it first if you want editable text.`);
  if (rotated) warnings.push(`Page ${index + 1}: ${rotated} piece${rotated === 1 ? '' : 's'} of sideways text could not be placed.`);

  return {
    index, W, H, fs0, margins, container, tree, tables, frames, floats, images, graphics, textRects,
    hasText, warnings, raster,
    dispose() { raster.canvas.width = raster.canvas.height = 0; },
  };
}

// Crops a top-left-origin rect (points) out of a fresh high-resolution render
// of the page. `erase` rects are painted over with the page background first,
// so artwork can be lifted out without the text that sits on it.
export async function cropPage(engine, index, rect, erase = [], transparent = false) {
  const page = await engine.renderDoc.getPage(index + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const rw = rect.x1 - rect.x0, rh = rect.y1 - rect.y0;
  const scale = Math.max(0.5, Math.min(3, Math.sqrt(10e6 / Math.max(1, rw * rh)), 3000 / Math.max(rw, rh)));
  const viewport = page.getViewport({ scale, offsetX: -rect.x0 * scale, offsetY: -rect.y0 * scale });
  const w = Math.max(1, Math.ceil(rw * scale)), h = Math.max(1, Math.ceil(rh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (erase.length) {
    ctx.fillStyle = '#fff';
    for (const e of erase) {
      ctx.fillRect((e.x0 - rect.x0) * scale - 1, (e.y0 - rect.y0) * scale - 1, (e.x1 - e.x0) * scale + 2, (e.y1 - e.y0) * scale + 2);
    }
  }
  void vp1;
  if (transparent) {
    // artwork on white: make the white see-through so it can sit over/under text
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.min(d[i], d[i + 1], d[i + 2]);
      if (m >= 246) d[i + 3] = 0;
      else if (m > 200) d[i + 3] = Math.round(255 * (246 - m) / 46);
    }
    ctx.putImageData(img, 0, 0);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  canvas.width = canvas.height = 0;
  return { bytes, width: rw, height: rh };
}

export { paraText, lineText };
