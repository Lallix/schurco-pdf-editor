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

  // Phase 5: markups (annotations)
  markups: [],               // every markup in the document (see markups.js readMarkups)
  markupTool: 'select',      // which markup tool is active while activeTool === 'markup'
  markupStyle: { color: null, lineWidth: null, fontSize: 10, fill: 'auto', align: 'left', arc: null, invert: false }, // null = the tool's own default
  stampKey: 'Draft',
  selectedMarkup: null,      // ref key of the selected markup
  markupDraft: null,         // in-progress markup awaiting text / a leader point
  markupListOpen: false,
  markupFilter: { search: '', type: 'all', author: 'all' },
  markupAuthor: null,        // name written into new markups

  // Phase 2 interactive tool state
  textEdits: [],       // open text edits: { id, pageIndex, rect, text (original), draft (typed), fontFamily, fontSize, color, bold, italic, underline }
  activeTextEdit: null, // id of the edit whose style the panel shows
  redactMarks: [],     // [{ pageIndex, rect }] — areas marked for redaction, applied together on confirm
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
