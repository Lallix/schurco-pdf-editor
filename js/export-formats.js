// Converts the working document to Word/Excel. Unlike everything else in
// this app, these are lossy, one-way conversions, not edits — text and
// images are extracted and reflowed, not laid out pixel-for-pixel. That's
// the same ceiling every PDF-to-Office tool runs into; there is no reliable
// way to reproduce arbitrary PDF layout (columns, precise positioning) as
// live, editable Word/Excel content.

import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, PageBreak } from './vendor/docx.esm.js';
import * as XLSX from './vendor/xlsx.esm.mjs';

const PT_TO_PX = 96 / 72;

function mode(numbers) {
  if (!numbers.length) return null;
  const counts = new Map();
  let best = numbers[0];
  let bestCount = 0;
  for (const n of numbers) {
    const c = (counts.get(n) || 0) + 1;
    counts.set(n, c);
    if (c > bestCount) { bestCount = c; best = n; }
  }
  return best;
}

export async function buildDocxBlob(engine, pageIndices) {
  const pages = [];
  for (const idx of pageIndices) {
    const [lines, imageRects] = await Promise.all([engine.getTextLines(idx), engine.getImageRects(idx)]);
    pages.push({ idx, lines, imageRects });
  }

  const bodySize = mode(pages.flatMap((p) => p.lines.map((l) => Math.round(l.fontSize)))) || 12;

  const children = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const { idx, lines, imageRects } = pages[pi];
    if (pi > 0) children.push(new Paragraph({ children: [new PageBreak()] }));

    if (!lines.length && !imageRects.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: `[Page ${idx + 1} has no extractable text or images]`, italics: true })] }));
      continue;
    }

    // Interleave text lines and images in top-to-bottom reading order.
    const blocks = [
      ...lines.map((l) => ({ type: 'text', y: l.y, line: l })),
      ...imageRects.map((r) => ({ type: 'image', y: r.y + r.height, rect: r })),
    ].sort((a, b) => b.y - a.y);

    for (const block of blocks) {
      if (block.type === 'text') {
        const isHeading = block.line.fontSize > bodySize * 1.3;
        children.push(new Paragraph({
          heading: isHeading ? HeadingLevel.HEADING_1 : undefined,
          children: [new TextRun({ text: block.line.text, bold: isHeading || undefined })],
        }));
      } else {
        try {
          const pngBytes = await engine.extractRegionPng(idx, block.rect);
          children.push(new Paragraph({
            children: [new ImageRun({
              data: pngBytes,
              type: 'png',
              transformation: {
                width: Math.round(block.rect.width * PT_TO_PX),
                height: Math.round(block.rect.height * PT_TO_PX),
              },
            })],
          }));
        } catch {
          // If a particular image can't be lifted out, skip it rather than failing the whole export.
        }
      }
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

export async function buildXlsxBlob(engine, pageIndices) {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  for (const idx of pageIndices) {
    const lines = await engine.getTextLines(idx);
    const rows = lines.length ? lines.map((l) => [l.text]) : [['']];
    const ws = XLSX.utils.aoa_to_sheet(rows);

    let name = `Page ${idx + 1}`.slice(0, 31);
    let n = 2;
    while (usedNames.has(name)) { name = `Page ${idx + 1} (${n})`.slice(0, 31); n += 1; }
    usedNames.add(name);

    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const wbArray = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([wbArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
