// Word and Excel export. These are conversions, not edits: the page layout is
// *reconstructed* from where glyphs and lines sit on the page (see layout.js),
// so tables come out as real tables, columns as columns, and text keeps its
// font, size, bold/italic, colour, alignment and spacing. It is still
// reconstruction — complex or artwork-heavy pages will not be pixel-perfect.

import {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, VerticalAlign, TableLayoutType, HeightRule,
  AlignmentType, LineRuleType, PageOrientation, Tab, TabStopType, UnderlineType,
  PageBorderDisplay, PageBorderOffsetFrom, PageBorderZOrder,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType,
} from './vendor/docx.esm.js';
import { analysePage, cropPage, paraText } from './layout.js';

const tw = (pt) => Math.max(0, Math.round(pt * 20)); // points -> twips
const emu = (pt) => Math.round(pt * 12700);
const px = (pt) => Math.max(1, Math.round(pt * 96 / 72));

// ===========================================================================
// Word

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' };
const NO_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
};

function textRunsFor(p) {
  const out = [];
  const single = p.lines.length === 1; // tabs only make sense on a single line
  p.lines.forEach((line, li) => {
    const runs = line.runs;
    runs.forEach((r, ri) => {
      let text = r.text;
      // end of a wrapped line joins to the next with a space (unless hyphenated)
      if (ri === runs.length - 1 && li < p.lines.length - 1) text = text.replace(/\s+$/, '') + (/-$/.test(text.trim()) ? '' : ' ');
      if (ri === 0 && li > 0) text = text.replace(/^\s+/, '');
      if (!text) return;
      const props = {
        font: r.font.name,
        size: Math.max(2, Math.min(400, Math.round(r.fs * 2))),
        bold: r.font.bold || undefined,
        italics: r.font.italic || undefined,
        color: r.color || undefined,
        underline: r.underline ? { type: UnderlineType.SINGLE } : undefined,
      };
      if (text.includes('\t')) {
        if (single) {
          const parts = text.split('\t');
          const children = [];
          parts.forEach((part, k) => { if (k > 0) children.push(new Tab()); if (part) children.push(part); });
          out.push(new TextRun({ ...props, children }));
        } else {
          out.push(new TextRun({ ...props, text: text.replace(/\t/g, '    ') }));
        }
      } else {
        out.push(new TextRun({ ...props, text }));
      }
    });
  });
  return out;
}

function makeParagraph(p, spaceBeforePt, extraRuns = []) {
  const H = Math.max(p.lineH, 1.08 * p.fs);
  const tabs = p.lines.length === 1 && p.lines[0].tabs ? p.lines[0].tabs : [];
  return new Paragraph({
    alignment: ALIGN[p.align],
    indent: {
      left: tw(p.indentLeft),
      right: tw(p.indentRight),
      firstLine: p.firstLine > 0 ? tw(p.firstLine) : undefined,
    },
    spacing: { before: tw(spaceBeforePt), after: 0, line: tw(H), lineRule: LineRuleType.EXACT },
    tabStops: tabs.length ? tabs.map((x) => ({ type: TabStopType.LEFT, position: tw(x - p.container.x0) })) : undefined,
    children: [...extraRuns, ...textRunsFor(p)],
  });
}

function spacerParagraph(heightPt) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: Math.max(20, tw(heightPt)), lineRule: LineRuleType.EXACT },
    children: [],
  });
}

// An empty cell still needs a paragraph; make it as short as Word allows so it
// doesn't push the row taller than the original.
function emptyCellParagraph() {
  return new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [] });
}

async function imageRunFor(engine, idx, rect, opts = {}) {
  const { bytes, width, height } = await cropPage(engine, idx, rect, opts.erase || [], !!opts.transparent);
  return new ImageRun({
    type: 'png',
    data: bytes,
    transformation: { width: px(width), height: px(height) },
    floating: opts.floating ? {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(rect.x0) },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(rect.y0) },
      behindDocument: true,
      allowOverlap: true,
      lockAnchor: false,
      wrap: { type: TextWrappingType.NONE },
    } : undefined,
  });
}

// Paragraphs for the content of a table cell (or a column of a borderless table).
function cellParagraphs(cell, ctx) {
  if (!cell.paragraphs || !cell.paragraphs.length) return { paras: [emptyCellParagraph()], vAlign: VerticalAlign.TOP };
  const cr = cell.contentRect;
  const rect = cell.rect;
  const rowH = rect.y1 - rect.y0;
  const topGap = cr.y0 - rect.y0;
  const botGap = rect.y1 - cr.y1;
  let vAlign = VerticalAlign.TOP;
  let firstGap = Math.max(0, cell.paragraphs[0].top - rect.y0 - 0.5);
  if (topGap > 2 && Math.abs(topGap - botGap) <= Math.max(2, 0.15 * rowH)) { vAlign = VerticalAlign.CENTER; firstGap = 0; }
  else if (topGap > 4 && botGap < topGap * 0.4) { vAlign = VerticalAlign.BOTTOM; firstGap = 0; }
  const paras = cell.paragraphs.map((p, i) => makeParagraph(p, i === 0 ? firstGap : p.spaceBefore));
  return { paras, vAlign };
}

function buildRuledTable(t, ctx) {
  const widths = [];
  for (let i = 0; i < t.xs.length - 1; i++) widths.push(tw(t.xs[i + 1] - t.xs[i]));
  const nRows = t.ys.length - 1;
  const bsize = Math.max(2, Math.round(t.lineWidth * 8));
  const line = { style: BorderStyle.SINGLE, size: bsize, color: '000000' };
  const rows = [];
  for (let r = 0; r < nRows; r++) {
    const cells = t.cells.filter((c) => c.r === r).sort((a, b) => a.c - b.c);
    const tcs = cells.map((cell) => {
      const content = cellParagraphs(cell, ctx);
      const w = widths.slice(cell.c, cell.c + cell.cs).reduce((s, v) => s + v, 0);
      return new TableCell({
        children: content.paras,
        width: { size: w, type: WidthType.DXA },
        columnSpan: cell.cs > 1 ? cell.cs : undefined,
        rowSpan: cell.rs > 1 ? cell.rs : undefined,
        verticalAlign: content.vAlign,
        shading: cell.bg ? { type: ShadingType.CLEAR, fill: cell.bg, color: 'auto' } : undefined,
        borders: { top: line, bottom: line, left: line, right: line },
        margins: { top: 0, bottom: 0, left: 50, right: 50, marginUnitType: WidthType.DXA },
      });
    });
    rows.push(new TableRow({
      children: tcs,
      cantSplit: true,
      // Word adds a border's width to a row, so take it off to land on the original height
      height: { value: tw(Math.max(2, t.ys[r + 1] - t.ys[r] - t.lineWidth)), rule: HeightRule.ATLEAST },
    }));
  }
  return new Table({
    rows,
    columnWidths: widths,
    width: { size: widths.reduce((s, v) => s + v, 0), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    indent: { size: tw(t.rect.x0 - ctx.container.x0), type: WidthType.DXA },
    borders: NO_BORDERS,
    margins: { top: 0, bottom: 0, left: 0, right: 0, marginUnitType: WidthType.DXA },
  });
}

// The set of paragraph alignments found anywhere under a layout node.
function alignsOf(node, out = new Set()) {
  if (!node) return out;
  if (node.kind === 'lines') node.paragraphs.forEach((p) => out.add(p.align));
  else if (node.kind === 'seq') node.children.forEach((c) => alignsOf(c, out));
  else if (node.kind === 'cols') node.cols.forEach((c) => alignsOf(c.node, out));
  return out;
}

function nodeTop(node) {
  if (!node) return Infinity;
  if (node.kind === 'lines') return node.paragraphs[0]?.top ?? node.rect.y0;
  if (node.kind === 'seq') return Math.min(...node.children.map(nodeTop));
  if (node.kind === 'cols') return Math.min(...node.cols.map((c) => nodeTop(c.node)));
  return node.rect.y0;
}

function lastTable(out) {
  return out.length && out[out.length - 1] instanceof Table;
}

// Emits Word blocks for a layout node into `out`, tracking `ctx.cursor` — the
// y of the bottom of what has been emitted — so each block's distance from the
// previous one is reproduced as paragraph spacing.
async function emitNode(node, out, ctx) {
  if (!node) return;

  if (node.kind === 'seq') {
    for (const child of node.children) await emitNode(child, out, ctx);
    return;
  }

  if (node.kind === 'lines') {
    const gap = Math.max(0, nodeTop(node) - ctx.cursor);
    node.paragraphs.forEach((p, i) => {
      const extra = ctx.takeFloats();
      out.push(makeParagraph(p, i === 0 ? gap : p.spaceBefore, extra));
    });
    ctx.cursor = node.paragraphs[node.paragraphs.length - 1].bottom;
    return;
  }

  if (node.kind === 'table') {
    const gap = nodeTop(node) - ctx.cursor;
    const floats = ctx.takeFloats();
    if (gap >= 1 || lastTable(out) || floats.length) {
      out.push(floats.length ? new Paragraph({ spacing: { before: 0, after: 0, line: Math.max(20, tw(gap)), lineRule: LineRuleType.EXACT }, children: floats }) : spacerParagraph(gap));
    }
    out.push(buildRuledTable(node.ref, ctx));
    ctx.cursor = node.rect.y1;
    return;
  }

  if (node.kind === 'cols') {
    const cols = [...node.cols].sort((a, b) => a.rect.x0 - b.rect.x0);
    const top = nodeTop(node);
    const gap = top - ctx.cursor;
    const floats = ctx.takeFloats();
    if (gap >= 1 || lastTable(out) || floats.length) {
      out.push(floats.length ? new Paragraph({ spacing: { before: 0, after: 0, line: Math.max(20, tw(gap)), lineRule: LineRuleType.EXACT }, children: floats }) : spacerParagraph(gap));
    }
    const widths = [];
    const cells = [];
    let bottom = top;
    // Give each column a little slack so a slightly wider font in Word doesn't
    // wrap its text — on the side the text isn't anchored to: right for
    // left-aligned text, left for right-aligned, both for centred.
    const slackL = [];
    const slackR = [];
    cols.forEach((col, i) => {
      const prev = cols[i - 1];
      const next = cols[i + 1];
      const aligns = alignsOf(col.node);
      const rightOnly = aligns.size > 0 && [...aligns].every((a) => a === 'right');
      const centreOnly = aligns.size > 0 && [...aligns].every((a) => a === 'center');
      const want = Math.max(6, 0.08 * (col.rect.x1 - col.rect.x0));
      const roomL = prev ? (col.rect.x0 - prev.rect.x1) * 0.5 : Math.max(0, col.rect.x0 - ctx.container.x0);
      const roomR = next ? (next.rect.x0 - col.rect.x1) * 0.5 : Math.max(0, ctx.container.x1 - col.rect.x1);
      slackL[i] = rightOnly ? Math.min(roomL, want) : centreOnly ? Math.min(roomL, want / 2) : 0;
      slackR[i] = rightOnly ? 0 : centreOnly ? Math.min(roomR, want / 2) : Math.min(roomR, want);
    });
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const next = cols[i + 1];
      const w = col.rect.x1 - col.rect.x0 + slackL[i] + slackR[i];
      const sub = { ...ctx, cursor: top, container: { x0: col.rect.x0, x1: col.rect.x1 }, takeFloats: () => [] };
      const blocks = [];
      await emitNode(col.node, blocks, sub);
      if (!blocks.length || !(blocks[blocks.length - 1] instanceof Paragraph)) blocks.push(emptyCellParagraph());
      bottom = Math.max(bottom, sub.cursor);
      widths.push(tw(w));
      cells.push(new TableCell({ children: blocks, width: { size: tw(w), type: WidthType.DXA }, borders: NO_BORDERS, margins: { top: 0, bottom: 0, left: 0, right: 0, marginUnitType: WidthType.DXA } }));
      if (next) {
        const gw = Math.max(0, next.rect.x0 - col.rect.x1 - slackR[i] - slackL[i + 1]);
        widths.push(tw(gw));
        cells.push(new TableCell({ children: [emptyCellParagraph()], width: { size: tw(gw), type: WidthType.DXA }, borders: NO_BORDERS, margins: { top: 0, bottom: 0, left: 0, right: 0, marginUnitType: WidthType.DXA } }));
      }
    }
    out.push(new Table({
      rows: [new TableRow({ children: cells, cantSplit: true })],
      columnWidths: widths,
      width: { size: widths.reduce((s, v) => s + v, 0), type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      indent: { size: tw(Math.max(0, cols[0].rect.x0 - slackL[0] - ctx.container.x0)), type: WidthType.DXA },
      borders: NO_BORDERS,
      margins: { top: 0, bottom: 0, left: 0, right: 0, marginUnitType: WidthType.DXA },
    }));
    ctx.cursor = bottom;
    return;
  }

  if (node.kind === 'image' || node.kind === 'graphic') {
    const rect = node.rect;
    let run;
    try {
      run = await imageRunFor(ctx.engine, ctx.idx, rect, { transparent: node.kind === 'graphic' });
    } catch { return; } // a picture that can't be lifted out is skipped, not fatal
    const gap = Math.max(0, rect.y0 - ctx.cursor);
    const extra = ctx.takeFloats();
    out.push(new Paragraph({
      indent: { left: tw(Math.max(0, rect.x0 - ctx.container.x0)) },
      spacing: { before: tw(gap), after: 0 },
      children: [...extra, run],
    }));
    ctx.cursor = rect.y1;
  }
}

async function buildWordSection(engine, idx, opts, warnings) {
  const a = await analysePage(engine, idx);
  try {
    warnings.push(...a.warnings);
    const floatRuns = [];
    const textFree = !a.hasText;
    for (const f of a.floats) {
      if (f.role === 'scan') continue;
      if (f.role === 'background' && !opts.keepBackground) continue;
      if (!opts.keepImages && f.kind === 'image') continue;
      try {
        const erase = f.eraseText ? a.textRects.filter((tr) => tr.x1 > f.rect.x0 && tr.x0 < f.rect.x1 && tr.y1 > f.rect.y0 && tr.y0 < f.rect.y1) : [];
        floatRuns.push(await imageRunFor(engine, idx, f.rect, { floating: true, erase, transparent: f.kind === 'graphic' }));
      } catch { /* skip */ }
    }
    if (textFree && !a.tree) {
      // a page with no text at all: keep it as a picture so it isn't lost
      try {
        floatRuns.push(await imageRunFor(engine, idx, { x0: 0, y0: 0, x1: a.W, y1: a.H }, { floating: true }));
      } catch { /* skip */ }
    }

    // drop pictures if the user asked for text only
    if (!opts.keepImages) {
      const strip = (n) => {
        if (!n) return null;
        if (n.kind === 'seq') { n.children = n.children.map(strip).filter(Boolean); return n.children.length ? n : null; }
        if (n.kind === 'cols') { n.cols.forEach((c) => { c.node = strip(c.node); }); n.cols = n.cols.filter((c) => c.node); return n.cols.length ? n : null; }
        if (n.kind === 'image' || n.kind === 'graphic') return null;
        return n;
      };
      a.tree = strip(a.tree);
    }

    let pending = floatRuns;
    const ctx = {
      engine, idx,
      cursor: a.margins.top,
      container: a.container,
      takeFloats: () => { const r = pending; pending = []; return r; },
    };
    const children = [];
    await emitNode(a.tree, children, ctx);
    if (pending.length || !children.length) {
      children.unshift(new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: pending }));
    }
    // a section must end on a paragraph, not a table
    if (children[children.length - 1] instanceof Table) children.push(spacerParagraph(1));

    const landscape = a.W > a.H;
    // a frame round the page becomes a page border
    let borders;
    const fr = a.frames[0];
    if (fr && fr.rect.x1 - fr.rect.x0 > 0.8 * a.W && fr.rect.y1 - fr.rect.y0 > 0.8 * a.H) {
      const side = (d) => ({ style: BorderStyle.SINGLE, size: Math.max(4, Math.min(48, Math.round(fr.lineWidth * 8))), color: '000000', space: Math.max(0, Math.min(31, Math.round(d))) });
      borders = {
        pageBorders: { display: PageBorderDisplay.ALL_PAGES, offsetFrom: PageBorderOffsetFrom.PAGE, zOrder: PageBorderZOrder.BACK },
        pageBorderTop: side(fr.rect.y0), pageBorderBottom: side(a.H - fr.rect.y1),
        pageBorderLeft: side(fr.rect.x0), pageBorderRight: side(a.W - fr.rect.x1),
      };
    }
    return {
      properties: {
        page: {
          borders,
          size: {
            width: tw(landscape ? a.H : a.W),
            height: tw(landscape ? a.W : a.H),
            orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
          },
          margin: {
            top: tw(a.margins.top), bottom: tw(a.margins.bottom),
            left: tw(a.margins.left), right: tw(a.margins.right),
            header: 0, footer: 0,
          },
        },
      },
      children,
    };
  } finally {
    a.dispose();
  }
}

// opts: { keepBackground, keepImages }. Returns { blob, warnings }.
export async function buildDocxBlob(engine, pageIndices, opts = {}, onProgress) {
  const options = { keepBackground: false, keepImages: true, ...opts };
  const warnings = [];
  const sections = [];
  for (let i = 0; i < pageIndices.length; i++) {
    onProgress?.(i + 1, pageIndices.length);
    sections.push(await buildWordSection(engine, pageIndices[i], options, warnings));
  }
  const doc = new Document({
    creator: 'Schurco PDF Editor',
    styles: { default: { document: { run: { font: 'Arial', size: 20 }, paragraph: { spacing: { before: 0, after: 0 } } } } },
    sections,
  });
  return { blob: await Packer.toBlob(doc), warnings };
}

// ===========================================================================
// Excel

let excelPromise = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!excelPromise) {
    excelPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('./vendor/exceljs.min.js', import.meta.url).href;
      s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('Excel library did not load')));
      s.onerror = () => { excelPromise = null; reject(new Error('Could not load the Excel library')); };
      document.head.appendChild(s);
    });
  }
  return excelPromise;
}

const ptToColWidth = (pt) => Math.max(1, ((pt * 96) / 72 - 5) / 7);

function parseNumber(text) {
  const t = text.trim();
  if (!t || /^0\d/.test(t.replace(/^-/, ''))) return null; // keep IDs like 007 as text
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t), fmt: /\./.test(t) ? `0.${'0'.repeat(t.split('.')[1].length)}` : '0' };
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
    const dec = t.includes('.') ? t.split('.')[1].length : 0;
    return { value: Number(t.replace(/,/g, '')), fmt: `#,##0${dec ? '.' + '0'.repeat(dec) : ''}` };
  }
  if (/^-?\d+(\.\d+)?%$/.test(t)) return { value: Number(t.slice(0, -1)) / 100, fmt: '0.0%' };
  return null;
}

function lineTextOf(line) {
  return line.runs.map((r) => r.text).join('').replace(/\t/g, ' ').trim();
}

function xlFont(run) {
  return {
    name: run.font.name,
    size: Math.max(6, Math.min(72, Math.round(run.fs * 2) / 2)),
    bold: run.font.bold || undefined,
    italic: run.font.italic || undefined,
    underline: run.underline ? 'single' : undefined,
    color: run.color ? { argb: `FF${run.color}` } : undefined,
  };
}

// Writes text into a cell: plain when the style is uniform, rich text when mixed.
function setCellText(cell, paragraphs, { wrap = true, numeric = true } = {}) {
  const runs = paragraphs.flatMap((p) => p.lines.flatMap((l) => l.runs));
  if (!runs.length) return;
  const text = paragraphs.map(paraText).join('\n');
  const styleKey = (r) => `${r.font.name}|${r.font.bold}|${r.font.italic}|${Math.round(r.fs)}|${r.color || ''}|${r.underline ? 1 : 0}`;
  const keys = new Set(runs.map(styleKey));
  const dominant = runs.reduce((a, r) => (r.text.length > a.text.length ? r : a), runs[0]);
  cell.font = xlFont(dominant);
  const num = numeric && paragraphs.length === 1 ? parseNumber(text) : null;
  if (num) {
    cell.value = num.value;
    cell.numFmt = num.fmt;
  } else if (keys.size > 1) {
    const rich = [];
    paragraphs.forEach((p, pi) => {
      p.lines.forEach((l, li) => {
        l.runs.forEach((r, ri) => {
          let t = r.text;
          if (ri === l.runs.length - 1 && li < p.lines.length - 1) t = t.replace(/\s+$/, '') + ' ';
          if (ri === 0 && li > 0) t = t.replace(/^\s+/, '');
          if (ri === l.runs.length - 1 && li === p.lines.length - 1) {
            t = t.replace(/\s+$/, '');
            if (pi < paragraphs.length - 1) t += '\n';
          }
          if (t) rich.push({ text: t.replace(/\t/g, '  '), font: xlFont(r) });
        });
      });
    });
    cell.value = { richText: rich };
  } else {
    cell.value = text;
  }
  const align = paragraphs[0].align;
  cell.alignment = {
    horizontal: align === 'justify' ? 'left' : align,
    vertical: 'top',
    wrapText: wrap,
  };
}

// Height (pt) a block of lines needs in Excel: Excel wants about 1.25x the font
// size per line or it clips the text.
function neededHeight(paragraphs) {
  let h = 0;
  for (const p of paragraphs) {
    for (const l of p.lines) h += 1.25 * Math.max(...l.runs.map((r) => r.fs), 6);
  }
  return h + 2;
}

function boundaryIndex(bounds, v) {
  let best = 0;
  for (let i = 1; i < bounds.length; i++) if (Math.abs(bounds[i] - v) < Math.abs(bounds[best] - v)) best = i;
  return best;
}

function snapTo(list, v, tol) {
  for (const b of list) if (Math.abs(b - v) <= tol) return b;
  return null;
}

// Gathers the text cells, table cells and pictures of a laid-out page.
function collectPageContent(node, out) {
  if (!node) return;
  if (node.kind === 'seq') node.children.forEach((c) => collectPageContent(c, out));
  else if (node.kind === 'cols') node.cols.forEach((c) => collectPageContent(c.node, out));
  else if (node.kind === 'lines') {
    for (const p of node.paragraphs) for (const l of p.lines) out.lines.push({ line: l, para: p });
  } else if (node.kind === 'table') out.tables.push(node.ref);
  else if (node.kind === 'image' || node.kind === 'graphic') out.pictures.push(node);
}

function styleTableCell(ws, cell, r1, c1, r2, c2) {
  const edge = { style: 'thin', color: { argb: 'FF000000' } };
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const x = ws.getCell(r, c);
      x.border = {
        top: r === r1 ? edge : undefined, bottom: r === r2 ? edge : undefined,
        left: c === c1 ? edge : undefined, right: c === c2 ? edge : undefined,
      };
      if (cell.bg) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${cell.bg}` } };
    }
  }
}

async function addPicture(wb, ws, engine, idx, rect, colB, rowB, erase = [], transparent = false) {
  const { bytes, width, height } = await cropPage(engine, idx, rect, erase, transparent);
  const id = wb.addImage({ buffer: bytes, extension: 'png' });
  // Position of `v` on the grid as a fractional cell index. Never negative: an
  // anchor before the first column is invalid and Excel rejects the whole file.
  const pos = (bounds, v) => {
    if (!(v > bounds[0])) return 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (v < bounds[i + 1]) return Math.max(0, i + (v - bounds[i]) / Math.max(1e-6, bounds[i + 1] - bounds[i]));
    }
    return Math.max(0, bounds.length - 2);
  };
  ws.addImage(id, { tl: { col: pos(colB, rect.x0), row: pos(rowB, rect.y0) }, ext: { width: px(width), height: px(height) }, editAs: 'oneCell' });
}

async function buildPageSheet(wb, engine, idx, name, opts, warnings) {
  const a = await analysePage(engine, idx);
  try {
    warnings.push(...a.warnings);
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });
    const content = { lines: [], tables: [], pictures: [] };
    collectPageContent(a.tree, content);

    // --- columns: table edges first (exact), then left edges of loose text
    const xTable = [];
    const yTable = [];
    for (const t of content.tables) { xTable.push(...t.xs); yTable.push(...t.ys); }
    const xb = clusterBounds(xTable, 2.5);
    for (const { line } of content.lines) if (snapTo(xb, line.x0, 4) === null) xb.push(line.x0);
    const colB = clusterBounds(xb, 4);
    const pictures = [...content.pictures.map((p) => ({ rect: p.rect, erase: [], transparent: p.kind === 'graphic' }))];
    if (opts.keepImages) {
      for (const f of a.floats) {
        if (f.role === 'scan' || (f.role === 'background' && !opts.keepBackground)) continue;
        if (f.kind === 'image' && !opts.keepImages) continue;
        // Excel can't put a picture behind cell text, so a picture that sits under
        // text would hide it — those are left out (the text is what's wanted).
        if (f.overText) continue;
        const erase = f.eraseText ? a.textRects.filter((tr) => tr.x1 > f.rect.x0 && tr.x0 < f.rect.x1 && tr.y1 > f.rect.y0 && tr.y0 < f.rect.y1) : [];
        pictures.push({ rect: f.rect, erase, transparent: f.kind === 'graphic' });
      }
    }
    for (const p of pictures) colB.push(p.rect.x0);
    const colBounds = clusterBounds(colB, 3);
    const rightEdge = Math.max(a.container.x1, ...colBounds.map((v) => v + 20));
    colBounds.push(rightEdge);

    // --- rows: table edges, then the tops of loose lines
    const yb = clusterBounds(yTable, 2);
    const rowTol = Math.max(3, 0.4 * a.fs0);
    for (const { line } of content.lines) if (snapTo(yb, line.top, rowTol) === null) yb.push(line.top);
    for (const p of pictures) yb.push(p.rect.y0);
    const rowBounds = clusterBounds(yb, 2.5);
    const bottomEdge = Math.max(a.H - a.margins.bottom, ...rowBounds.map((v) => v + 8));
    rowBounds.push(Math.min(bottomEdge, rowBounds[rowBounds.length - 1] + 60));
    if (rowBounds.length > 3000 || colBounds.length > 300) {
      warnings.push(`Page ${idx + 1} is too complex to lay out as a sheet; its text was kept but not aligned.`);
    }

    colBounds.slice(0, -1).forEach((v, i) => { ws.getColumn(i + 1).width = ptToColWidth(colBounds[i + 1] - v); });
    rowBounds.slice(0, -1).forEach((v, i) => { ws.getRow(i + 1).height = Math.max(6, Math.min(409, rowBounds[i + 1] - v)); });

    const colOf = (x) => boundaryIndex(colBounds.slice(0, -1), x);
    const rowOf = (y) => boundaryIndex(rowBounds.slice(0, -1), y);
    const occupied = new Set();
    const need = new Map();
    const needRow = (r, h) => need.set(r, Math.max(need.get(r) || 0, h));

    // tables
    for (const t of content.tables) {
      for (const cell of t.cells) {
        const c1 = colOf(cell.rect.x0) + 1;
        let c2 = Math.max(c1, boundaryIndex(colBounds, cell.rect.x1));
        const r1 = rowOf(cell.rect.y0) + 1;
        let r2 = Math.max(r1, boundaryIndex(rowBounds, cell.rect.y1));
        // On a noisy scan two table cells can snap to overlapping grid areas.
        // Excel can't merge over a merge, so a cell that would collide is cut
        // back to the free part of its range (or dropped if none is free).
        let clash = false;
        for (let r = r1; r <= r2 && !clash; r++) for (let c = c1; c <= c2; c++) if (occupied.has(`${r},${c}`)) { clash = true; break; }
        if (clash) {
          if (occupied.has(`${r1},${c1}`)) continue;
          r2 = r1; c2 = c1;
        }
        if (r2 > r1 || c2 > c1) ws.mergeCells(r1, c1, r2, c2);
        styleTableCell(ws, cell, r1, c1, r2, c2);
        const master = ws.getCell(r1, c1);
        setCellText(master, cell.paragraphs || [], { wrap: true });
        if (r2 === r1 && cell.paragraphs?.length) needRow(r1, neededHeight(cell.paragraphs));
        if (cell.contentRect && cell.paragraphs?.length) {
          const topGap = cell.contentRect.y0 - cell.rect.y0;
          const botGap = cell.rect.y1 - cell.contentRect.y1;
          const rowH = cell.rect.y1 - cell.rect.y0;
          master.alignment = {
            ...master.alignment,
            vertical: topGap > 2 && Math.abs(topGap - botGap) <= Math.max(2, 0.15 * rowH) ? 'middle' : botGap < topGap * 0.4 && topGap > 4 ? 'bottom' : 'top',
          };
        }
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) occupied.add(`${r},${c}`);
      }
    }

    // loose text: one cell per line, in the column its left edge lines up with.
    // A line wider than its own column is merged across the empty columns to its
    // right (up to the next thing on that row) so it isn't cut off, and shrunk
    // to fit if even that isn't enough.
    const nCols = colBounds.length - 1;
    const loose = content.lines.map(({ line, para }) => ({ line, para, r: rowOf(line.top) + 1, c: colOf(line.x0) + 1 }));
    loose.sort((p, q) => p.r - q.r || p.c - q.c);
    for (const l of loose) {
      while (occupied.has(`${l.r},${l.c}`) && l.c < nCols) l.c++;
      occupied.add(`${l.r},${l.c}`);
    }
    loose.forEach((l, i) => {
      let limit = nCols;
      for (let c = l.c + 1; c <= nCols; c++) if (occupied.has(`${l.r},${c}`)) { limit = c - 1; break; }
      l.cEnd = limit;
    });
    for (const l of loose) {
      const cell = ws.getCell(l.r, l.c);
      const text = lineTextOf(l.line);
      const fs = Math.max(...l.line.runs.map((r) => r.fs));
      const est = text.length * 0.5 * fs;
      const own = colBounds[l.c] - colBounds[l.c - 1];
      const avail = colBounds[l.cEnd] - colBounds[l.c - 1];
      setCellText(cell, [{ lines: [l.line], align: 'left' }], { wrap: false });
      let shrink = false;
      if (est > own * 0.98 && l.cEnd > l.c) {
        ws.mergeCells(l.r, l.c, l.r, l.cEnd);
        for (let c = l.c; c <= l.cEnd; c++) occupied.add(`${l.r},${c}`);
        shrink = est > avail * 1.02;
      } else if (est > own * 1.02 && l.cEnd === l.c) {
        shrink = true;
      }
      cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false, shrinkToFit: shrink };
      needRow(l.r, 1.25 * fs + 1);
    }
    for (const [r, h] of need) {
      const row = ws.getRow(r);
      row.height = Math.min(409, Math.max(row.height || 0, h));
    }

    if (opts.keepImages) {
      for (const p of pictures) {
        try { await addPicture(wb, ws, engine, idx, p.rect, colBounds, rowBounds, p.erase, p.transparent); } catch { /* skip */ }
      }
    }

    ws.pageSetup = { orientation: a.W > a.H ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    return ws;
  } finally {
    a.dispose();
  }
}

function clusterBounds(values, tol) {
  const sorted = [...values].sort((p, q) => p - q);
  const out = [];
  let cur = [];
  for (const v of sorted) {
    if (cur.length && v - cur[cur.length - 1] > tol) { out.push(cur); cur = []; }
    cur.push(v);
  }
  if (cur.length) out.push(cur);
  return out.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

// "Tables only": every ruled table on its own sheet, in its own grid.
async function buildTableSheets(wb, engine, idx, usedNames, opts, warnings) {
  const a = await analysePage(engine, idx);
  try {
    warnings.push(...a.warnings);
    let n = 0;
    for (const t of a.tables) {
      n += 1;
      let name = `P${idx + 1} Table ${n}`;
      let k = 2;
      while (usedNames.has(name)) name = `P${idx + 1} Table ${n} (${k++})`;
      usedNames.add(name);
      const ws = wb.addWorksheet(name);
      t.xs.slice(0, -1).forEach((x, i) => { ws.getColumn(i + 1).width = ptToColWidth(t.xs[i + 1] - x); });
      t.ys.slice(0, -1).forEach((y, i) => { ws.getRow(i + 1).height = Math.max(6, Math.min(409, t.ys[i + 1] - y)); });
      for (const cell of t.cells) {
        const r1 = cell.r + 1, c1 = cell.c + 1, r2 = cell.r + cell.rs, c2 = cell.c + cell.cs;
        if (r2 > r1 || c2 > c1) ws.mergeCells(r1, c1, r2, c2);
        styleTableCell(ws, cell, r1, c1, r2, c2);
        setCellText(ws.getCell(r1, c1), cell.paragraphs || [], { wrap: true });
        if (r2 === r1 && cell.paragraphs?.length) {
          const row = ws.getRow(r1);
          row.height = Math.min(409, Math.max(row.height || 0, neededHeight(cell.paragraphs)));
        }
      }
    }
    return n;
  } finally {
    a.dispose();
  }
}

// opts: { mode: 'layout' | 'tables', keepImages, keepBackground }. Returns { blob, warnings }.
export async function buildXlsxBlob(engine, pageIndices, opts = {}, onProgress) {
  const options = { mode: 'layout', keepImages: true, keepBackground: false, ...opts };
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Schurco PDF Editor';
  const warnings = [];
  const usedNames = new Set();
  let sheets = 0;
  for (let i = 0; i < pageIndices.length; i++) {
    const idx = pageIndices[i];
    onProgress?.(i + 1, pageIndices.length);
    if (options.mode === 'tables') {
      sheets += await buildTableSheets(wb, engine, idx, usedNames, options, warnings);
    } else {
      let name = `Page ${idx + 1}`;
      usedNames.add(name);
      await buildPageSheet(wb, engine, idx, name, options, warnings);
      sheets += 1;
    }
  }
  if (!sheets) {
    wb.addWorksheet('No tables found').getCell(1, 1).value = 'No ruled tables were found in the selected pages. Use "Keep page layout" instead.';
    warnings.push('No tables were found in the selected pages.');
  }
  const buffer = await wb.xlsx.writeBuffer();
  return {
    blob: new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    warnings,
  };
}
