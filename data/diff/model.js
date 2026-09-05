/** Pure, cooperatively scheduled diff models shared by the worker and UI fallback. */
const NO_NEWLINE = '\\ No newline at end of file';
const DEFAULT_CONTEXT = 3;

export function diffAbortError() {
  return Object.assign(new Error('Diff computation cancelled.'), { name: 'AbortError' });
}

function workBudget(options) {
  const milliseconds = Math.max(1, Math.min(8, options.budgetMs || 4));
  let deadline = performance.now() + milliseconds;
  let checks = 0;
  return {
    operations: 0,
    coarse: false,
    check() {
      if (options.signal && options.signal.aborted) throw diffAbortError();
    },
    due(units = 1) {
      this.operations += units;
      if ((++checks & 127) !== 0) return false;
      this.check();
      return performance.now() >= deadline;
    },
    async yield() {
      this.check();
      if (options.yieldControl) await options.yieldControl();
      else await new Promise(resolve => setTimeout(resolve, 0));
      deadline = performance.now() + milliseconds;
      this.check();
    },
  };
}

async function textLines(text, work) {
  if (typeof text !== 'string') throw new TypeError('Both diff texts must be strings.');
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10 || code === 13) {
      lines.push({ text: text.slice(start, i), newline: true });
      if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    if (work.due()) await work.yield();
  }
  if (start < text.length) lines.push({ text: text.slice(start), newline: false });
  return lines;
}

function equalLine(a, b) {
  return a.text === b.text && a.newline === b.newline;
}

function makeRow(kind, text, oldLine, newLine, noNewline = false) {
  return { kind, text, oldLine, newLine, noNewline, hunk: 0, charRanges: [] };
}

async function uniqueAnchors(old, next, a0, a1, b0, b1, work) {
  const positions = new Map();
  const seenOld = new Map();
  const key = line => line.text + (line.newline ? '\n' : '');
  for (let j = b0; j < b1; j++) {
    const value = key(next[j]);
    positions.set(value, positions.has(value) ? -1 : j);
    if (work.due()) await work.yield();
  }
  for (let i = a0; i < a1; i++) {
    const value = key(old[i]);
    seenOld.set(value, seenOld.has(value) ? -1 : i);
    if (work.due()) await work.yield();
  }
  const pairs = [];
  for (let i = a0; i < a1; i++) {
    const value = key(old[i]);
    const j = positions.get(value);
    if (seenOld.get(value) === i && j !== undefined && j >= 0) pairs.push([i, j]);
    if (work.due()) await work.yield();
  }
  const tails = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pairs[tails[mid]][1] < pairs[i][1]) low = mid + 1;
      else high = mid;
    }
    if (low) previous[i] = tails[low - 1];
    tails[low] = i;
    if (work.due()) await work.yield();
  }
  const anchors = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) anchors.push(pairs[i]);
  return anchors.reverse();
}

/** Find a Myers middle split with linear memory rather than retaining every search path. */
async function middleSplit(old, next, a0, a1, b0, b1, work) {
  const n = a1 - a0;
  const m = b1 - b0;
  const maximum = Math.ceil((n + m) / 2);
  const offset = maximum + 1;
  const forward = new Int32Array(2 * maximum + 3).fill(-1);
  const backward = new Int32Array(2 * maximum + 3).fill(-1);
  forward[offset + 1] = 0;
  backward[offset + 1] = 0;
  const delta = n - m;
  const odd = delta % 2 !== 0;
  let forwardStart = 0, forwardEnd = 0, backwardStart = 0, backwardEnd = 0;
  const startOperations = work.operations;
  for (let d = 0; d <= maximum; d++) {
    // A completely rewritten huge block remains fully inspectable even when
    // searching for a minimal script would consume unbounded work.
    if (work.operations - startOperations > 8000000) { work.coarse = true; return null; }
    for (let k = -d + forwardStart; k <= d - forwardEnd; k += 2) {
      const index = offset + k;
      let x = k === -d || (k !== d && forward[index - 1] < forward[index + 1])
        ? forward[index + 1] : forward[index - 1] + 1;
      let y = x - k;
      while (x < n && y < m && x >= 0 && y >= 0 && equalLine(old[a0 + x], next[b0 + y])) {
        x++; y++;
        if (work.due()) await work.yield();
      }
      forward[index] = x;
      if (x > n) forwardEnd += 2;
      else if (y > m) forwardStart += 2;
      else if (odd) {
        const reverseIndex = offset + delta - k;
        if (reverseIndex >= 0 && reverseIndex < backward.length && backward[reverseIndex] >= 0 && x >= n - backward[reverseIndex]) {
          return [a0 + x, b0 + y];
        }
      }
      if (work.due()) await work.yield();
    }
    for (let k = -d + backwardStart; k <= d - backwardEnd; k += 2) {
      const index = offset + k;
      let x = k === -d || (k !== d && backward[index - 1] < backward[index + 1])
        ? backward[index + 1] : backward[index - 1] + 1;
      let y = x - k;
      while (x < n && y < m && x >= 0 && y >= 0 && equalLine(old[a1 - x - 1], next[b1 - y - 1])) {
        x++; y++;
        if (work.due()) await work.yield();
      }
      backward[index] = x;
      if (x > n) backwardEnd += 2;
      else if (y > m) backwardStart += 2;
      else if (!odd) {
        const forwardIndex = offset + delta - k;
        if (forwardIndex >= 0 && forwardIndex < forward.length && forward[forwardIndex] >= 0) {
          const splitX = forward[forwardIndex];
          const splitY = splitX - (delta - k);
          if (splitX >= n - x) return [a0 + splitX, b0 + splitY];
        }
      }
      if (work.due()) await work.yield();
    }
  }
  return null;
}

async function snapshotRows(oldText, newText, work) {
  const old = await textLines(oldText, work);
  const next = await textLines(newText, work);
  const rows = [];
  const tasks = [{ a0: 0, a1: old.length, b0: 0, b1: next.length }];
  while (tasks.length) {
    const task = tasks.pop();
    let { a0, a1, b0, b1 } = task;
    if (task.context) {
      for (; a0 < a1; a0++, b0++) {
        rows.push(makeRow('ctx', old[a0].text, a0 + 1, b0 + 1, !old[a0].newline));
        if (work.due()) await work.yield();
      }
      continue;
    }
    while (a0 < a1 && b0 < b1 && equalLine(old[a0], next[b0])) {
      rows.push(makeRow('ctx', old[a0].text, a0 + 1, b0 + 1, !old[a0].newline));
      a0++; b0++;
      if (work.due()) await work.yield();
    }
    const oldEnd = a1, newEnd = b1;
    while (a0 < a1 && b0 < b1 && equalLine(old[a1 - 1], next[b1 - 1])) {
      a1--; b1--;
      if (work.due()) await work.yield();
    }
    if (a1 < oldEnd) tasks.push({ a0: a1, a1: oldEnd, b0: b1, b1: newEnd, context: true });
    if (a0 === a1 || b0 === b1) {
      for (let i = a0; i < a1; i++) { rows.push(makeRow('del', old[i].text, i + 1, null, !old[i].newline)); if (work.due()) await work.yield(); }
      for (let j = b0; j < b1; j++) { rows.push(makeRow('add', next[j].text, null, j + 1, !next[j].newline)); if (work.due()) await work.yield(); }
      continue;
    }
    const anchors = a1 - a0 + b1 - b0 > 600 ? await uniqueAnchors(old, next, a0, a1, b0, b1, work) : [];
    if (anchors.length) {
      let rightA = a1, rightB = b1;
      for (let i = anchors.length - 1; i >= 0; i--) {
        const [ai, bi] = anchors[i];
        tasks.push({ a0: ai + 1, a1: rightA, b0: bi + 1, b1: rightB });
        tasks.push({ a0: ai, a1: ai + 1, b0: bi, b1: bi + 1, context: true });
        rightA = ai; rightB = bi;
      }
      tasks.push({ a0, a1: rightA, b0, b1: rightB });
      continue;
    }
    const split = await middleSplit(old, next, a0, a1, b0, b1, work);
    if (split && !(split[0] === a0 && split[1] === b0) && !(split[0] === a1 && split[1] === b1)) {
      tasks.push({ a0: split[0], a1, b0: split[1], b1 });
      tasks.push({ a0, a1: split[0], b0, b1: split[1] });
    } else {
      for (let i = a0; i < a1; i++) { rows.push(makeRow('del', old[i].text, i + 1, null, !old[i].newline)); if (work.due()) await work.yield(); }
      for (let j = b0; j < b1; j++) { rows.push(makeRow('add', next[j].text, null, j + 1, !next[j].newline)); if (work.due()) await work.yield(); }
    }
  }
  return rows;
}

async function nativeRows(hunks, work) {
  const rows = [];
  let previousOldEnd = 0, previousNewEnd = 0;
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index];
    if (!hunk || !Array.isArray(hunk.lines) || !['oldStart', 'oldLines', 'newStart', 'newLines'].every(key =>
      Number.isSafeInteger(hunk[key]) && hunk[key] >= 0)) throw new TypeError('Invalid native patch range.');
    if ((hunk.oldLines && !hunk.oldStart) || (hunk.newLines && !hunk.newStart)) throw new TypeError('Invalid nonempty patch start.');
    if (index && (hunk.oldStart < previousOldEnd || hunk.newStart < previousNewEnd)) throw new TypeError('Overlapping or unordered native patch hunks.');
    if (index) rows.push({ ...makeRow('gap', '', null, null), oldSkipped: hunk.oldStart - previousOldEnd,
      newSkipped: hunk.newStart - previousNewEnd });
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    let oldCount = 0, newCount = 0;
    const firstRow = rows.length;
    for (const line of hunk.lines) {
      if (line === NO_NEWLINE) {
        const last = rows[rows.length - 1];
        if (!last || last.kind === 'gap' || last.noNewline) throw new TypeError('Invalid no-newline marker.');
        last.noNewline = true;
        continue;
      }
      if (typeof line !== 'string' || !['+', '-', ' '].includes(line[0])) throw new TypeError('Unknown native patch line marker.');
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
      rows.push(makeRow(kind, line.slice(1), kind === 'add' ? null : oldLine++, kind === 'del' ? null : newLine++));
      if (kind !== 'add') oldCount++;
      if (kind !== 'del') newCount++;
      if (work.due()) await work.yield();
    }
    if (oldCount !== hunk.oldLines || newCount !== hunk.newLines) throw new TypeError('Native patch counts do not match its lines.');
    if (rows[firstRow]) { rows[firstRow].rangeOldStart = hunk.oldStart; rows[firstRow].rangeNewStart = hunk.newStart; }
    previousOldEnd = hunk.oldStart + oldCount;
    previousNewEnd = hunk.newStart + newCount;
  }
  return rows;
}

async function retainContext(rows, context, work) {
  const ranges = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== 'ctx' && rows[i].kind !== 'gap') {
      const start = Math.max(0, i - context), end = Math.min(rows.length, i + context + 1);
      const last = ranges[ranges.length - 1];
      if (last && start <= last[1]) last[1] = end;
      else ranges.push([start, end]);
    }
    if (work.due()) await work.yield();
  }
  const output = [];
  let end = 0;
  for (const [start, nextEnd] of ranges) {
    if (output.length && start > end) output.push({ ...makeRow('gap', '', null, null), oldSkipped: start - end, newSkipped: start - end });
    for (let i = start; i < nextEnd; i++) { output.push(rows[i]); if (work.due()) await work.yield(); }
    end = nextEnd;
  }
  return output;
}

async function addCharHints(rows, work) {
  let remaining = 64000;
  for (let i = 0; i < rows.length; i++) {
    const deleted = rows[i], added = rows[i + 1];
    if (!added || deleted.kind !== 'del' || added.kind !== 'add' ||
        (i && rows[i - 1].kind === 'del') || (rows[i + 2] && rows[i + 2].kind === 'add')) continue;
    if (deleted.text.length + added.text.length > remaining || deleted.text.length > 4000 || added.text.length > 4000) continue;
    remaining -= deleted.text.length + added.text.length;
    const a = Array.from(deleted.text), b = Array.from(added.text);
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    if ((prefix + suffix) / Math.max(1, a.length, b.length) >= 0.5) {
      // Offsets are UTF-16 boundaries for DOM text nodes, never half a surrogate.
      const start = a.slice(0, prefix).join('').length;
      const endA = a.slice(0, a.length - suffix).join('').length;
      const endB = b.slice(0, b.length - suffix).join('').length;
      if (endA > start) deleted.charRanges = [[start, endA]];
      if (endB > start) added.charRanges = [[start, endB]];
    }
    if (work.due()) await work.yield();
  }
}

/** Build a complete set of changed rows; only unchanged context may be omitted. */
export async function buildDiffModel(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Diff payload must be an object.');
  if (payload.schemaVersion !== undefined && payload.schemaVersion !== 1) throw new TypeError('Unsupported diff schema version.');
  const work = workBudget(options);
  work.check();
  const context = Number.isSafeInteger(options.contextLines) ? Math.max(0, options.contextLines) : DEFAULT_CONTEXT;
  const source = typeof payload.source === 'string' ? payload.source : 'review';
  let lineNumbers = source === 'tool-input' ? 'relative' : (payload.lineNumbers || 'absolute');
  let rows;
  if (Array.isArray(payload.hunks)) rows = await nativeRows(payload.hunks, work);
  else if (Array.isArray(payload.rows)) {
    rows = [];
    for (const row of payload.rows) {
      if (!row || !['ctx', 'add', 'del', 'gap'].includes(row.kind) || typeof row.text !== 'string') throw new TypeError('Invalid supplied diff row.');
      for (const field of ['oldLine', 'newLine']) if (row[field] != null && (!Number.isSafeInteger(row[field]) || row[field] < 1)) throw new TypeError('Invalid supplied line number.');
      rows.push({ ...makeRow(row.kind, row.text, row.oldLine ?? null, row.newLine ?? null, row.noNewline === true),
        oldSkipped: row.oldSkipped ?? null, newSkipped: row.newSkipped ?? null });
      if (work.due()) await work.yield();
    }
  } else if (typeof payload.proposedText === 'string' && source === 'tool-input') {
    rows = [];
    for (const line of await textLines(payload.proposedText, work)) {
      rows.push(makeRow('ctx', line.text, null, null, !line.newline));
      if (work.due()) await work.yield();
    }
  } else if (Array.isArray(payload.edits)) {
    rows = []; lineNumbers = 'relative';
    for (let i = 0; i < payload.edits.length; i++) {
      const edit = payload.edits[i];
      if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') throw new TypeError('Invalid independent edit.');
      if (i) rows.push({ ...makeRow('gap', 'Separate replacement', null, null), separate: true });
      const part = await retainContext(await snapshotRows(edit.oldText, edit.newText, work), context, work);
      // Replacement fragments are not files, so a missing trailing newline is
      // not an end-of-file fact worth marking.
      for (const row of part) { rows.push({ ...row, oldLine: null, newLine: null, noNewline: false }); if (work.due()) await work.yield(); }
    }
  } else {
    if (typeof payload.oldText !== 'string' || typeof payload.newText !== 'string') throw new TypeError('A verified text pair or structured patch is required.');
    rows = await snapshotRows(payload.oldText, payload.newText, work);
    if (options.contextLines !== Infinity) rows = await retainContext(rows, context, work);
  }
  await addCharHints(rows, work);
  let added = 0, removed = 0, byteSize = 512;
  const hunks = [];
  let current = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind === 'gap') current = null;
    else {
      if (!current) { current = { start: i, end: i, oldStart: row.rangeOldStart ?? row.oldLine, newStart: row.rangeNewStart ?? row.newLine }; hunks.push(current); }
      if (current.oldStart == null && row.oldLine != null) current.oldStart = row.oldLine;
      if (current.newStart == null && row.newLine != null) current.newStart = row.newLine;
      current.end = i + 1;
      row.hunk = hunks.length - 1;
    }
    if (row.kind === 'add') added++;
    if (row.kind === 'del') removed++;
    byteSize += 128 + row.text.length * 2 + row.charRanges.length * 16;
    if (work.due()) await work.yield();
  }
  work.check();
  const notice = [payload.notice || '', work.coarse ? 'A large rewritten range is shown as complete old and new lines.' : ''].filter(Boolean).join(' ');
  return { schemaVersion: 1, revision: payload.revision || null, source, filePath: payload.filePath || '',
    lineNumbers, notice, rows, hunks, stats: { added, removed }, statsScope: source === 'tool-input' ? 'fragment' : 'complete',
    quality: work.coarse || payload.quality === 'coarse' ? 'coarse' : 'exact', byteSize };
}
