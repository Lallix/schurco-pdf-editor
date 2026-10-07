// Central app state with a minimal pub-sub so UI modules can react to changes
// without a framework. Call `update()` with a partial patch; subscribers
// receive the full state after each patch.

const listeners = new Set();

export const state = {
  fileName: null,
  pageCount: 0,
  // Per-page metadata mirrored from the pdf-lib document, indexed 0..pageCount-1
  pages: [], // { rotation, widthPt, heightPt, likelyScanned }
  activeTool: 'select',
  selectedPageIndex: null,   // page shown in the center canvas / properties panel
  checkedPages: new Set(),   // pages checked in the sidebar for multi-select export
  zoom: 1,
  isLoaded: false,
  isBusy: false,
  busyMessage: '',
  docRevision: 0, // bumped on every load/mutation so UI modules know to fully re-render
  isDirty: false,
  canUndo: false,
  canRedo: false,

  // Phase 2 interactive tool state
  textEdit: null,      // { pageIndex, rect, text, fontFamily, fontSize, color, bold, italic, underline }
  redactDraft: null,   // { pageIndex, rect } — drawn, awaiting confirm
  redactFill: 'match', // 'match' = blend into the page background (default) | 'black' | 'custom'
  redactColor: '#111111', // used when redactFill is 'custom'
  selectedImage: null, // { pageIndex, rect } — image tool selection
  cropDraft: null,     // { pageIndex, originalRect, keepRect? } — crop in progress
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function update(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}
