/** User scroll intent at the host's automatic transcript-follow boundary. */
import { subscribe } from './runtime_kernel.js';
import { reportHealth } from './enhance_shared.js';

const SCROLLER = '[class*="messagesContainer_"]';
let states = new WeakMap();
let middle = null;
let middlePress = null;
let started = false;

function getScroller(target) {
  const node = target?.nodeType === 1 ? target : target?.parentElement;
  return node?.closest?.(SCROLLER) || null;
}

function stateFor(node) {
  let state = states.get(node);
  if (!state) { state = { paused: false, middle: false }; states.set(node, state); }
  return state;
}

function endMiddle() {
  if (middle) {
    const state = stateFor(middle); state.middle = false;
    if (middle.scrollHeight - middle.scrollTop - middle.clientHeight <= 1) state.paused = false;
  }
  middle = null;
  middlePress = null;
}

/** Install once; never cancel native input, write scroll offsets, or drive frames. */
export function initTranscriptScroll() {
  if (started) return;
  started = true;
  globalThis.__INCIPIT_ALLOW_TRANSCRIPT_FOLLOW__ = (node, explicit) => {
    if (!node?.matches?.(SCROLLER)) return true;
    const state = stateFor(node);
    // Smooth jumps belong to host send/navigation/permission actions (2026-09-05).
    if (explicit) { state.paused = false; return true; }
    return !state.paused && !state.middle;
  };
  document.addEventListener('wheel', event => {
    endMiddle();
    const node = getScroller(event.target);
    if (!node) return;
    if (event.deltaY < 0) stateFor(node).paused = true;
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', event => {
    const node = getScroller(event.target);
    const wasMiddle = middle === node;
    endMiddle();
    if (!node) return;
    if (event.button === 1) {
      const state = stateFor(node); state.paused = true;
      if (!wasMiddle) { middle = node; state.middle = true; middlePress = { x: event.clientX, y: event.clientY, moved: false }; }
    } else if (event.button === 0 && event.target === node && event.offsetX >= node.clientWidth) stateFor(node).paused = true;
  }, { capture: true, passive: true });
  document.addEventListener('pointermove', event => {
    if (middlePress && (event.buttons & 4) && Math.hypot(event.clientX - middlePress.x, event.clientY - middlePress.y) > 3) middlePress.moved = true;
  }, { capture: true, passive: true });
  document.addEventListener('pointerup', event => {
    if (event.button === 1 && middlePress?.moved) endMiddle();
    middlePress = null;
  }, { capture: true, passive: true });
  document.addEventListener('pointercancel', endMiddle, { capture: true, passive: true });
  document.addEventListener('keydown', event => {
    endMiddle();
    const node = getScroller(event.target);
    if (!node || event.target.closest('input,textarea,[contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) stateFor(node).paused = true;
  }, true);
  document.addEventListener('scroll', event => {
    const node = event.target;
    if (!node?.matches?.(SCROLLER)) return;
    const state = states.get(node);
    if (state?.paused && !state.middle && node.scrollHeight - node.scrollTop - node.clientHeight <= 1) state.paused = false;
  }, { capture: true, passive: true });
  window.addEventListener('blur', endMiddle);
  subscribe('sessionChanged', () => { endMiddle(); states = new WeakMap(); });
  window.addEventListener('pagehide', () => { endMiddle(); states = new WeakMap(); });
  reportHealth('transcript.scrollIntent', 'ok', { mode: 'host-follow-guard' });
}
