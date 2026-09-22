// Wraps the File System Access API (Chrome/Edge) so Open/Save can work
// against a real file handle — editing in place instead of always producing
// a fresh download. Falls back to null on browsers that don't support it
// (Firefox, Safari); callers fall back to the classic <input type="file">
// and an anchor-download in that case.

export function supportsFileSystemAccess() {
  return typeof window.showOpenFilePicker === 'function';
}

const PDF_TYPE = {
  description: 'PDF files',
  accept: { 'application/pdf': ['.pdf'] },
};

// Returns { bytes, name, handle } | { cancelled: true } | null (unsupported).
export async function pickPdfToOpen() {
  if (!supportsFileSystemAccess()) return null;
  try {
    const [handle] = await window.showOpenFilePicker({ types: [PDF_TYPE] });
    const file = await handle.getFile();
    return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, handle };
  } catch (e) {
    if (e && e.name === 'AbortError') return { cancelled: true };
    throw e;
  }
}

export async function writeToHandle(handle, bytes) {
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

// Prompts for a save location and writes `bytes` there. Returns the new
// handle, { cancelled: true }, or null if the browser has no save picker
// (caller should fall back to a plain download in that case).
export async function pickPdfSaveLocation(suggestedName, bytes) {
  if (typeof window.showSaveFilePicker !== 'function') return null;
  try {
    const handle = await window.showSaveFilePicker({ suggestedName, types: [PDF_TYPE] });
    await writeToHandle(handle, bytes);
    return handle;
  } catch (e) {
    if (e && e.name === 'AbortError') return { cancelled: true };
    throw e;
  }
}
