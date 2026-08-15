const DEFAULT_PREVIEW_CODE_POINTS = 24;
const COMMAND_PROTOCOL_PREFIX_RE = /^\s*<\/?(?:local-)?command-[a-z]+\b/i;
const COMMAND_INVOCATION_PREFIX_RE = /^\s*<\/?command-(?:name|message|args)\b/i;

export function parseOutlineCommandProtocol(text) {
  const raw = String(text == null ? '' : text);
  if (!COMMAND_PROTOCOL_PREFIX_RE.test(raw)) return null;
  if (!COMMAND_INVOCATION_PREFIX_RE.test(raw)) {
    return Object.freeze({ kind: 'internal', preview: '' });
  }

  const name = /<command-name>([\s\S]*?)<\/command-name>/i.exec(raw);
  const message = /<command-message>([\s\S]*?)<\/command-message>/i.exec(raw);
  const args = /<command-args>([\s\S]*?)<\/command-args>/i.exec(raw);
  const command = ((name && name[1]) || (message && message[1]) || '').trim();
  if (!command) return Object.freeze({ kind: 'internal', preview: '' });
  const suffix = args && args[1].trim() ? ` ${args[1].trim()}` : '';
  return Object.freeze({
    kind: 'invocation',
    preview: `${command.startsWith('/') ? '' : '/'}${command}${suffix}`,
  });
}

function defaultUserPredicate(record) {
  if (!record || typeof record !== 'object') return false;
  return record.kind === 'user' || record.role === 'user' || record.type === 'user';
}

function defaultMessageText(record) {
  if (!record || typeof record !== 'object') return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (record.message && typeof record.message.content === 'string') return record.message.content;
  return '';
}

function defaultRowKey(record, index) {
  const value = record && (record.rowKey || record.uuid || record.messageId || record.id);
  return typeof value === 'string' && value ? value : `user-row-${index}`;
}

export function buildOutlinePreview(text, maxCodePoints = DEFAULT_PREVIEW_CODE_POINTS) {
  const collapsed = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!collapsed) return '\u2026';

  const limit = Math.max(1, Math.floor(Number(maxCodePoints) || DEFAULT_PREVIEW_CODE_POINTS));
  const chars = Array.from(collapsed);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}\u2026` : collapsed;
}

export function buildOutlineEntries(records, options = {}) {
  const source = Array.isArray(records) ? records : [];
  const isUser = typeof options.isUser === 'function' ? options.isUser : defaultUserPredicate;
  const getText = typeof options.getText === 'function' ? options.getText : defaultMessageText;
  const getRowKey = typeof options.getRowKey === 'function' ? options.getRowKey : defaultRowKey;
  const getMessageId = typeof options.getMessageId === 'function'
    ? options.getMessageId
    : (record, index, rowKey) => {
        const value = record && (record.messageId || record.uuid || record.id);
        return typeof value === 'string' && value ? value : rowKey || defaultRowKey(record, index);
      };
  const maxPreviewCodePoints = options.maxPreviewCodePoints || DEFAULT_PREVIEW_CODE_POINTS;
  const entries = [];
  const seenRowKeys = new Set();

  for (let index = 0; index < source.length; index++) {
    const record = source[index];
    if (!isUser(record, index)) continue;

    const rowKey = String(getRowKey(record, index) || '');
    if (!rowKey || seenRowKeys.has(rowKey)) continue;
    const messageId = String(getMessageId(record, index, rowKey) || rowKey);
    seenRowKeys.add(rowKey);
    entries.push({
      rowKey,
      messageId,
      preview: buildOutlinePreview(getText(record, index), maxPreviewCodePoints),
    });
  }

  return entries;
}

export function sampleOutlineEntries(entries, maxMarkers, mustKeepRowKeys = new Set()) {
  const source = Array.isArray(entries) ? entries : [];
  if (source.length <= 1) return source.slice();

  const requested = Math.max(2, Math.floor(Number(maxMarkers) || 0));
  if (source.length <= requested) return source.slice();

  const forced = new Set([0, source.length - 1]);
  for (let index = 0; index < source.length; index++) {
    if (mustKeepRowKeys && mustKeepRowKeys.has(source[index].rowKey)) forced.add(index);
  }

  const targetSize = Math.min(source.length, Math.max(requested, forced.size));
  const selected = new Set(forced);
  const idealPositions = Array.from({ length: targetSize }, (_, slot) => (
    slot * (source.length - 1) / (targetSize - 1)
  ));
  const unassignedSlots = new Set(idealPositions.map((_, slot) => slot));

  // Assign forced entries to the closest grid slots, then fill the remaining
  // slots from the original index space. This keeps normal sampling uniform
  // while retaining exact bookmark positions.
  for (const index of Array.from(forced).sort((a, b) => a - b)) {
    let bestSlot = -1;
    let bestDistance = Infinity;
    for (const slot of unassignedSlots) {
      const distance = Math.abs(idealPositions[slot] - index);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSlot = slot;
      }
    }
    if (bestSlot >= 0) unassignedSlots.delete(bestSlot);
  }

  for (const slot of Array.from(unassignedSlots).sort((a, b) => a - b)) {
    const ideal = idealPositions[slot];
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < source.length; index++) {
      if (selected.has(index)) continue;
      const distance = Math.abs(index - ideal);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) selected.add(bestIndex);
  }

  return Array.from(selected)
    .sort((a, b) => a - b)
    .map(index => source[index]);
}

export function resolveNearestMarkerKey(entries, sampledEntries, activeRowKey) {
  if (!activeRowKey || !Array.isArray(entries) || !Array.isArray(sampledEntries)) return null;
  const activeIndex = entries.findIndex(entry => entry.rowKey === activeRowKey);
  if (activeIndex < 0 || sampledEntries.length === 0) return null;

  let bestKey = null;
  let bestDistance = Infinity;
  for (const entry of sampledEntries) {
    const index = entries.findIndex(candidate => candidate.rowKey === entry.rowKey);
    if (index < 0) continue;
    const distance = Math.abs(index - activeIndex);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestKey = entry.rowKey;
    }
  }
  return bestKey;
}

export function resolveOwningUserRowKey(userRows, sourceIndex) {
  const rows = Array.isArray(userRows) ? userRows : [];
  if (!rows.length || !Number.isFinite(sourceIndex)) return null;
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rows[mid].sourceIndex <= sourceIndex) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found >= 0 ? rows[found].rowKey : null;
}

export function resolveActiveOutlineKey(anchors, viewport, lastRowKey) {
  const rows = Array.isArray(anchors) ? anchors : [];
  if (!rows.length) return lastRowKey || null;

  const scrollTop = Number(viewport && viewport.scrollTop) || 0;
  const clientHeight = Number(viewport && viewport.clientHeight) || 0;
  const scrollHeight = Number(viewport && viewport.scrollHeight) || 0;
  const anchorOffset = Number(viewport && viewport.anchorOffset) || 8;
  const bottomThreshold = Number(viewport && viewport.bottomThreshold) || 24;
  if (lastRowKey && scrollHeight - scrollTop - clientHeight <= bottomThreshold) return lastRowKey;

  const anchorTop = scrollTop + anchorOffset;
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rows[mid].top <= anchorTop) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return (found >= 0 ? rows[found] : rows[0]).rowKey || null;
}

export function createOutlineJumpController(options = {}) {
  const align = typeof options.align === 'function' ? options.align : () => false;
  const beforeJump = typeof options.beforeJump === 'function' ? options.beforeJump : () => {};
  const requestFrame = typeof options.requestFrame === 'function'
    ? options.requestFrame
    : callback => requestAnimationFrame(callback);
  const cancelFrame = typeof options.cancelFrame === 'function'
    ? options.cancelFrame
    : frame => cancelAnimationFrame(frame);
  const maxFrames = Math.max(1, Math.floor(Number(options.maxFrames) || 6));

  let frameId = null;
  let generation = 0;

  function cancel() {
    generation++;
    if (frameId != null) cancelFrame(frameId);
    frameId = null;
  }

  function jump(rowKey) {
    cancel();
    const token = generation;
    beforeJump(rowKey);
    let attempts = 0;

    const tick = () => {
      frameId = null;
      if (token !== generation) return false;
      attempts++;
      if (align(rowKey) !== true) return false;
      if (attempts < maxFrames) frameId = requestFrame(tick);
      return true;
    };

    return tick();
  }

  return Object.freeze({ cancel, destroy: cancel, jump });
}
