import { getDiffModel } from './client.js';

function inputPreview(block, signal, notice) {
  const input = block.input || {};
  const edits = Array.isArray(input.edits) ? input.edits.map(edit => ({ oldText: edit.old_string, newText: edit.new_string })) :
    [{ oldText: input.old_string, newText: input.new_string }];
  if (edits.length && edits.every(edit => typeof edit.oldText === 'string' && typeof edit.newText === 'string')) {
    return getDiffModel({ source: 'tool-input', filePath: input.file_path, edits, lineNumbers: 'relative',
      notice: 'Replacement preview. ' + notice }, { signal });
  }
  if (block.name === 'Write' && typeof input.content === 'string') {
    return getDiffModel({ source: 'tool-input', filePath: input.file_path, proposedText: input.content,
      notice: 'Requested contents; saved original and change counts are not yet available. ' + notice }, { signal });
  }
  return null;
}

/** Shared lazy loader for main and nested tools; the caller owns request identity and lifetime. */
export async function loadHistoricalDiff({ block, key, signal, request, onPreview, onPending, onError }) {
  let payload, timer;
  try {
    const outcome = Promise.resolve().then(request);
    let settled = false;
    outcome.then(() => { settled = true; }, () => { settled = true; });
    try {
      payload = await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve(null), 80); })]);
      if (!payload && !signal?.aborted && onPreview) {
        const input = block.input || {};
        const size = (input.content?.length || 0) + (input.old_string?.length || 0) + (input.new_string?.length || 0) +
          (input.edits || []).reduce((sum, edit) => sum + (edit.old_string?.length || 0) + (edit.new_string?.length || 0), 0);
        if (size <= 128 * 1024) {
          const preview = await inputPreview(block, signal, 'Loading saved context…');
          if (preview && !settled && !signal?.aborted) { onPending?.(true); onPreview(preview); }
        }
      }
      payload = await outcome;
    } finally { clearTimeout(timer); outcome.catch(() => {}); }
  } catch (error) {
    if (error.name === 'AbortError' || signal?.aborted) throw error;
    onError?.(error);
    payload = { state: 'unavailable', notice: error.message };
  }
  onPending?.(payload.state !== 'ready');
  if (payload.state !== 'ready') {
    const preview = inputPreview(block, signal, payload.error || payload.notice || 'Saved context is unavailable.');
    if (preview) return preview;
    throw Object.assign(new Error(payload.notice || 'No saved diff is available. Open the original transcript to inspect it.'), { retryable: true });
  }
  return getDiffModel(payload, { key, signal });
}
