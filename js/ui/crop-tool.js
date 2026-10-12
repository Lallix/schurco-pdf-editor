// Crop tool: drag the area to keep on the page, then adjust it with the corner
// handles or the margin fields in the side panel. The draft is stored as
// margins ("insets") from the page's current visible edges so the same crop can
// be applied to many pages, even ones of slightly different size.

export function insetsToRect(info, ins) {
  return {
    x: info.boxX + ins.l,
    y: info.boxY + ins.b,
    width: Math.max(1, info.widthPt - ins.l - ins.r),
    height: Math.max(1, info.heightPt - ins.t - ins.b),
  };
}

export function rectToInsets(info, rect) {
  const clamp = (v) => Math.max(0, v);
  return {
    l: clamp(rect.x - info.boxX),
    b: clamp(rect.y - info.boxY),
    r: clamp(info.boxX + info.widthPt - (rect.x + rect.width)),
    t: clamp(info.boxY + info.heightPt - (rect.y + rect.height)),
  };
}

function pdfRectToScreen(viewport, r) {
  const p1 = viewport.convertToViewportPoint(r.x, r.y);
  const p2 = viewport.convertToViewportPoint(r.x + r.width, r.y + r.height);
  return { left: Math.min(p1[0], p2[0]), top: Math.min(p1[1], p2[1]), width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]) };
}

function rectFromScreen(viewport, left, top, width, height) {
  const [x1, y1] = viewport.convertToPdfPoint(left, top);
  const [x2, y2] = viewport.convertToPdfPoint(left + width, top + height);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

// Draw a new crop rectangle by dragging on the page.
export function wireCropDraw(hit, overlays, idx, viewport, state, actions) {
  hit.style.cursor = 'crosshair';
  hit.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const r0 = hit.getBoundingClientRect();
    const start = [e.clientX - r0.left, e.clientY - r0.top];
    const preview = document.createElement('div');
    preview.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box;border:2px dashed var(--accent);background:rgba(33,130,64,0.08);';
    overlays.appendChild(preview);
    let cur = start;
    const onMove = (ev) => {
      const r = hit.getBoundingClientRect();
      cur = [Math.min(Math.max(ev.clientX - r.left, 0), r.width), Math.min(Math.max(ev.clientY - r.top, 0), r.height)];
      Object.assign(preview.style, {
        left: `${Math.min(start[0], cur[0])}px`, top: `${Math.min(start[1], cur[1])}px`,
        width: `${Math.abs(cur[0] - start[0])}px`, height: `${Math.abs(cur[1] - start[1])}px`,
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      preview.remove();
      const w = Math.abs(cur[0] - start[0]), h = Math.abs(cur[1] - start[1]);
      if (w < 12 || h < 12) return;
      actions.onCropPageDrawn(idx, rectFromScreen(viewport, Math.min(start[0], cur[0]), Math.min(start[1], cur[1]), w, h));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// The kept area, with everything outside it dimmed, and draggable corners.
export function renderCropOverlay(overlays, idx, viewport, state, actions) {
  const draft = state.cropPageDraft;
  if (!draft || draft.pageIndex !== idx) return;
  const info = state.pages[idx];
  if (!info) return;
  const rect = insetsToRect(info, draft.insets);
  const s = pdfRectToScreen(viewport, rect);

  const clip = document.createElement('div');
  clip.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
  const keep = document.createElement('div');
  keep.style.cssText = `position:absolute;left:${s.left}px;top:${s.top}px;width:${s.width}px;height:${s.height}px;box-sizing:border-box;border:2px dashed var(--accent);box-shadow:0 0 0 4000px rgba(21,24,26,0.5);`;
  clip.appendChild(keep);
  overlays.appendChild(clip);

  const corners = [[s.left, s.top, 'nwse-resize', 'tl'], [s.left + s.width, s.top, 'nesw-resize', 'tr'],
    [s.left, s.top + s.height, 'nesw-resize', 'bl'], [s.left + s.width, s.top + s.height, 'nwse-resize', 'br']];
  for (const [x, y, cursor, which] of corners) {
    const h = document.createElement('div');
    h.style.cssText = `position:absolute;left:${x - 6}px;top:${y - 6}px;width:12px;height:12px;background:#fff;border:2px solid var(--accent);border-radius:2px;cursor:${cursor};pointer-events:auto;z-index:6;`;
    overlays.appendChild(h);
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX, y0 = e.clientY;
      const ghost = document.createElement('div');
      ghost.style.cssText = 'position:absolute;pointer-events:none;border:2px solid var(--accent);box-sizing:border-box;';
      overlays.appendChild(ghost);
      let box = { left: s.left, top: s.top, width: s.width, height: s.height };
      const mv = (ev) => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        let L = s.left, T = s.top, R = s.left + s.width, B = s.top + s.height;
        if (which.includes('l')) L += dx; else R += dx;
        if (which.includes('t')) T += dy; else B += dy;
        box = { left: Math.min(L, R), top: Math.min(T, B), width: Math.max(12, Math.abs(R - L)), height: Math.max(12, Math.abs(B - T)) };
        Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        ghost.remove();
        actions.onCropPageDrawn(idx, rectFromScreen(viewport, box.left, box.top, box.width, box.height));
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  const label = document.createElement('div');
  const wMm = Math.round(rect.width * 0.352778), hMm = Math.round(rect.height * 0.352778);
  label.style.cssText = `position:absolute;left:${s.left}px;top:${Math.max(0, s.top - 28)}px;background:var(--dark);color:#fff;font-size:11.5px;padding:5px 9px;border-radius:7px;pointer-events:none;white-space:nowrap;`;
  label.textContent = `${wMm} × ${hMm} mm`;
  overlays.appendChild(label);
}
