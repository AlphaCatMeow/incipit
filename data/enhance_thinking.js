import { SEL } from './host_probe.js';
import { ensureDomFreeze } from './enhance_shared.js';

/**
 * Thinking disclosure controller.
 *
 * Bootstrap installs the shared DOM freeze before this module loads. This
 * module only owns thinking intent, user toggles, and remount reconciliation.
 *
 * The summary label belongs to the host. Claude Code derives "Thought for Ns"
 * from a runtime-only clock that is null for anything loaded from history, so
 * a duration shows during a live turn and is absent afterwards. incipit used
 * to measure its own wall-clock and rewrite the label; that produced timings
 * no record could back, so the label is now left exactly as the host renders
 * it and no thinking duration is stored anywhere.
 */

// ========== thinking ==========
//
// The host syncs thinking state through the native `toggle` event on
// `<details>`. Suppress that path, mutate the real `open` attribute
// directly, and mirror expansion state in CSS through `[open]`.
//
// Viewport position is locked by recording `summary.getBoundingClientRect()`
// before the click and restoring the scroll delta afterward.
let thinkingStarted = false;

export function initThinking() {
  if (thinkingStarted) return;
  thinkingStarted = true;
  const freeze = ensureDomFreeze();
  const NATIVE_SET = freeze.nativeSet;
  const NATIVE_REMOVE = freeze.nativeRemove;
  // `dom-api-freeze` already patched the prototypes.
  // This subsystem freezes every thinking node, suppresses `toggle` state
  // sync, handles user clicks, and persists expansion intent across remounts.
  //
  // Intent is stored on a stable position key:
  // `m<msgIdx>t<thinkingIdx>`.

  const intentOpen = new Set();
  // Matches `--incipit-fold-duration`: the closing phase keeps `open` for this
  // long so the content can fold before the disclosure actually closes.
  const FOLD_MS = 220;

  const keyFor = (details) => {
    if (details.hasAttribute('data-incipit-owned-thinking')) return null;
    const msg = details.closest(SEL.message);
    if (!msg) return null;
    const container = msg.closest(SEL.messagesContainer) || document.body;
    const msgs = container.querySelectorAll(SEL.message);
    let msgIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i] === msg) { msgIdx = i; break; }
    }
    if (msgIdx < 0) return null;
    const thinkings = msg.querySelectorAll(SEL.thinking);
    let tIdx = -1;
    for (let i = 0; i < thinkings.length; i++) {
      if (thinkings[i] === details) { tIdx = i; break; }
    }
    if (tIdx < 0) return null;
    return `m${msgIdx}t${tIdx}`;
  };

  const armHostToggleSync = (details) => {
    details.__claudeAllowHostToggleOnce = true;
    if (details.__claudeAllowHostToggleReset) {
      clearTimeout(details.__claudeAllowHostToggleReset);
    }
    details.__claudeAllowHostToggleReset = setTimeout(() => {
      details.__claudeAllowHostToggleOnce = false;
      details.__claudeAllowHostToggleReset = null;
    }, 0);
  };

  // The host re-renders the built-in SVG toggle during streaming and flips
  // its expanded class independently from the frozen `<details>` state,
  // which makes the arrow flicker even while the body stays open. Hide that
  // SVG in CSS and let the summary pseudo-element read only the real `open`
  // attribute so arrow state cannot drift away from the content state.

  const reconcileAll = () => {
    const all = [...document.querySelectorAll(SEL.thinking)].filter(node => !node.hasAttribute('data-incipit-owned-thinking'));
    if (!all.length) return;
    // Build msgIdx and tIdx in one pass instead of calling keyFor per node.
    // keyFor on its own is O(messages) for the message index lookup, so
    // calling it N times during a reconcile pass scales as N × messages —
    // long sessions with many thinking blocks hit a wall here.
    const container = all[0].closest(SEL.messagesContainer) || document.body;
    const msgs = container.querySelectorAll(SEL.message);
    const msgIdxOf = new Map();
    for (let i = 0; i < msgs.length; i++) msgIdxOf.set(msgs[i], i);
    const tIdxOf = new Map();
    for (let i = 0; i < msgs.length; i++) {
      const ts = [...msgs[i].querySelectorAll(SEL.thinking)].filter(node => !node.hasAttribute('data-incipit-owned-thinking'));
      for (let j = 0; j < ts.length; j++) tIdxOf.set(ts[j], j);
    }
    for (let i = 0; i < all.length; i++) {
      const d = all[i];
      d.__claudeFrozen = true;
      const m = d.closest(SEL.message);
      if (!m) continue;
      const mi = msgIdxOf.get(m);
      if (mi == null) continue;
      const ti = tIdxOf.get(d);
      if (ti == null) continue;
      const k = `m${mi}t${ti}`;
      const shouldOpen = intentOpen.has(k);
      const isOpen = d.hasAttribute('open');
      if (shouldOpen && !isOpen) {
        NATIVE_SET.call(d, 'open', '');
      } else if (!shouldOpen && isOpen) {
        // New nodes should start collapsed until the user opens them.
        NATIVE_REMOVE.call(d, 'open');
      }
    }
  };
  reconcileAll();

  // React streaming remounts thinking blocks during the same task that
  // committed the new DOM. Reconcile in a microtask so the restored `open`
  // state lands before paint instead of one frame later, with a trailing
  // rAF pass as a safety net for any writes that happen after layout.
  let pendingMicrotask = false;
  let pendingFrame = false;
  const scheduleReconcile = () => {
    if (!pendingMicrotask) {
      pendingMicrotask = true;
      queueMicrotask(() => {
        pendingMicrotask = false;
        reconcileAll();
      });
    }
    if (pendingFrame) return;
    pendingFrame = true;
    requestAnimationFrame(() => {
      pendingFrame = false;
      reconcileAll();
    });
  };

  // Watch remounts and external writes to `open` so new thinking nodes can
  // inherit the user's last intent.
  //
  // The handler is a no-op unless the mutation actually touches a thinking
  // `<details>` — either by adding one into the tree or by flipping its
  // `open` attribute. Cheap string test first, DOM probe second. This keeps
  // the React reconciler's stream of chat-body mutations from firing a
  // microtask + rAF pair on every keystroke.
  const mightContainThinking = (node) => {
    if (!node || node.nodeType !== 1) return false;
    if (node.closest('[data-incipit-agent-history]')) return false;
    if (node.tagName === 'DETAILS') return true;
    // A node with no element children cannot contain a descendant
    // <details>. Streaming appends leaf text/inline spans into the prose
    // root constantly; skip the querySelector for that dominant case.
    if (!node.firstElementChild) return false;
    return typeof node.querySelector === 'function' && node.querySelector('details:not([data-incipit-owned-thinking])') !== null;
  };
  const thinkingObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target && m.target.tagName === 'DETAILS' && !m.target.closest('[data-incipit-agent-history]')) {
          scheduleReconcile();
          return;
        }
        continue;
      }
      for (const node of m.addedNodes) {
        if (mightContainThinking(node)) { scheduleReconcile(); return; }
      }
    }
  });
  thinkingObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });

  // The host React tree still needs one `toggle` after a user click so its
  // internal `isExpanded` prop stays aligned with the DOM we froze. Let that
  // one through, but keep suppressing every external close/open the host
  // emits during streaming.
  document.addEventListener('toggle', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches(SEL.thinking) && !t.hasAttribute('data-incipit-owned-thinking')) {
      if (t.__claudeAllowHostToggleOnce) {
        t.__claudeAllowHostToggleOnce = false;
        if (t.__claudeAllowHostToggleReset) {
          clearTimeout(t.__claudeAllowHostToggleReset);
          t.__claudeAllowHostToggleReset = null;
        }
        return;
      }
      e.stopImmediatePropagation();
    }
  }, true);

  const findScroller = (el) => {
    let n = el.parentElement;
    while (n) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const summary = t.closest(SEL.thinkingSummary);
    if (!summary) return;
    const details = summary.closest('details');
    if (!details || details.hasAttribute('data-incipit-owned-thinking')) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    // Reapply the frozen marker defensively.
    details.__claudeFrozen = true;

    const scroller = findScroller(details);
    const topBefore = summary.getBoundingClientRect().top;

    // Toggle through the captured native methods and update the intent set
    // so remounted nodes can be restored by `reconcileAll`. Opening and
    // closing carry a transient attribute that theme.css animates; the intent
    // only flips to closed once the fold has finished, so a reconcile pass in
    // between leaves the node alone.
    const k = keyFor(details);
    if (details.hasAttribute('open')) {
      if (details.__incipitClosing) {
        // A second click while folding keeps it open.
        clearTimeout(details.__incipitClosing);
        details.__incipitClosing = 0;
        details.removeAttribute('data-incipit-thinking-closing');
      } else {
        details.setAttribute('data-incipit-thinking-closing', '1');
        details.__incipitClosing = setTimeout(() => {
          details.__incipitClosing = 0;
          details.removeAttribute('data-incipit-thinking-closing');
          armHostToggleSync(details);
          NATIVE_REMOVE.call(details, 'open');
          if (k) intentOpen.delete(k);
        }, FOLD_MS);
      }
    } else {
      armHostToggleSync(details);
      NATIVE_SET.call(details, 'open', '');
      if (k) intentOpen.add(k);
      details.setAttribute('data-incipit-thinking-opening', '1');
      clearTimeout(details.__incipitOpening);
      details.__incipitOpening = setTimeout(() => {
        details.__incipitOpening = 0;
        details.removeAttribute('data-incipit-thinking-opening');
      }, FOLD_MS + 60);
    }

    // One rAF is enough: `getBoundingClientRect()` forces layout, so the
    // measurement is always post-reflow regardless of frame boundary.
    requestAnimationFrame(() => {
      const topAfter = summary.getBoundingClientRect().top;
      const delta = topAfter - topBefore;
      if (scroller && Math.abs(delta) > 0.5) {
        scroller.scrollTop += delta;
      }
    });
  }, true);
}
