const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const STATUS_ALIASES = Object.freeze({
  todo: 'pending',
  not_started: 'pending',
  active: 'in_progress',
  doing: 'in_progress',
  running: 'in_progress',
  done: 'completed',
  complete: 'completed',
  finished: 'completed',
});

export function normalizeTaskStatus(raw) {
  const key = String(raw == null ? '' : raw).trim().toLowerCase();
  if (VALID_STATUSES.has(key)) return key;
  if (Object.prototype.hasOwnProperty.call(STATUS_ALIASES, key)) return STATUS_ALIASES[key];
  return 'pending';
}

export function normalizeTaskText(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeTaskItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = normalizeTaskStatus(raw.status);
  const text = normalizeTaskText(
    status === 'in_progress' ? (raw.activeForm || raw.content) : (raw.content || raw.activeForm),
  );
  if (!text) return null;
  return Object.freeze({ text, status });
}

export function normalizeTaskSnapshot(rawTodos) {
  const source = Array.isArray(rawTodos) ? rawTodos : [];
  const items = [];
  for (const raw of source) {
    const item = normalizeTaskItem(raw);
    if (item) items.push(item);
  }
  const total = items.length;
  const completed = items.filter(item => item.status === 'completed').length;
  const hasInProgress = items.some(item => item.status === 'in_progress');
  const currentIndex = total === 0 ? 0 : Math.min(total, completed + 1);
  const state = total === 0 ? 'empty'
    : completed === total ? 'completed'
    : hasInProgress ? 'running'
    : 'pending';
  return Object.freeze({ items, total, completed, currentIndex, state });
}

function recordContent(record) {
  if (!record || typeof record !== 'object') return null;
  const content = record.content || (record.message && record.message.content);
  return content === undefined ? null : content;
}

function unwrapContentBlock(block) {
  if (block && typeof block === 'object' &&
      block.content && typeof block.content === 'object' &&
      typeof block.content.type === 'string') {
    return block.content;
  }
  return block;
}

function defaultGetToolUseBlocks(record) {
  const content = recordContent(record);
  if (!Array.isArray(content)) return [];
  return content
    .map(unwrapContentBlock)
    .filter(block => block && block.type === 'tool_use');
}

// A tool_result-only user record is an automatic roundtrip (Claude Code
// feeding a tool's output back in), not a real new instruction — mirrors
// enhance_legacy.js's transcriptHasToolResult convention for turn boundaries.
function defaultIsNewUserInstruction(record) {
  if (!record || record.type !== 'user') return false;
  const content = recordContent(record);
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return !content.some(block => {
    const unwrapped = unwrapContentBlock(block);
    return unwrapped && unwrapped.type === 'tool_result';
  });
}

export function findLatestTaskSnapshot(records, options = {}) {
  const source = Array.isArray(records) ? records : [];
  const getToolUseBlocks = typeof options.getToolUseBlocks === 'function'
    ? options.getToolUseBlocks
    : defaultGetToolUseBlocks;
  const isNewUserInstruction = typeof options.isNewUserInstruction === 'function'
    ? options.isNewUserInstruction
    : defaultIsNewUserInstruction;
  for (let index = source.length - 1; index >= 0; index--) {
    const record = source[index];
    const blocks = getToolUseBlocks(record, index);
    if (Array.isArray(blocks)) {
      for (let b = blocks.length - 1; b >= 0; b--) {
        const block = blocks[b];
        if (block && block.name === 'TodoWrite' && block.input && Array.isArray(block.input.todos)) {
          return normalizeTaskSnapshot(block.input.todos);
        }
      }
    }
    // A fresh user instruction after the last TodoWrite call means that
    // list belongs to a finished turn — hide it rather than show stale
    // progress until the new turn produces its own TodoWrite call.
    if (isNewUserInstruction(record)) return null;
  }
  return null;
}
