import { filenameInConfiguredDownloadDirectory } from '../download-directory.js';
import '../content/file-upload-policy.js';
const { validateUploadFile, observedFileViewerResource, source: FILE_UPLOAD_POLICY_SOURCE } = globalThis.__wbFileUploadPolicy;
/**
 * CDP Client for Chrome DevTools Protocol
 * Provides access to shadow DOM, cross-origin iframes, pixel-perfect screenshots,
 * downloads, and uploads via chrome.debugger API.
 */

import { combineImages } from './image-utils.js';
import { beforePageAgentDispatch, capturePageAgentInputCompletion, hasPageAgentDispatchOwner, pageAgentDispatchTool, pageFeedbackPendingResult } from '../agent/page-feedback.js';

const SELECTOR_SCROLL_DISPATCH_SOURCE = `
  const beforeSelectorScroll = (element, guard) => {
    if (!guard) return true;
    const doc = element.ownerDocument;
    if (!element.isConnected || doc.documentElement?.getAttribute('data-webbrain-page-revision') !== guard.documentToken + ':' + guard.revision) return false;
    return element.dispatchEvent(new doc.defaultView.CustomEvent('webbrain-agent-scroll-dispatch', {
      bubbles: true, composed: true, cancelable: true, detail: JSON.stringify(guard),
    }));
  };
`;

const PAGE_AGENT_DOM_ACTION_SOURCE = `
  const beforePageAgentDomAction = (guard, phase, target = window) => {
    if (!guard) return true;
    const event = new CustomEvent('webbrain-agent-dom-dispatch', {
      detail: JSON.stringify({ ...guard, dispatchPhase: phase }), bubbles: true, composed: true, cancelable: true,
    });
    return target.dispatchEvent(event);
  };
`;

// <input> types whose value is one ISO date or time string; text inserted
// into them is ignored (see content.js _parseNativeDateInputValue).
export const NATIVE_DATE_INPUT_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

function throwIfPageFeedbackPending(result) {
  if (!result?.pageFeedbackPending) return;
  const error = new Error(pageFeedbackPendingResult().error);
  error.code = 'page_feedback_pending'; throw error;
}

// Rejections raised before a command could reach chrome.debugger: the session
// check, the receiving-target and page-feedback fences, and the caller's last
// beforeSend check. Any other rejection can follow an applied Input command
// (a lost acknowledgement), so callers must treat it as possibly delivered.
const COMMAND_NOT_SENT_ERRORS = new WeakSet();
export function isCdpCommandNotSentError(error) {
  if (!error || typeof error !== 'object') return false;
  // The dispatch fence rejects before any protocol command is issued.
  return COMMAND_NOT_SENT_ERRORS.has(error) || error.code === 'page_feedback_pending';
}

function readProseMirrorText(el) {
  if (!el?.isContentEditable || !el.classList?.contains('ProseMirror')) return null;
  // Paragraphs are document line breaks, not innerText's visual spacing.
  // ProseMirror's final BR is a caret placeholder, not another hard break.
  const read = node => {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    if (node.tagName === 'BR') return node.classList?.contains('ProseMirror-trailingBreak') ? '' : '\n';
    return Array.from(node.childNodes).map(read).join('');
  };
  const children = Array.from(el.childNodes);
  if (!children.every(node => node.nodeType === 1 && node.tagName === 'P')) return null;
  return children.map(read).join('\n');
}

function readEmptyCaretText(el) {
  // A sole BR can be either a browser caret or an authored literal LF.
  // Generic DOM shape cannot establish which; keep its rendered value.
  // DraftJS/ProseMirror markers and exact native-clear receipts prove their
  // own empty state independently. Only a genuinely empty DOM is generic.
  return el?.isContentEditable && el.childNodes?.length === 0
    && el.innerText === '' && el.textContent === '' ? '' : null;
}

async function pasteDraftJsText(el, text, clear, readDocument, options = {}) {
  const doc = el?.ownerDocument, view = doc?.defaultView, root = el?.getRootNode(), url = doc?.URL;
  let dispatched = false;
  const failure = (error, extra = {}) => ({
    success: false, verified: false, dispatched,
    ...(dispatched
      ? { mutationMayHaveOccurred: true, outcomeUnknown: true, retryable: false, recoveryRequired: 'verify_or_restore_field' }
      : { noDispatch: true, outcomeUnknown: false, retryable: false }),
    error, ...extra,
  });
  const expired = () => options.deadlineExpired?.() === true;
  const deadlineFailure = () => failure('The page action deadline expired during rich-text entry.', { deadlineExpired: true });
  const current = () => !!el?.isConnected && el.ownerDocument === doc && doc.defaultView === view
    && view.document === doc && el.getRootNode() === root && doc.URL === url;
  const active = () => {
    let target = root?.activeElement || doc?.activeElement;
    while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
    return target;
  };
  const selection = () => root?.getSelection?.() || view?.getSelection();
  const range = () => { const selected = selection(); return selected?.rangeCount === 1 ? selected.getRangeAt(0) : null; };
  const within = selected => !!selected && el.contains(selected.startContainer) && el.contains(selected.endContainer);
  const wait = () => new Promise(resolve => view.setTimeout(resolve, 30));
  const fence = phase => {
    if (options.beforeDispatch?.(phase) === false) {
      throw Object.assign(new Error('Browser changed during action preparation. Re-observe before acting.'), { code: 'page_feedback_pending' });
    }
  };
  try {
    if (expired()) return deadlineFailure();
    if (!current() || !el.isContentEditable || typeof readDocument !== 'function') return failure('The editable target is no longer available.');
    text = String(text).replace(/\r\n?/g, '\n');
    const previous = readDocument(el), htmlBefore = el.innerHTML;
    if (typeof previous !== 'string') return failure('The DraftJS document could not be read completely.', { recoveryRequired: 'fresh_tree' });
    if (!text.includes('\n')) return failure('This page-handled path requires multiline DraftJS text.');
    fence('focus');
    if (expired()) return deadlineFailure();
    el.focus({ preventScroll: true });
    await wait();
    if (!current() || readDocument(el) !== previous || el.innerHTML !== htmlBefore) {
      dispatched = true;
      return failure('The editor changed while preparing plain-text paste. No paste was sent.');
    }
    if (expired()) return deadlineFailure();
    if (active() !== el) return failure('The editor focus changed before plain-text paste.');
    // DraftJS maps marked text leaves to its public DOM selection. Selecting
    // the root or replacing its nodes can leave the model selection stale.
    const leaves = Array.from(el.querySelectorAll('[data-text="true"]'));
    const first = leaves[0], last = leaves[leaves.length - 1], selected = doc.createRange();
    if (!first || !last) return failure('The DraftJS text selection could not be established.');
    if (first.tagName === 'BR') selected.setStartBefore(first);
    else if (first.firstChild?.nodeType === 3) selected.setStart(first.firstChild, 0);
    else return failure('The DraftJS text selection could not be established.');
    if (last.tagName === 'BR') selected.setEndBefore(last);
    else if (last.lastChild?.nodeType === 3) selected.setEnd(last.lastChild, last.lastChild.nodeValue.length);
    else return failure('The DraftJS text selection could not be established.');
    if (!clear) selected.collapse(false);
    const selectedText = selection();
    if (!selectedText) return failure('The text selection is unavailable.');
    selectedText.removeAllRanges(); selectedText.addRange(selected);
    const prepared = range()?.cloneRange();
    await wait();
    if (!current() || readDocument(el) !== previous || el.innerHTML !== htmlBefore) {
      dispatched = true;
      return failure('The editor changed while preparing plain-text paste. No paste was sent.');
    }
    if (expired()) return deadlineFailure();
    const liveRange = range();
    if (active() !== el || !within(liveRange) || !prepared
        || liveRange.startContainer !== prepared.startContainer || liveRange.startOffset !== prepared.startOffset
        || liveRange.endContainer !== prepared.endContainer || liveRange.endOffset !== prepared.endOffset) {
      return failure('The editor focus or selection changed before plain-text paste.');
    }
    const transfer = new view.DataTransfer();
    transfer.setData('text/plain', text);
    const event = new view.ClipboardEvent('paste', { bubbles: true, composed: true, cancelable: true, clipboardData: transfer });
    // Firefox drops ClipboardEventInit.clipboardData. This event-local payload
    // is plain text only and never reads or writes the system clipboard.
    if (event.clipboardData?.getData('text/plain') !== text) Object.defineProperty(event, 'clipboardData', { value: transfer });
    if (event.clipboardData?.getData('text/plain') !== text) return failure('The plain-text paste payload could not be established.');
    fence('input');
    if (expired()) return deadlineFailure();
    const fencedRange = range();
    if (!current() || readDocument(el) !== previous || el.innerHTML !== htmlBefore) {
      dispatched = true;
      return failure('The editor changed during the paste dispatch fence. No paste was sent.');
    }
    if (active() !== el || !within(fencedRange)
        || fencedRange.startContainer !== prepared.startContainer || fencedRange.startOffset !== prepared.startOffset
        || fencedRange.endContainer !== prepared.endContainer || fencedRange.endOffset !== prepared.endOffset) {
      return failure('The editor focus or selection changed at the paste dispatch fence.');
    }
    const invoke = () => { dispatched = true; return el.dispatchEvent(event); };
    const accepted = options.dispatch ? options.dispatch(invoke) : invoke();
    await wait(); await wait();
    if (expired()) return deadlineFailure();
    // From here the paste went out. `unverified` tells the agent the text
    // was sent but its settled value is unconfirmed; its policy decides
    // whether that is a failure (Strict checks) or a noted success.
    if (!current() || active() !== el || !within(range())) return failure('The editor scope changed during plain-text paste.',
      { unverified: { reason: 'readback_unavailable', reader: 'none' }, readbackExact: false });
    const value = readDocument(el), expected = (clear ? '' : previous) + text;
    if (accepted || typeof value !== 'string' || value !== expected) {
      const readable = typeof value === 'string';
      return failure('The complete settled DraftJS value could not be verified after plain-text paste. No additional text was sent.', {
        unverified: { reason: !readable ? 'readback_unavailable' : value !== expected ? 'readback_mismatch' : 'paste_not_consumed',
          reader: readable ? 'semantic' : 'none' },
        readbackExact: readable,
      });
    }
    return { success: true, verified: true, dispatched: true, outcomeUnknown: false,
      pageHandledPaste: true, method: 'contenteditable-page-handled-paste', value: value.slice(0, 100) };
  } catch (error) {
    return failure(error?.message || String(error), error?.code === 'page_feedback_pending' ? { pageFeedbackPending: true } : {});
  }
}

// This private object exists only around one native SelectAll/Delete operation.
// A caret BR without this exact event/node history remains an authored LF.
function nativeTextClearReceipt(el) {
  if (!el?.isConnected || !el.isContentEditable) return null;
  // Semantic document readers prove these editors empty. Their framework
  // legitimately rerenders text/caret nodes after deletion, whereas this
  // receipt only certifies an ordinary browser-created, unmarked caret BR.
  if (el.classList?.contains('public-DraftEditor-content') || el.classList?.contains('ProseMirror')
      || Array.from(el.children || []).some(child => child.getAttribute('data-contents') === 'true')) return null;
  const doc = el.ownerDocument, view = doc.defaultView, root = el.getRootNode(), url = doc.URL;
  const parent = node => node.parentNode || (node.nodeType === 11 ? node.host : null);
  const ancestors = []; for (let node = parent(el); node; node = parent(node)) ancestors.push(node);
  // The original roots expose their activeElement even for a closed shadow tree.
  // Pin every host up to the document rather than rediscovering through .shadowRoot.
  const activeBindings = [];
  for (let scope = root, target = el; scope; target = scope.host, scope = target?.getRootNode()) {
    activeBindings.push([scope, target]);
    if (scope === doc) break;
  }
  const selection = () => root.getSelection?.() || view.getSelection();
  const range = () => { const value = selection(); return value?.rangeCount === 1 ? value.getRangeAt(0) : null; };
  const sameRange = (a, b) => !!a && !!b && a.startContainer === b.startContainer && a.startOffset === b.startOffset
    && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
  const within = value => !!value && el.contains(value.startContainer) && el.contains(value.endContainer);
  const originalBreaks = new Set(el.querySelectorAll('br'));
  const originalNodes = new Set([el]), originalText = new Map(), deletedTextNodes = new Set();
  const originalWalker = doc.createTreeWalker(el, view.NodeFilter.SHOW_ALL);
  for (let node = originalWalker.nextNode(); node; node = originalWalker.nextNode()) {
    originalNodes.add(node); if (node.nodeType === 3) originalText.set(node, node.nodeValue);
  }
  const fullySelected = () => {
    const value = range();
    if (!within(value) || value.collapsed) return false;
    const walker = doc.createTreeWalker(el, view.NodeFilter.SHOW_ELEMENT | view.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 3) {
        if (value.comparePoint(node, 0) !== 0 || value.comparePoint(node, node.length) !== 0) return false;
      } else if (!node.childNodes.length) {
        const offset = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        if (value.comparePoint(node.parentNode, offset) !== 0 || value.comparePoint(node.parentNode, offset + 1) !== 0) return false;
      }
    }
    return true;
  };
  const originalRange = range()?.cloneRange();
  let invalid = false, closed = false, selected = 0, deleted = 0, released = 0, before = 0, inputs = 0, caret = null, settledRange = null;
  const current = () => {
    let node = parent(el);
    for (const ancestor of ancestors) { if (node !== ancestor) return false; node = parent(node); }
    return !closed && !invalid && el.isConnected && doc.defaultView === view && view.document === doc
      && doc.URL === url && el.getRootNode() === root
      && activeBindings.every(([scope, target]) => scope.activeElement === target) && (!selected || within(range()));
  };
  if (!current()) return null;
  // The transport refreshes these private markers before its own input commands.
  // All other editor/identity mutations remain part of the receipt's fence.
  const relevant = record => !(record.type === 'attributes'
      && ['data-webbrain-native-target', 'data-webbrain-page-revision'].includes(record.attributeName))
    && (originalNodes.has(record.target) || record.target === el || el.contains(record.target)
    || (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes]
      .some(node => node === el || node.contains?.(el) || ancestors.some(ancestor => node === ancestor || node.contains?.(ancestor))))
    || (record.type === 'attributes' && ancestors.includes(record.target)
      && /^(?:id|role|aria-label|contenteditable|disabled|readonly|inert|hidden|data-)/.test(record.attributeName || '')));
  let pendingDeleteRecords = [];
  const nativeDeleteMutation = record => ['childList', 'characterData'].includes(record.type)
    && (originalNodes.has(record.target) || record.target === el || el.contains(record.target));
  const observer = new view.MutationObserver(records => {
    const changes = records.filter(relevant);
    if (!changes.length) return;
    // Another capture listener can yield a mutation checkpoint before this
    // receipt sees input. Hold only the expected native deletion's records;
    // the one matching trusted input must consume them before any proof.
    if (deleted === 1 && before === 1 && inputs === 0 && current()
        && changes.every(nativeDeleteMutation) && pendingDeleteRecords.length + changes.length <= 128) {
      pendingDeleteRecords.push(...changes);
    } else invalid = true;
  });
  observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true });
  for (const [scope] of activeBindings) if (scope !== doc) {
    observer.observe(scope, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true });
  }
  const drain = () => {
    if (pendingDeleteRecords.length || observer.takeRecords().some(relevant)) invalid = true;
  };
  const drainNativeDelete = () => {
    const changes = [...pendingDeleteRecords, ...observer.takeRecords()]; pendingDeleteRecords = [];
    for (const record of changes.filter(relevant)) {
      if (!nativeDeleteMutation(record)) { invalid = true; continue; }
      if (record.type === 'characterData') {
        if (!originalText.has(record.target) || record.oldValue !== originalText.get(record.target)
            || record.target.nodeValue !== '' || deletedTextNodes.has(record.target)) invalid = true;
        deletedTextNodes.add(record.target);
      } else if (!originalNodes.has(record.target)
          || [...record.removedNodes].some(node => !originalNodes.has(node))
          || [...record.addedNodes].some(node => node !== el.firstChild || node.nodeName !== 'BR'
            || node.attributes.length !== 0 || originalBreaks.has(node))) invalid = true;
    }
  };
  let retargetedInput = null;
  const handlers = {
    keydown(event) {
      if (!event.isTrusted || event.target !== el || !current()) { invalid = true; return; }
      if (event.code === 'KeyA' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
          && selected === 0 && deleted === 0) { selected++; return; }
      if (event.code === 'Delete' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
          && selected === 1 && deleted === 0 && fullySelected()) { deleted++; return; }
      invalid = true;
    },
    keyup(event) {
      if (!event.isTrusted || event.target !== el) { invalid = true; return; }
      if (event.code === 'KeyA' && selected === 1 && deleted === 0) return;
      if (event.code === 'Delete' && deleted === 1 && released === 0) { released++; return; }
      invalid = true;
    },
    beforeinput(event) {
      drain();
      if (!event.isTrusted || event.target !== el || event.inputType !== 'deleteContentForward'
          || selected !== 1 || deleted !== 1 || before !== 0 || !current()) { invalid = true; return; }
      if (!fullySelected()) { invalid = true; return; }
      before++;
    },
    input(event) {
      if (!event.isTrusted || event.target !== el || event.inputType !== 'deleteContentForward'
          || before !== 1 || inputs !== 0 || (root !== doc && retargetedInput !== event) || !current()) { invalid = true; return; }
      // Discard exactly the browser's native deletion records. Later framework
      // changes, including a change followed by restoration, invalidate proof.
      drainNativeDelete(); inputs++;
      caret = el.isContentEditable && el.childNodes.length === 1 && el.firstChild?.nodeName === 'BR'
        && !originalBreaks.has(el.firstChild) && el.firstChild.attributes.length === 0 && el.textContent === '' ? el.firstChild : null;
      settledRange = range()?.cloneRange();
    },
    selectionchange() {
      if (inputs) { if (!sameRange(range(), settledRange)) invalid = true; }
      else if (!selected && !sameRange(range(), originalRange)) invalid = true;
      else if (!within(range())) invalid = true;
    },
    focusin(event) { if (event.target !== el) invalid = true; },
    focusout() { invalid = true; },
    blur() { invalid = true; },
    pointerdown() { invalid = true; }, wheel() { invalid = true; },
    paste() { invalid = true; }, drop() { invalid = true; },
  };
  const listeners = [];
  const listen = (scope, name, handler) => { scope.addEventListener(name, handler, true); listeners.push([scope, name, handler]); };
  for (const [name, handler] of Object.entries(handlers)) {
    // Native events are retargeted to the host at document listeners. Count the
    // exact keyboard/input sequence once, in the original editable's own root.
    // For a document editor, observe input before document-capture handlers
    // in the installed content scripts create a mutation microtask checkpoint.
    listen(root === doc ? view : root, name, handler);
    if (root !== doc) listen(doc, name, event => {
      if (name === 'selectionchange' || ['focusout', 'blur', 'pointerdown', 'wheel', 'paste', 'drop'].includes(name)) handler(event);
      else if (!event.isTrusted || !event.composed || event.target !== activeBindings.at(-1)[1]) invalid = true;
      else if (name === 'input' && event.inputType === 'deleteContentForward'
          && before === 1 && inputs === 0 && current()) {
        // Drain the browser deletion before this capture listener's microtask
        // checkpoint delivers it as an unrelated mutation. The own-root
        // listener still must validate this exact event and exact editable.
        retargetedInput = event;
        drainNativeDelete();
      }
    });
  }
  const dispose = () => {
    if (closed) return; closed = true;
    observer.disconnect();
    for (const [scope, name, handler] of listeners) scope.removeEventListener(name, handler, true);
    view.clearTimeout(timer);
  };
  const timer = view.setTimeout(dispose, 5000);
  return {
    current() { drain(); return current(); },
    verify() {
      drain();
      return current() && selected === 1 && deleted === 1 && released === 1 && before === 1 && inputs === 1
        && sameRange(range(), settledRange) && !!caret && el.childNodes.length === 1 && el.firstChild === caret
        && caret.attributes.length === 0 && el.textContent === '' && el.innerText === '\n';
    },
    dispose,
  };
}

function isDraftJsEditor(el) {
  return !!el?.isContentEditable && (el.classList?.contains('public-DraftEditor-content')
    || Array.from(el.children || []).some(child => child.getAttribute('data-contents') === 'true'));
}

function readDraftJsText(el) {
  if (!el?.isContentEditable || !el.childNodes) return null;
  const roots = Array.from(el.childNodes);
  if (roots.length !== 1 || roots[0].nodeType !== 1 || roots[0].tagName !== 'DIV'
      || roots[0].getAttribute('data-contents') !== 'true') return null;
  let visited = 0;
  const supported = node => {
    if (++visited > 4096 || node.shadowRoot || node.hidden || String(node.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true'
        || String(node.getAttribute('contenteditable') || '').trim().toLowerCase() === 'false') return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    return !!style && (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility)
      && style.opacity !== '0' && style.contentVisibility !== 'hidden');
  };
  if (!supported(el) || !supported(roots[0])) return null;
  const blocks = Array.from(roots[0].childNodes);
  if (!blocks.length) return null;
  const texts = [];
  for (const block of blocks) {
    if (block.nodeType !== 1 || block.tagName !== 'DIV' || block.getAttribute('data-block') !== 'true'
        || !block.getAttribute('data-offset-key') || !supported(block)) return null;
    const children = Array.from(block.childNodes);
    const body = children[0];
    if (children.length !== 1 || body?.nodeType !== 1 || body.tagName !== 'DIV'
        || !body.classList.contains('public-DraftStyleDefault-block')
        || !body.getAttribute('data-offset-key') || !supported(body)) return null;
    const leaves = [];
    const read = (node, depth = 0) => {
      if (depth > 32 || node.nodeType !== 1 || !supported(node)) return false;
      if (node.tagName === 'BR') {
        if (node.getAttribute('data-text') !== 'true' || node.childNodes.length) return false;
        leaves.push(null); return true;
      }
      if (node.tagName !== 'SPAN') return false;
      const descendants = Array.from(node.childNodes);
      if (node.getAttribute('data-text') === 'true') {
        if (!descendants.every(child => child.nodeType === 3)) return false;
        leaves.push(descendants.map(child => child.nodeValue || '').join('')); return true;
      }
      return descendants.length > 0 && descendants.every(child => read(child, depth + 1));
    };
    if (!body.childNodes.length || !Array.from(body.childNodes).every(node => read(node))) return null;
    // DraftJS's sole data-text BR in an empty block is a caret placeholder.
    // Real document breaks are separators between blocks (or text in leaves).
    // Mixed BR/text and embeds are unsupported; keep their rendered fallback.
    const placeholders = leaves.filter(value => value === null).length;
    if (placeholders && (placeholders !== 1 || leaves.some(value => value !== null && value !== ''))) return null;
    texts.push(leaves.filter(value => value !== null).join(''));
  }
  return texts.join('\n');
}

const FULL_PAGE_SCROLL_SETTLE_MS = 100;
const FULL_PAGE_STABLE_PASSES = 2;
const FULL_PAGE_MAX_DISCOVERY_STEPS = 100;
const FULL_PAGE_MAX_CONTENT_GROWTHS = 5;
const FULL_PAGE_MAX_CAPTURE_TILES = 500;
const WEBMCP_DISCOVERY_SETTLE_MS = 50;
const WEBMCP_MAX_REGISTERED_TOOLS = 200;
const WEBMCP_DEFAULT_PAGE_SIZE = 10;
const WEBMCP_MAX_PAGE_SIZE = 25;
const WEBMCP_DEFAULT_INVOCATION_TIMEOUT_MS = 30000;
const WEBMCP_MAX_INVOCATION_TIMEOUT_MS = 60000;
const WEBMCP_MAX_VALUE_NODES = 500;
const WEBMCP_MAX_VALUE_CHARS = 20000;
const WEBMCP_CONTEXT_DISCOVERY_TIMEOUT_MS = 1000;
const WEBMCP_MAX_DISCOVERY_CONTEXTS = 500;
const WEBMCP_MAX_DISCOVERY_CONCURRENCY = 16;
const WEBMCP_MAX_CHILD_SESSIONS = 100;
const WEBMCP_MAX_TARGET_ATTACH_PASSES = 10;
const WEBMCP_IFRAME_TARGET_FILTER = [
  { type: 'iframe', exclude: false },
  { exclude: true },
];
// Text-entry verification proves an edit landed by comparing the field's value
// before and after. We hash instead of shipping the raw value to the service
// worker so page content never leaves the tab. 32-bit FNV-1a via Math.imul:
// the append proof recomputes this once per candidate insertion point, so a
// BigInt hash made a long contenteditable an O(n*m) freeze inside the page.
const TEXT_ENTRY_SIGNATURE_SOURCE = `function (value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  }
  return value.length + ':' + hash.toString(16);
}`;
// Above this length the per-candidate rescan stops being worth its cost. The
// edit still succeeds; it is reported unproven, which is not a failure signal.
const TEXT_ENTRY_PROOF_MAX_CHARS = 65536;

const WEBMCP_CONTEXT_DISCOVERY_EXPRESSION = `
  (async () => {
    const context = document.modelContext;
    if (typeof context?.getTools !== 'function') return [];
    const tools = await context.getTools();
    return tools
      .filter(tool => tool?.window === window)
      .slice(0, ${WEBMCP_MAX_REGISTERED_TOOLS})
      .map(tool => {
        let inputSchema = tool.inputSchema;
        if (typeof inputSchema === 'string') {
          try { inputSchema = JSON.parse(inputSchema); } catch { inputSchema = null; }
        }
        return {
          name: tool.name,
          description: tool.description,
          inputSchema,
          annotations: {
            readOnly: tool.annotations?.readOnlyHint === true,
            untrustedContent: tool.annotations?.untrustedContentHint === true,
            autosubmit: false,
          },
        };
      });
  })()
`;

export class CDPClient {
  constructor() {
    this.sessions = new Map(); // tabId -> debugger session
    this.attachPromises = new Map(); // tabId -> in-flight debugger attach
    this.attachGenerations = new Map(); // tabId -> current attach generation
    this.eventHandlers = new Map(); // tabId -> { eventName -> [handlers] }
    this.devDiagnostics = new Map(); // tabId -> bounded console/network buffers
    this.webMcpSessions = new Map(); // tabId -> WebMCP tools + pending invocations
    this.runtimeContexts = new Map(); // tabId -> session/context key -> default context
    this.pendingDialogs = new Map(); // tabId -> sessionId -> current native dialog
    this.dialogRuns = new Map(); // tabId -> active action-run owner
    this.dialogIntents = new Map(); // tabId -> the run's wish to answer dialogs, across debugger connections
    this.fileChooserGuards = new Map(); // tabId -> temporary protocol interception
    this._debuggerListenersRegistered = false;
    this._onDebuggerEvent = (source, method, params) => {
      const tabId = source?.tabId;
      if (tabId == null) return;
      if (method === 'Page.javascriptDialogOpening') {
        if (!this.pendingDialogs.has(tabId)) this.pendingDialogs.set(tabId, new Map());
        const dialog = { type: params?.type, navigation: this.dialogRuns.get(tabId)?.navigation, url: params?.url };
        this.pendingDialogs.get(tabId).set(source.sessionId || '', dialog);
        this._continueJavaScriptDialog(tabId, source, dialog);
      } else if (method === 'Page.javascriptDialogClosed') {
        this.pendingDialogs.get(tabId)?.delete(source.sessionId || '');
        if (!this.pendingDialogs.get(tabId)?.size) this.pendingDialogs.delete(tabId);
      }
      this._trackRuntimeContextEvent(tabId, source, method, params);
      const handlers = this.eventHandlers.get(tabId)?.[method];
      if (handlers) {
        handlers.forEach(h => h(params, source));
      }
    };
    this._onDebuggerDetach = (source, reason) => {
      const tabId = source?.tabId;
      if (tabId == null) return;
      const pendingAttach = this.attachPromises.get(tabId);
      if (pendingAttach) {
        pendingAttach.cancelled = true;
        pendingAttach.detached = true;
        this.attachGenerations.set(tabId, (this.attachGenerations.get(tabId) || 0) + 1);
      }
      // A dropped connection ends this connection's dialog handling but not
      // the run's: the next attach or navigation arms it again. The person
      // cancelling the debugger ends it for the run.
      if (reason === 'canceled_by_user') this.stopDialogHandling(tabId);
      else this._disarmDialogHandling(tabId, 'dropped');
      this.pendingDialogs.delete(tabId);
      this._dropWebMCPSession(tabId, `Debugger detached: ${reason || 'unknown reason'}`);
      this.sessions.delete(tabId);
      this.eventHandlers.delete(tabId);
      this.devDiagnostics.delete(tabId);
      this.runtimeContexts.delete(tabId);
      const fileChooserGuard = this.fileChooserGuards.get(tabId);
      if (fileChooserGuard?.timer) clearTimeout(fileChooserGuard.timer);
      this.fileChooserGuards.delete(tabId);
    };
  }

  _ensureDebuggerListeners() {
    if (this._debuggerListenersRegistered) return;
    chrome.debugger.onEvent.addListener(this._onDebuggerEvent);
    try {
      chrome.debugger.onDetach.addListener(this._onDebuggerDetach);
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      chrome.debugger.onEvent.removeListener(this._onDebuggerEvent);
      throw error;
    }
    this._debuggerListenersRegistered = true;
  }

  /**
   * Source of the shared rich-text toolbar heuristic, read from the packaged
   * file and cached for the worker's lifetime.
   *
   * The main world this gets evaluated in cannot import modules and cannot see
   * the content script's isolated world, so the scoring has to travel as text.
   * Reading the same file the content scripts load is what keeps the CDP probe
   * and the content probe from ever scoring an element differently.
   */
  static async _richTextToolbarHeuristicSource() {
    // Harnesses that drive this client outside an extension (the fixtures
    // runner) have no chrome.runtime to read packaged files through, so they
    // supply the same file's text directly.
    if (typeof CDPClient._heuristicSourceOverride === 'string') {
      return CDPClient._heuristicSourceOverride;
    }
    if (CDPClient._heuristicSourcePromise) return CDPClient._heuristicSourcePromise;
    CDPClient._heuristicSourcePromise = (async () => {
      try {
        const url = chrome.runtime.getURL('src/content/rich-text-toolbar-heuristic.js');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Packaged toolbar classifier returned HTTP ${response.status}`);
        const source = await response.text();
        if (!source.trim()) throw new Error('Packaged toolbar classifier was empty');
        return source;
      } catch {
        // The selector preflight treats a missing packaged classifier as
        // unresolved and fails closed before any text-entry dispatch.
        CDPClient._heuristicSourcePromise = null;
        return '';
      }
    })();
    return CDPClient._heuristicSourcePromise;
  }

  /**
   * Attach debugger to a tab.
   */
  async attach(tabId) {
    if (this.sessions.has(tabId)) {
      return this.sessions.get(tabId);
    }
    const existingAttach = this.attachPromises.get(tabId);
    if (existingAttach && !existingAttach.cancelled) {
      return existingAttach;
    }

    this._ensureDebuggerListeners();

    const generation = (this.attachGenerations.get(tabId) || 0) + 1;
    this.attachGenerations.set(tabId, generation);

    const attachPromise = new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', async () => {
        let recovered = false;
        if (chrome.runtime.lastError) {
          const attachError = new Error(chrome.runtime.lastError.message);
          if (attachError.message !== `Another debugger is already attached to the tab with id: ${tabId}.`) {
            reject(attachError); return;
          }
          const current = () => !attachPromise.cancelled && this.attachGenerations.get(tabId) === generation;
          if (!current()) { reject(new Error('Debugger attachment was cancelled')); return; }
          // Chrome retains this extension's debugger connection across worker
          // restarts. sendCommand is authorized only for this extension's own
          // client, so a successful literal read proves ownership without
          // disconnecting a different debugger or trusting getTargets.attached.
          try {
            await new Promise((resolveProbe, rejectProbe) => {
              const timer = setTimeout(() => rejectProbe(attachError), 1500);
              try {
                chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate',
                  { expression: 'void 0', returnByValue: true, timeout: 1000 }, result => {
                    const error = chrome.runtime.lastError;
                    clearTimeout(timer);
                    if (error || result?.exceptionDetails || result?.result?.type !== 'undefined') rejectProbe(attachError);
                    else resolveProbe();
                  });
              } catch (error) { clearTimeout(timer); rejectProbe(error); }
            });
            recovered = true;
          } catch {
            reject(current() ? attachError : new Error('Debugger attachment was cancelled'));
            return;
          }
        }

        const isCurrentGeneration = this.attachGenerations.get(tabId) === generation;

        if (attachPromise.cancelled || !isCurrentGeneration) {
          const pendingAttach = this.attachPromises.get(tabId);
          if (!recovered && !attachPromise.detached && !this.sessions.has(tabId)
              && (!pendingAttach || pendingAttach === attachPromise)) {
            try { chrome.debugger.detach({ tabId }, () => {}); } catch {}
          }
          reject(new Error('Debugger attachment was cancelled'));
          return;
        }

        const session = { tabId, attached: true };
        this.sessions.set(tabId, session);
        resolve(session);
      });
    });
    this.attachPromises.set(tabId, attachPromise);
    try {
      const session = await attachPromise;
      this._resumeDialogHandling(tabId);
      return session;
    } finally {
      if (this.attachPromises.get(tabId) === attachPromise) {
        this.attachPromises.delete(tabId);
      }
    }
  }

  /**
   * Detach debugger from a tab.
   */
  async detach(tabId) {
    this.stopDialogHandling(tabId);
    this.pendingDialogs.delete(tabId);
    if (!this.sessions.has(tabId)) {
      const pendingAttach = this.attachPromises.get(tabId);
      if (!pendingAttach || pendingAttach.cancelled) return;
      try {
        await pendingAttach;
      } catch {
        return;
      }
    }
    await this._disarmProtocolFileChooserGuard(tabId);

    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        this._dropWebMCPSession(tabId, 'Debugger detached');
        this.sessions.delete(tabId);
        this.eventHandlers.delete(tabId);
        this.devDiagnostics.delete(tabId);
        this.runtimeContexts.delete(tabId);
        this.fileChooserGuards.delete(tabId);
        resolve();
      });
    });
  }

  /**
   * Release run-scoped CDP state while preserving a Dev-diagnostics owner.
   *
   * Dev diagnostics intentionally span turns so console and network activity
   * produced between Dev requests remains available. WebMCP, by contrast, is
   * run-scoped and must be closed before a later turn can discover a fresh
   * page-owned catalog.
   */
  async cleanupRun(tabId) {
    this.stopDialogHandling(tabId);
    try { await this.disableWebMCP(tabId); } catch {}
    if (!this.devDiagnostics.has(tabId)) await this.detach(tabId);
  }

  /**
   * Release all CDP state owned by a tab or conversation.
   *
   * Unlike run cleanup, this drains mode-scoped diagnostics as well. The
   * operation is intentionally tab-scoped: cleaning up one page must not
   * detach another page's debugger session.
   */
  async cleanupTab(tabId) {
    // A tab can disappear between these steps. Keep going so a failed protocol
    // shutdown cannot prevent the final debugger detach.
    try { await this.disableDevDiagnostics(tabId); } catch {}
    try { await this.disableWebMCP(tabId); } catch {}
    await this.detach(tabId);
  }

  /** Native dialogs pause renderer commands, so resolve them from the debugger
   * event callback rather than queuing behind the click/evaluate they blocked.
   * Firefox has no equivalent WebExtension API; never patch page JS to fake it.
   *
   * A run's wish to answer dialogs outlives one debugger connection. A run
   * that starts where the debugger cannot attach, such as chrome://extensions,
   * or whose connection drops, is armed again at its next debugger attach and
   * whenever ensureDialogHandling is asked before a navigation, so a page's
   * leave prompt never waits for the person while WebBrain works. Stop, abort,
   * the run's end and the person cancelling the debugger end that wish.
   */
  async startDialogHandling(tabId, { signal, onHandled, timeoutMs = 5000 } = {}) {
    this.stopDialogHandling(tabId);
    if (signal?.aborted) return;
    const intent = { signal, onHandled, timeoutMs };
    intent.onAbort = () => {
      if (this.dialogIntents.get(tabId) === intent) this.stopDialogHandling(tabId);
    };
    this.dialogIntents.set(tabId, intent);
    signal?.addEventListener('abort', intent.onAbort, { once: true });
    return this._armDialogHandling(tabId, intent);
  }

  // Arms the run's dialog handling on the tab's current debugger connection.
  // A failure leaves the run's wish in place for a later connection. Arming
  // during a run waits less than a run's start: a setup that hangs behind an
  // open prompt must not hold every navigation for long.
  _armDialogHandling(tabId, intent, timeoutMs = intent.timeoutMs ?? 5000) {
    this._disarmDialogHandling(tabId, 'replaced');
    if (intent.signal?.aborted || this.dialogIntents.get(tabId) !== intent) return Promise.resolve();
    const owner = { signal: intent.signal, onHandled: intent.onHandled };
    owner.onAbort = () => {
      if (this.dialogRuns.get(tabId) === owner) this.stopDialogHandling(tabId);
    };
    this.dialogRuns.set(tabId, owner);
    owner.signal?.addEventListener('abort', owner.onAbort, { once: true });
    owner.arming = this._armDialogOwner(tabId, owner, timeoutMs);
    return owner.arming;
  }

  async _armDialogOwner(tabId, owner, timeoutMs) {
    let timer;
    const markPendingAttachCancelled = () => {
      const pendingAttach = this.attachPromises.get(tabId);
      if (pendingAttach) {
        pendingAttach.cancelled = true;
        this.attachPromises.delete(tabId);
      }
    };
    const interrupted = new Promise((_, reject) => {
      owner.cancelStartup = (cause = 'stopped') => {
        markPendingAttachCancelled();
        // Only Stop, abort and the run's end stop the run. A connection that
        // dropped, or a newer arming, leaves it running without this setup.
        const error = new Error(cause === 'stopped' ? 'Stopped during browser dialog setup'
          : 'The debugger connection changed during browser dialog setup');
        if (cause === 'stopped') error.name = 'AbortError';
        else error.code = cause === 'dropped' ? 'dialog_connection_dropped' : 'dialog_setup_replaced';
        reject(error);
      };
      timer = setTimeout(() => {
        markPendingAttachCancelled();
        const error = new Error('Browser dialog setup timed out. Dismiss any existing browser dialog and try again.');
        error.code = 'dialog_startup_timeout';
        reject(error);
      }, timeoutMs);
    });
    try {
      await Promise.race([this.attach(tabId), interrupted]);
      if (this.dialogRuns.get(tabId) !== owner) return;
      // Resolve an already-observed dialog before Page.enable, which itself
      // can wait for the paused renderer when Dev retained the connection.
      for (const [sessionId, dialog] of this.pendingDialogs.get(tabId) || []) {
        this._continueJavaScriptDialog(tabId, { tabId, sessionId }, dialog);
      }
      // Page.enable can wait indefinitely behind a pre-existing dialog. Stop
      // must release the run even when Chrome never answers this command.
      await Promise.race([this.sendCommand(tabId, 'Page.enable'), interrupted]);
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      markPendingAttachCancelled();
      if (this.dialogRuns.get(tabId) === owner) this._disarmDialogHandling(tabId);
      throw error;
    } finally {
      clearTimeout(timer);
      delete owner.cancelStartup;
    }
  }

  /**
   * Makes sure the run's dialog handling is armed on this tab before an
   * action that can raise a dialog, such as a navigation that may meet a
   * leave prompt. Resolves whether it is armed; never throws, so a page the
   * debugger cannot reach still navigates.
   */
  async ensureDialogHandling(tabId, { timeoutMs = 1500 } = {}) {
    const intent = this.dialogIntents.get(tabId);
    if (!intent || intent.signal?.aborted) return false;
    const owner = this.dialogRuns.get(tabId);
    try {
      if (owner) await owner.arming;
      else await this._armDialogHandling(tabId, intent, timeoutMs);
    } catch {}
    return this.dialogIntents.get(tabId) === intent && this.dialogRuns.has(tabId);
  }

  // A fresh debugger connection resumes the dialog handling its run could not
  // arm at its start, or that a dropped connection ended.
  _resumeDialogHandling(tabId) {
    const intent = this.dialogIntents.get(tabId);
    if (!intent || intent.signal?.aborted || this.dialogRuns.has(tabId)) return;
    this._armDialogHandling(tabId, intent, 1500).catch(() => {});
  }

  stopDialogHandling(tabId) {
    const intent = this.dialogIntents.get(tabId);
    intent?.signal?.removeEventListener('abort', intent.onAbort);
    this.dialogIntents.delete(tabId);
    this._disarmDialogHandling(tabId);
  }

  _disarmDialogHandling(tabId, cause = 'stopped') {
    const owner = this.dialogRuns.get(tabId);
    owner?.navigation?.release();
    owner?.cancelStartup?.(cause);
    owner?.signal?.removeEventListener('abort', owner.onAbort);
    this.dialogRuns.delete(tabId);
  }

  // Only the navigation dispatch path may grant a one-use Leave decision.
  // A click in flight is not proof that a confirm/prompt came from that click.
  authorizeNavigationDialog(tabId, sourceUrl, signal) {
    const owner = this.dialogRuns.get(tabId);
    if (!owner || owner.signal?.aborted || signal?.aborted || !sourceUrl
        || this.pendingDialogs.get(tabId)?.size) return () => {};
    owner.navigation?.release();
    const permit = { sourceUrl };
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', release);
      if (owner.navigation === permit) delete owner.navigation;
    };
    const timer = setTimeout(release, 10000);
    permit.release = release;
    owner.navigation = permit;
    signal?.addEventListener('abort', release, { once: true });
    return release;
  }

  _continueJavaScriptDialog(tabId, source, params = {}) {
    const owner = this.dialogRuns.get(tabId);
    if (!owner || owner.signal?.aborted || params.handling) return;
    if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(params.type)) return;
    params.handling = true;
    const navigation = owner.navigation;
    const allowLeave = params.type === 'beforeunload' && navigation
      && params.navigation === navigation && params.url === navigation.sourceUrl
      && !source?.sessionId;
    if (allowLeave) navigation.release();
    // Alerts have no confirmation branch. Everything else fails closed unless
    // it belongs to the current, explicitly dispatched top-level navigation.
    const response = { accept: params.type === 'alert' || !!allowLeave };
    void this.sendCommand(tabId, 'Page.handleJavaScriptDialog', response, source?.sessionId || '')
      .then(() => {
        if (this.dialogRuns.get(tabId) !== owner) return;
        try { owner.onHandled?.(params.type); } catch {}
      })
      .catch(() => {
        // The user may have already closed it, navigated, or detached. Do not
        // retry: a retry could answer a different dialog opened immediately after.
      });
  }

  /**
   * Send a CDP command and get the result.
   */
  async sendCommand(tabId, method, params = {}, sessionId = '', { beforeSend = null } = {}) {
    try {
      await this._beforeCommand(tabId, method, params, sessionId);
      // Last synchronous point before the command can reach the page. Callers
      // record dispatch (and recheck cancellation) only after the fence passed.
      if (typeof beforeSend === 'function') beforeSend();
    } catch (error) {
      if (error && typeof error === 'object') COMMAND_NOT_SENT_ERRORS.add(error);
      throw error;
    }

    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId, ...(sessionId ? { sessionId } : {}) },
        method,
        params,
        (result) => {
          // Chrome extension APIs expose callback failures through
          // chrome.runtime.lastError, not a second callback argument. Read it
          // synchronously while the callback is active; Chrome clears it after
          // the callback returns.
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message || String(error)));
            return;
          }
          resolve(result);
        },
      );
    });
  }

  async _beforeCommand(tabId, method, params, sessionId) {
    if (!this.sessions.has(tabId)) {
      throw new Error(`Not attached to tab ${tabId}`);
    }

    if (['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText'].includes(method)) {
      const release = ['mouseReleased', 'keyUp'].includes(params.type);
      let target = {};
      try { target = await this._pageAgentInputTarget(tabId, method, params, sessionId); }
      catch (error) { if (!release) throw error; } // Always allow held input to be released after navigation.
      await beforePageAgentDispatch(globalThis.chrome, tabId, {
        kind: method === 'Input.dispatchMouseEvent' ? (params.type === 'mouseWheel' ? 'scroll' : 'click') : 'input',
        nativeWheel: params.type === 'mouseWheel',
        navigationCandidate: params.type === 'mousePressed',
        ...(Number.isFinite(params.x) ? { x: params.x, y: params.y } : {}),
        // The monitor recognizes a typing action's own focus press by these.
        ...(method === 'Input.dispatchMouseEvent' ? { pointerButton: params.button, clickCount: params.clickCount } : {}),
        // Native input always tries to mark its receiver (nativeTarget).
        nativeInput: true,
        release,
        ...(method === 'Input.insertText' ? { eventTypes: ['beforeinput', 'input', 'change'] } : {}),
        ...(method === 'Input.dispatchMouseEvent' ? { eventTypes: params.type === 'mouseMoved'
          ? ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']
          : params.type === 'mousePressed' ? ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'click', 'input', 'change']
            : params.type === 'mouseWheel' ? ['wheel'] : ['pointerup', 'mouseup', 'click', 'input', 'change'] } : {}),
        ...target,
        // Derive preparation from the actual command, never caller metadata.
        // Held-button movement is consequential drag/recovery input.
        pointerPreparationOnly: method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved'
          && params.button === 'none' && params.buttons === 0,
      });
    }
  }

  async _pageAgentObjectTarget(tabId, objectId, sessionId = '') {
    const nativeTarget = globalThis.crypto.randomUUID();
    const typing = ['type_ax', 'set_field', 'type_text'].includes(pageAgentDispatchTool(tabId));
    const result = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: `function (marker, typing) {
        const fence = this.ownerDocument?.documentElement?.getAttribute('data-webbrain-page-revision');
        if (!fence || !this.isConnected) return null;
        // Pointer hit testing can return a paragraph inside an editor. Native
        // typing belongs to its actual editing host; the monitor still checks
        // that exact host against the original private action certificate.
        let target = this;
        if (typing && target.isContentEditable) {
          let host = target;
          for (let parent = host.parentElement; parent?.isContentEditable; parent = parent.parentElement) host = parent;
          const activation = target.closest('button,a[href],input,textarea,select,summary,[onclick],[tabindex],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"]');
          // An activator inside the editor remains its own receiving node;
          // typing cannot certify a click on that descendant through the host.
          if (!activation || activation === host || !host.contains(activation)) target = host;
        }
        target.setAttribute('data-webbrain-native-target', marker);
        const split = fence.lastIndexOf(':');
        return { nativeTarget: marker, documentToken: fence.slice(0, split), documentRevision: Number(fence.slice(split + 1)) };
      }`,
      arguments: [{ value: nativeTarget }, { value: typing }],
    }, sessionId);
    return result?.result?.value || {};
  }

  async _pageAgentInputTarget(tabId, method, params, sessionId = '') {
    if (!hasPageAgentDispatchOwner(tabId)) return {};
    const keyboard = method !== 'Input.dispatchMouseEvent';
    let x = params.x, y = params.y, currentSession = sessionId;
    let contextId;
    const temporarySessions = [];
    try {
      // A process-isolated iframe is returned as its owner node. Descend into
      // that target rather than registering the parent document's expectation.
      for (let depth = 0; depth < 16; depth++) {
        let objectId, node;
        if (keyboard) {
          // Use the target tab's focused document even when another tab is active.
          const focused = await this.sendCommand(tabId, 'Runtime.evaluate', {
            expression: '(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el; })()',
            ...(contextId ? { contextId } : {}),
          }, currentSession);
          objectId = focused?.result?.objectId;
          if (!objectId) return {};
          ({ node } = await this.sendCommand(tabId, 'DOM.describeNode', { objectId }, currentSession));
        } else {
          // Input uses viewport coordinates; DOM hit testing uses document
          // coordinates. Resolve the receiving document's current offsets,
          // including after an owned preparation scroll and inside an OOPIF.
          const offset = await this.sendCommand(tabId, 'Runtime.evaluate', {
            expression: '({ x: window.scrollX, y: window.scrollY })', returnByValue: true,
            ...(contextId ? { contextId } : {}),
          }, currentSession);
          const scroll = offset?.result?.value;
          if (!Number.isFinite(scroll?.x) || !Number.isFinite(scroll?.y)) throw new Error('Cannot resolve native input document coordinates');
          const hit = await this.sendCommand(tabId, 'DOM.getNodeForLocation', { x: Math.round(x + scroll.x), y: Math.round(y + scroll.y) }, currentSession);
          ({ node } = await this.sendCommand(tabId, 'DOM.describeNode', { backendNodeId: hit.backendNodeId }, currentSession));
          const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId }, currentSession);
          objectId = resolved.object.objectId;
        }
        if (node?.frameId && /^(IFRAME|FRAME)$/.test(node.nodeName)) {
          let size;
          let quads;
          try {
            if (!keyboard) {
              ({ quads } = await this.sendCommand(tabId, 'DOM.getContentQuads', { objectId }, currentSession));
              size = (await this.sendCommand(tabId, 'Runtime.callFunctionOn', { objectId,
                functionDeclaration: 'function () { return { width: this.clientWidth, height: this.clientHeight }; }', returnByValue: true }, currentSession))?.result?.value;
            }
          } finally { this.releaseObject(tabId, objectId, currentSession); }
          if (!keyboard) {
            const q = quads?.[0];
            if (!q || !size?.width || !size?.height) throw new Error('Cannot resolve native input frame');
            const ax = q[2] - q[0], ay = q[3] - q[1], bx = q[6] - q[0], by = q[7] - q[1];
            const determinant = ax * by - ay * bx, dx = x - q[0], dy = y - q[1];
            if (!determinant) throw new Error('Cannot resolve native input frame');
            x = (dx * by - dy * bx) / determinant * size.width;
            y = (ax * dy - ay * dx) / determinant * size.height;
          } else {
            try {
              ({ executionContextId: contextId } = await this.sendCommand(tabId, 'Page.createIsolatedWorld', { frameId: node.frameId, worldName: 'webbrain-input-attribution' }, currentSession));
              continue;
            } catch { /* A process-isolated document requires its child session. */ }
          }
          const existing = [...(this.runtimeContexts.get(tabId)?.values() || [])].find(context => context.frameId === node.frameId && context.sessionId);
          if (existing) currentSession = existing.sessionId;
          else {
            const attached = await this.sendCommand(tabId, 'Target.attachToTarget', { targetId: node.frameId, flatten: true });
            currentSession = attached.sessionId; temporarySessions.push(currentSession);
          }
          contextId = undefined;
          continue;
        }
        try { return await this._pageAgentObjectTarget(tabId, objectId, currentSession); }
        finally { this.releaseObject(tabId, objectId, currentSession); }
      }
      throw new Error('Native input frame nesting exceeds the monitor limit');
    } finally {
      for (const id of temporarySessions.reverse()) {
        try { await this.sendCommand(tabId, 'Target.detachFromTarget', { sessionId: id }); } catch {}
      }
    }
  }

  /**
   * The node native input would reach now, marked for its document's page
   * monitor exactly as each input command marks its receiver
   * (_pageAgentInputTarget): the one under a viewport point, or with
   * `focused` the one holding keyboard focus. Page feedback prepares a vision
   * action in that document when it is an embedded frame's
   * (page-feedback.js prepareReceiverFrame). Returns { nativeTarget,
   * documentToken, documentRevision }, or {} with no monitored receiver.
   */
  async markPageAgentInputReceiver(tabId, target = {}) {
    const focused = target.focused === true;
    const x = Number(target.x), y = Number(target.y);
    if (!focused && (!Number.isFinite(x) || !Number.isFinite(y))) return {};
    await this.attach(tabId);
    return this._pageAgentInputTarget(tabId, focused ? 'Input.insertText' : 'Input.dispatchMouseEvent', focused ? {} : { x, y });
  }

  /**
   * The document native input reaches: the one under a viewport point (a
   * coordinate click) or the one holding keyboard focus (type_text without a
   * selector, press_keys). Chrome delivers that input into embedded frames,
   * process-isolated cross-origin ones included, so the permission gate
   * charges this document's site rather than the top-level page's. The walk
   * follows _pageAgentInputTarget, but focus, scroll offsets and the frame's
   * origin are read in an isolated world, where the page cannot redefine
   * activeElement, scrollX or origin. Returns { topDocument: true } for the
   * tab's own document, else { topDocument: false, url } with url '' when the
   * frame has no web origin (a sandboxed or data: document). Throws when the
   * receiving document cannot be established.
   */
  async resolveInputFrame(tabId, target = {}) {
    const keyboard = target.focused === true;
    let x = Number(target.x), y = Number(target.y);
    if (!keyboard && (!Number.isFinite(x) || !Number.isFinite(y))) throw new Error('Input point is not a number');
    await this.attach(tabId);
    let sessionId = '';
    const temporarySessions = [];
    const isolatedContext = async frameId => (await this.sendCommand(tabId, 'Page.createIsolatedWorld',
      { frameId, worldName: 'webbrain-input-frame' }, sessionId)).executionContextId;
    try {
      for (let depth = 0; depth < 16; depth++) {
        const tree = await this.getAllFrames(tabId, sessionId);
        const frames = new Map(tree.map(frame => [String(frame.id), frame]));
        const rootFrameId = String(tree[0]?.id || '');
        if (!rootFrameId) throw new Error('Cannot read the input frame tree');
        let frameId = rootFrameId;
        let contextId = await isolatedContext(frameId);
        let contextFrameId = frameId;
        // A process-isolated child, entered through its own session next.
        let remoteFrameId = '';
        if (keyboard) {
          for (let local = 0; local < 16; local++) {
            const focused = await this.sendCommand(tabId, 'Runtime.evaluate', {
              expression: '(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el; })()',
              contextId,
            }, sessionId);
            const objectId = focused?.result?.objectId;
            if (!objectId) break;
            let node;
            try { ({ node } = await this.sendCommand(tabId, 'DOM.describeNode', { objectId }, sessionId)); }
            finally { this.releaseObject(tabId, objectId, sessionId); }
            // Focus inside a frame shows in its parent as the frame element;
            // <object> and <embed> can host a cross-origin document too.
            if (!node?.frameId || !/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(node.nodeName)) break;
            if (!frames.has(String(node.frameId))) { remoteFrameId = String(node.frameId); break; }
            frameId = String(node.frameId);
            contextId = await isolatedContext(frameId);
            contextFrameId = frameId;
          }
        } else {
          const offset = await this.sendCommand(tabId, 'Runtime.evaluate', {
            expression: '({ x: scrollX, y: scrollY })', returnByValue: true, contextId,
          }, sessionId);
          const scroll = offset?.result?.value;
          if (!Number.isFinite(scroll?.x) || !Number.isFinite(scroll?.y)) throw new Error('Cannot resolve input document coordinates');
          const hit = await this.sendCommand(tabId, 'DOM.getNodeForLocation', { x: Math.round(x + scroll.x), y: Math.round(y + scroll.y) }, sessionId);
          frameId = String(hit?.frameId || rootFrameId);
          const { node } = await this.sendCommand(tabId, 'DOM.describeNode', { backendNodeId: hit.backendNodeId }, sessionId);
          // The hit test already enters same-process frames, so a frame element
          // here is a process-isolated frame (or the point is on a frame's
          // border); either way the frame is taken as the receiver.
          if (node?.frameId && /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(node.nodeName)) {
            if (frames.has(String(node.frameId))) frameId = String(node.frameId);
            else {
              remoteFrameId = String(node.frameId);
              const owner = await this.sendCommand(tabId, 'DOM.resolveNode', {
                backendNodeId: hit.backendNodeId,
                executionContextId: frameId === rootFrameId ? contextId : await isolatedContext(frameId),
              }, sessionId);
              let quads, size;
              try {
                ({ quads } = await this.sendCommand(tabId, 'DOM.getContentQuads', { backendNodeId: hit.backendNodeId }, sessionId));
                size = (await this.sendCommand(tabId, 'Runtime.callFunctionOn', { objectId: owner.object.objectId,
                  functionDeclaration: 'function () { return { width: this.clientWidth, height: this.clientHeight }; }', returnByValue: true }, sessionId))?.result?.value;
              } finally { this.releaseObject(tabId, owner?.object?.objectId, sessionId); }
              const q = quads?.[0];
              if (!q || !size?.width || !size?.height) throw new Error('Cannot resolve the input frame');
              const ax = q[2] - q[0], ay = q[3] - q[1], bx = q[6] - q[0], by = q[7] - q[1];
              const determinant = ax * by - ay * bx, dx = x - q[0], dy = y - q[1];
              if (!determinant) throw new Error('Cannot resolve the input frame');
              x = (dx * by - dy * bx) / determinant * size.width;
              y = (ax * dy - ay * dx) / determinant * size.height;
            }
          }
        }
        if (remoteFrameId) {
          const existing = [...(this.runtimeContexts.get(tabId)?.values() || [])].find(context => context.frameId === remoteFrameId && context.sessionId);
          if (existing) sessionId = existing.sessionId;
          else {
            const attached = await this.sendCommand(tabId, 'Target.attachToTarget', { targetId: remoteFrameId, flatten: true });
            sessionId = attached.sessionId; temporarySessions.push(sessionId);
          }
          continue;
        }
        if (!sessionId && frameId === rootFrameId) return { topDocument: true };
        const frame = frames.get(frameId);
        if (!frame) throw new Error('The input frame is not in the frame tree');
        // The frame tree derives securityOrigin from the URL, which hides the
        // origin an about:blank or srcdoc document inherits and the opaque
        // origin of a sandboxed one; the document's own origin decides.
        const origin = await this.sendCommand(tabId, 'Runtime.evaluate', {
          expression: 'self.origin', returnByValue: true,
          contextId: contextFrameId === frameId ? contextId : await isolatedContext(frameId),
        }, sessionId);
        return { topDocument: false, url: this._webMCPSafeFrameUrl({ url: frame.url, securityOrigin: String(origin?.result?.value || 'null') }) };
      }
      throw new Error('Input frame nesting exceeds the limit');
    } finally {
      for (const id of temporarySessions.reverse()) {
        try { await this.sendCommand(tabId, 'Target.detachFromTarget', { sessionId: id }); } catch {}
      }
    }
  }

  /**
   * Register an event handler.
   */
  on(tabId, event, handler) {
    if (!this.eventHandlers.has(tabId)) {
      this.eventHandlers.set(tabId, {});
    }
    const handlers = this.eventHandlers.get(tabId);
    if (!handlers[event]) {
      handlers[event] = [];
    }
    handlers[event].push(handler);
    return handler;
  }

  off(tabId, event, handler) {
    const handlers = this.eventHandlers.get(tabId);
    const list = handlers?.[event];
    if (!list) return false;
    const index = list.indexOf(handler);
    if (index === -1) return false;
    list.splice(index, 1);
    if (list.length === 0) delete handlers[event];
    if (Object.keys(handlers).length === 0) this.eventHandlers.delete(tabId);
    return true;
  }

  _sanitizeWebMCPValue(value, depth = 0, seen = new WeakSet(), budget = { nodes: 0, chars: 0 }) {
    if (budget.nodes >= WEBMCP_MAX_VALUE_NODES || budget.chars >= WEBMCP_MAX_VALUE_CHARS) {
      return '[value budget exhausted]';
    }
    budget.nodes++;
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const limit = Math.max(0, Math.min(2000, WEBMCP_MAX_VALUE_CHARS - budget.chars));
      const text = value.slice(0, limit);
      budget.chars += text.length;
      return text;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'object') return String(value).slice(0, 2000);
    if (depth >= 8) return '[nested value truncated]';
    if (seen.has(value)) return '[circular value omitted]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 50).map(item => this._sanitizeWebMCPValue(item, depth + 1, seen, budget));
    }
    const out = {};
    let count = 0;
    for (const [rawKey, item] of Object.entries(value)) {
      if (count >= 50) break;
      const key = String(rawKey).slice(0, 120);
      if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
      budget.chars += key.length;
      out[key] = this._sanitizeWebMCPValue(item, depth + 1, seen, budget);
      count++;
    }
    return out;
  }

  _webMCPToolKey(frameId, name) {
    return `${String(frameId || '').slice(0, 300)}\u0000${String(name || '').slice(0, 300)}`;
  }

  _webMCPInvocationKey(sessionId, invocationId) {
    return `${String(sessionId || '').slice(0, 300)}\u0000${String(invocationId || '').slice(0, 300)}`;
  }

  _runtimeContextKey(sessionId, contextId) {
    return `${String(sessionId || '').slice(0, 300)}\u0000${String(contextId ?? '').slice(0, 100)}`;
  }

  _trackRuntimeContextEvent(tabId, source = {}, method = '', params = {}) {
    const sessionId = String(source.sessionId || '');
    let contexts = this.runtimeContexts.get(tabId);
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      const frameId = String(context?.auxData?.frameId || '');
      if (!context?.auxData?.isDefault || !frameId || context.id == null) return;
      if (!contexts) {
        contexts = new Map();
        this.runtimeContexts.set(tabId, contexts);
      }
      contexts.set(this._runtimeContextKey(sessionId, context.id), {
        contextId: context.id,
        frameId,
        sessionId,
      });
      return;
    }
    if (!contexts) return;
    if (method === 'Runtime.executionContextDestroyed') {
      contexts.delete(this._runtimeContextKey(sessionId, params.executionContextId));
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const [key, context] of contexts) {
        if (context.sessionId === sessionId) contexts.delete(key);
      }
    } else if (method === 'Target.detachedFromTarget') {
      const detachedSessionId = String(params.sessionId || '');
      for (const [key, context] of contexts) {
        if (context.sessionId === detachedSessionId) contexts.delete(key);
      }
    }
    if (!contexts.size) this.runtimeContexts.delete(tabId);
  }

  _newWebMCPSession(tabId) {
    // Conversation history can retain an opaque tool ID after this registry is
    // torn down. Give every registry generation its own random namespace so a
    // stale ID can never alias whichever page tool registers first next time.
    const toolIdPrefix = globalThis.crypto.randomUUID().replace(/-/g, '');
    return {
      tabId,
      closed: false,
      enabled: false,
      enablingPromise: null,
      toolIdPrefix,
      nextToolId: 1,
      toolsById: new Map(),
      idsByKey: new Map(),
      // Per tool-key generation bumped on store and remove. Discovery snapshots
      // this map so a stale Runtime.evaluate result cannot resurrect or
      // overwrite a concurrent registration change.
      toolMutationGens: new Map(),
      // Per-frame generation bumped on navigate/detach/session cleanup so
      // discovery cannot insert tools for a document that already left.
      frameMutationGens: new Map(),
      // Session-wide epoch bumped on main-target root navigation so in-flight
      // discovery cannot reinsert tools for frames that never had a gen entry.
      discoveryEpoch: 0,
      pendingInvocations: new Map(),
      completedResponses: new Map(),
      childSessions: new Map(),
      childEnablePromises: new Set(),
      discoveryContextsUsed: 0,
      discoveryInFlight: 0,
      discoveryWaiters: [],
      handlers: [],
    };
  }

  _webMCPToolMutationGen(state, key) {
    return state.toolMutationGens.get(key) || 0;
  }

  _bumpWebMCPToolMutation(state, key) {
    const next = this._webMCPToolMutationGen(state, key) + 1;
    state.toolMutationGens.set(key, next);
    return next;
  }

  _webMCPFrameMutationGen(state, frameId) {
    return state.frameMutationGens.get(String(frameId || '')) || 0;
  }

  _bumpWebMCPFrameMutation(state, frameId) {
    const key = String(frameId || '');
    if (!key) return 0;
    const next = this._webMCPFrameMutationGen(state, key) + 1;
    state.frameMutationGens.set(key, next);
    return next;
  }

  _bumpWebMCPDiscoveryEpoch(state) {
    state.discoveryEpoch = (state.discoveryEpoch || 0) + 1;
    return state.discoveryEpoch;
  }

  /**
   * Drop mutation gens that no longer back a live tool/frame after a catalog
   * wipe. Safe only once discoveryEpoch has already invalidated in-flight
   * discovery (clearing gens alone would reset them to 0 and re-admit stale
   * snapshots).
   */
  _pruneWebMCPMutationMaps(state) {
    const liveToolKeys = new Set(state.idsByKey.keys());
    for (const key of state.toolMutationGens.keys()) {
      if (!liveToolKeys.has(key)) state.toolMutationGens.delete(key);
    }
    const liveFrameIds = new Set();
    for (const tool of state.toolsById.values()) {
      if (tool.frameId) liveFrameIds.add(tool.frameId);
    }
    for (const child of state.childSessions.values()) {
      for (const frameId of child.frameIds) liveFrameIds.add(frameId);
    }
    for (const frameId of state.frameMutationGens.keys()) {
      if (!liveFrameIds.has(frameId)) state.frameMutationGens.delete(frameId);
    }
  }

  /**
   * Main-document navigation: wipe the catalog, invalidate in-flight discovery,
   * and tear down OOPIF child sessions so late toolsAdded/discovery cannot
   * repopulate tools from the previous page.
   */
  _handleWebMCPMainRootNavigation(tabId, state, rootFrameId) {
    this._bumpWebMCPDiscoveryEpoch(state);
    // Bump every frame gen we already know about, plus main-session runtime
    // contexts discovery may still be evaluating (including never-registered
    // frames whose gen is still the default 0).
    for (const frameId of [...state.frameMutationGens.keys()]) {
      this._bumpWebMCPFrameMutation(state, frameId);
    }
    for (const context of this.runtimeContexts.get(tabId)?.values() || []) {
      if (context.sessionId) continue;
      this._bumpWebMCPFrameMutation(state, context.frameId);
    }
    if (rootFrameId) this._bumpWebMCPFrameMutation(state, rootFrameId);

    const childSessionIds = [...state.childSessions.keys()];
    const affectedSessionIds = ['', ...childSessionIds];
    for (const affectedSessionId of affectedSessionIds) {
      this._removeWebMCPSessionTools(state, affectedSessionId);
      this._finishWebMCPSessionInvocations(
        state,
        affectedSessionId,
        'The WebMCP document navigated before Chrome reported the invocation outcome.',
      );
    }

    // Drop children from the map first so store/discovery fail closed, then
    // best-effort tear down their CDP sessions (disable + autoAttach off).
    for (const childSessionId of childSessionIds) {
      state.childSessions.delete(childSessionId);
      this._teardownWebMCPChildSession(tabId, childSessionId).catch(() => {});
    }

    state.discoveryContextsUsed = 0;
    this._pruneWebMCPMutationMaps(state);
  }

  async _acquireWebMCPDiscoverySlot(state) {
    if (state.discoveryInFlight < WEBMCP_MAX_DISCOVERY_CONCURRENCY) {
      state.discoveryInFlight++;
      return;
    }
    await new Promise(resolve => state.discoveryWaiters.push(resolve));
    state.discoveryInFlight++;
  }

  _releaseWebMCPDiscoverySlot(state) {
    state.discoveryInFlight = Math.max(0, state.discoveryInFlight - 1);
    const next = state.discoveryWaiters.shift();
    if (next) next();
  }

  async _teardownWebMCPChildSession(tabId, sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return;
    await Promise.allSettled([
      this.sendCommand(tabId, 'Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }, sid),
      this.sendCommand(tabId, 'WebMCP.disable', {}, sid),
    ]);
  }

  _dropWebMCPSession(tabId, reason = 'WebMCP session closed') {
    const state = this.webMcpSessions.get(tabId);
    if (!state) return;
    state.closed = true;
    for (const pending of state.pendingInvocations.values()) {
      try { pending.finish({
        success: false,
        dispatched: true,
        cancelled: true,
        outcomeUnknown: true,
        error: reason,
      }); } catch {}
    }
    this.webMcpSessions.delete(tabId);
  }

  _removeWebMCPHandlers(tabId, state) {
    for (const { event, handler } of state?.handlers || []) {
      this.off(tabId, event, handler);
    }
    if (state) state.handlers = [];
  }

  _storeWebMCPTools(state, tools, sessionId = '', options = {}) {
    const owningSessionId = String(sessionId || '');
    // Child-session tools must not re-enter the catalog after detach.
    if (owningSessionId && !state.childSessions.has(owningSessionId)) return;
    // Root navigation bumps discoveryEpoch; drop snapshots captured earlier.
    if (
      options.discoveryEpoch != null
      && options.discoveryEpoch !== state.discoveryEpoch
    ) {
      return;
    }
    const mutationGuard = options.mutationGuard instanceof Map ? options.mutationGuard : null;
    const frameMutationGuard = options.frameMutationGuard instanceof Map
      ? options.frameMutationGuard
      : null;
    for (const rawTool of Array.isArray(tools) ? tools : []) {
      const name = String(rawTool?.name || '').trim().slice(0, 300);
      const frameId = String(rawTool?.frameId || '').trim().slice(0, 300);
      if (!name || !frameId) continue;
      const key = this._webMCPToolKey(frameId, name);
      // Drop discovery results whose key was stored or removed while evaluate
      // was pending; otherwise a stale snapshot can resurrect a deleted tool
      // or overwrite a fresher re-registration.
      if (mutationGuard) {
        const expectedGen = mutationGuard.get(key) || 0;
        if (this._webMCPToolMutationGen(state, key) !== expectedGen) continue;
      }
      // Frame-level guard covers keys that never existed yet: navigate/detach
      // bumps the frame gen even when toolsById had nothing to remove.
      if (frameMutationGuard) {
        const expectedFrameGen = frameMutationGuard.get(frameId) || 0;
        if (this._webMCPFrameMutationGen(state, frameId) !== expectedFrameGen) continue;
      }
      let toolId = state.idsByKey.get(key);
      if (!toolId) {
        if (state.toolsById.size >= WEBMCP_MAX_REGISTERED_TOOLS) continue;
        toolId = `wmcp_${state.toolIdPrefix}${state.nextToolId.toString(36)}`;
        state.nextToolId++;
        state.idsByKey.set(key, toolId);
      }
      const annotations = rawTool?.annotations && typeof rawTool.annotations === 'object'
        ? {
          readOnly: rawTool.annotations.readOnly === true,
          untrustedContent: rawTool.annotations.untrustedContent === true,
          autosubmit: rawTool.annotations.autosubmit === true,
        }
        : { readOnly: false, untrustedContent: false, autosubmit: false };
      const sanitizedSchema = this._sanitizeWebMCPValue(rawTool?.inputSchema || {
        type: 'object', properties: {}, required: [],
      });
      this._bumpWebMCPToolMutation(state, key);
      state.toolsById.set(toolId, {
        toolId,
        name,
        description: String(rawTool?.description || '').slice(0, 1000),
        inputSchema: sanitizedSchema && typeof sanitizedSchema === 'object' && !Array.isArray(sanitizedSchema)
          ? sanitizedSchema
          : { type: 'object', properties: {}, required: [] },
        annotations,
        frameId,
        sessionId: owningSessionId,
      });
      state.childSessions.get(owningSessionId)?.frameIds.add(frameId);
    }
  }

  _removeWebMCPTools(state, tools, sessionId = '') {
    const owningSessionId = String(sessionId || '');
    for (const rawTool of Array.isArray(tools) ? tools : []) {
      const key = this._webMCPToolKey(rawTool?.frameId, rawTool?.name);
      const toolId = state.idsByKey.get(key);
      if (!toolId) continue;
      if (state.toolsById.get(toolId)?.sessionId !== owningSessionId) continue;
      this._bumpWebMCPToolMutation(state, key);
      state.idsByKey.delete(key);
      state.toolsById.delete(toolId);
    }
  }

  _removeWebMCPFrameTools(state, frameId) {
    const targetFrameId = String(frameId || '');
    if (!targetFrameId) return 0;
    // Always bump even when no tools were registered so discovery cannot insert
    // a pre-navigate snapshot for this frame id.
    this._bumpWebMCPFrameMutation(state, targetFrameId);
    let removed = 0;
    for (const [toolId, tool] of state.toolsById) {
      if (tool.frameId !== targetFrameId) continue;
      const key = this._webMCPToolKey(tool.frameId, tool.name);
      this._bumpWebMCPToolMutation(state, key);
      state.toolsById.delete(toolId);
      state.idsByKey.delete(key);
      removed++;
    }
    return removed;
  }

  _removeWebMCPSessionTools(state, sessionId = '') {
    const targetSessionId = String(sessionId || '');
    let removed = 0;
    for (const [toolId, tool] of state.toolsById) {
      if (tool.sessionId !== targetSessionId) continue;
      const key = this._webMCPToolKey(tool.frameId, tool.name);
      this._bumpWebMCPToolMutation(state, key);
      this._bumpWebMCPFrameMutation(state, tool.frameId);
      state.toolsById.delete(toolId);
      state.idsByKey.delete(key);
      removed++;
    }
    return removed;
  }

  _finishWebMCPSessionInvocations(state, sessionId, reason) {
    const targetSessionId = String(sessionId || '');
    for (const pending of [...state.pendingInvocations.values()]) {
      if (pending.sessionId !== targetSessionId) continue;
      try {
        pending.finish({
          success: false,
          dispatched: true,
          outcomeUnknown: true,
          error: reason,
        });
      } catch {}
    }
  }

  _finishWebMCPFrameInvocations(state, frameId, reason) {
    const targetFrameId = String(frameId || '');
    if (!targetFrameId) return;
    for (const pending of [...state.pendingInvocations.values()]) {
      if (pending.frameId !== targetFrameId) continue;
      try {
        pending.finish({
          success: false,
          dispatched: true,
          outcomeUnknown: true,
          error: reason,
        });
      } catch {}
    }
  }

  _handleWebMCPResponse(state, params = {}, sessionId = '') {
    const invocationId = String(params.invocationId || '');
    if (!invocationId) return;
    const invocationKey = this._webMCPInvocationKey(sessionId, invocationId);
    const pending = state.pendingInvocations.get(invocationKey);
    if (pending) {
      pending.respond(params);
      return;
    }
    state.completedResponses.set(invocationKey, params);
    if (state.completedResponses.size > 20) {
      const oldest = state.completedResponses.keys().next().value;
      state.completedResponses.delete(oldest);
    }
  }

  async _discoverExistingWebMCPFrameTools(tabId, state, sessionId = '') {
    const owningSessionId = String(sessionId || '');
    if (owningSessionId && !state.childSessions.has(owningSessionId)) return 0;
    const contextsByFrame = new Map();
    const onContextCreated = (params = {}, source = {}) => {
      if (String(source.sessionId || '') !== owningSessionId) return;
      const context = params.context;
      const frameId = String(context?.auxData?.frameId || '');
      if (!context?.auxData?.isDefault || !frameId || context.id == null) return;
      contextsByFrame.set(frameId, context.id);
    };
    this.on(tabId, 'Runtime.executionContextCreated', onContextCreated);
    for (const context of this.runtimeContexts.get(tabId)?.values() || []) {
      if (context.sessionId !== owningSessionId) continue;
      contextsByFrame.set(context.frameId, context.contextId);
    }
    try {
      await this.sendCommand(tabId, 'Runtime.enable', {}, owningSessionId);
      // Runtime.enable reports existing contexts asynchronously. Keep this
      // bounded: live registrations are still delivered by WebMCP.toolsAdded.
      await new Promise(resolve => setTimeout(resolve, WEBMCP_DISCOVERY_SETTLE_MS));
    } catch {
      return 0;
    } finally {
      this.off(tabId, 'Runtime.executionContextCreated', onContextCreated);
    }
    if (state.closed || this.webMcpSessions.get(tabId) !== state) return 0;
    if (owningSessionId && !state.childSessions.has(owningSessionId)) return 0;

    const remainingContextBudget = Math.max(
      0,
      WEBMCP_MAX_DISCOVERY_CONTEXTS - state.discoveryContextsUsed,
    );
    const selectedContexts = [...contextsByFrame].slice(0, remainingContextBudget);
    state.discoveryContextsUsed += selectedContexts.length;
    // Capture generations before evaluate so concurrent toolsRemoved /
    // toolsAdded / frame cleanup / root navigation invalidate these results
    // at merge time.
    const discoveryEpoch = state.discoveryEpoch;
    const mutationGuard = new Map(state.toolMutationGens);
    const frameMutationGuard = new Map(state.frameMutationGens);
    const discovered = [];
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(WEBMCP_MAX_DISCOVERY_CONCURRENCY, selectedContexts.length) },
      async () => {
        while (nextIndex < selectedContexts.length) {
          const index = nextIndex;
          nextIndex++;
          const [frameId, contextId] = selectedContexts[index];
          await this._acquireWebMCPDiscoverySlot(state);
          try {
            if (
              state.closed
              || this.webMcpSessions.get(tabId) !== state
              || (owningSessionId && !state.childSessions.has(owningSessionId))
            ) {
              discovered[index] = { status: 'fulfilled', value: [] };
              continue;
            }
            const evaluated = await this.sendCommand(tabId, 'Runtime.evaluate', {
              expression: WEBMCP_CONTEXT_DISCOVERY_EXPRESSION,
              contextId,
              awaitPromise: true,
              returnByValue: true,
              timeout: WEBMCP_CONTEXT_DISCOVERY_TIMEOUT_MS,
            }, owningSessionId);
            if (evaluated?.exceptionDetails) {
              discovered[index] = { status: 'fulfilled', value: [] };
              continue;
            }
            discovered[index] = {
              status: 'fulfilled',
              value: (Array.isArray(evaluated?.result?.value) ? evaluated.result.value : [])
                .map(tool => ({ ...tool, frameId })),
            };
          } catch (reason) {
            discovered[index] = { status: 'rejected', reason };
          } finally {
            this._releaseWebMCPDiscoverySlot(state);
          }
        }
      },
    );
    await Promise.all(workers);
    if (state.closed || this.webMcpSessions.get(tabId) !== state) return 0;
    if (owningSessionId && !state.childSessions.has(owningSessionId)) return 0;
    let count = 0;
    for (const result of discovered) {
      if (!result || result.status !== 'fulfilled') continue;
      this._storeWebMCPTools(state, result.value, owningSessionId, {
        discoveryEpoch,
        mutationGuard,
        frameMutationGuard,
      });
      count += result.value.length;
    }
    return count;
  }

  _enableWebMCPChildSession(tabId, state, params = {}, source = {}) {
    const sessionId = String(params.sessionId || '');
    const targetInfo = params.targetInfo || {};
    if (!sessionId || targetInfo.type !== 'iframe' || state.childSessions.has(sessionId)) return;
    if (state.closed || this.webMcpSessions.get(tabId) !== state) {
      this.sendCommand(
        tabId,
        'Target.detachFromTarget',
        { sessionId },
        source.sessionId,
      ).catch(() => {});
      return;
    }
    if (state.childSessions.size >= WEBMCP_MAX_CHILD_SESSIONS) {
      this.sendCommand(
        tabId,
        'Target.detachFromTarget',
        { sessionId },
        source.sessionId,
      ).catch(() => {});
      return;
    }
    const child = {
      sessionId,
      targetId: String(targetInfo.targetId || ''),
      url: String(targetInfo.url || ''),
      frameIds: new Set(),
    };
    state.childSessions.set(sessionId, child);
    const childStillOwned = () => (
      !state.closed
      && this.webMcpSessions.get(tabId) === state
      && state.childSessions.has(sessionId)
    );
    const enabling = (async () => {
      // Enable domains one at a time so a concurrent disableWebMCP can abort
      // before setAutoAttach(true) re-arms a session we already tore down.
      const steps = [
        ['WebMCP.enable', {}],
        ['Page.enable', {}],
        // Auto-attach is not recursive. Arm each OOPIF session so nested
        // cross-process frames join the same WebMCP catalog as well.
        ['Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: WEBMCP_IFRAME_TARGET_FILTER,
        }],
      ];
      for (const [method, commandParams] of steps) {
        if (!childStillOwned()) {
          await this._teardownWebMCPChildSession(tabId, sessionId);
          return;
        }
        try {
          await this.sendCommand(tabId, method, commandParams, sessionId);
        } catch {
          // WebMCP.enable is required to dispatch invoke/cancel. Page.enable
          // and setAutoAttach remain best-effort on children when unavailable.
          if (method === 'WebMCP.enable') {
            state.childSessions.delete(sessionId);
            await this._teardownWebMCPChildSession(tabId, sessionId);
            this.sendCommand(
              tabId,
              'Target.detachFromTarget',
              { sessionId },
              source.sessionId,
            ).catch(() => {});
            return;
          }
        }
      }
      if (!childStillOwned()) {
        await this._teardownWebMCPChildSession(tabId, sessionId);
        return;
      }
      // WebMCP.enable currently enumerates only the root document of each
      // target. Recover pre-registered tools from same-process descendants of
      // this OOPIF target just as we do for the top-level target.
      await this._discoverExistingWebMCPFrameTools(tabId, state, sessionId);
      if (!childStillOwned()) {
        await this._teardownWebMCPChildSession(tabId, sessionId);
      }
    })().finally(() => state.childEnablePromises.delete(enabling));
    state.childEnablePromises.add(enabling);
  }

  async _enableWebMCPOOPIFTargets(tabId, state) {
    if (state.closed || this.webMcpSessions.get(tabId) !== state) return 0;
    try {
      await this.sendCommand(tabId, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: WEBMCP_IFRAME_TARGET_FILTER,
      });
    } catch {
      return 0;
    }
    if (state.closed || this.webMcpSessions.get(tabId) !== state) {
      if (this.webMcpSessions.get(tabId) === state) {
        await this.sendCommand(tabId, 'Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        }).catch(() => {});
      }
      return 0;
    }
    for (let pass = 0; pass < WEBMCP_MAX_TARGET_ATTACH_PASSES; pass++) {
      if (state.closed || this.webMcpSessions.get(tabId) !== state) break;
      await new Promise(resolve => setTimeout(resolve, WEBMCP_DISCOVERY_SETTLE_MS));
      const pending = [...state.childEnablePromises];
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    return state.childSessions.size;
  }

  /**
   * Enable Chrome's experimental WebMCP CDP domain. Tool descriptions,
   * schemas, and outputs remain page-controlled; callers must keep them on an
   * untrusted-content path before showing them to a model.
   */
  async enableWebMCP(tabId) {
    await this.attach(tabId);
    let state = this.webMcpSessions.get(tabId);
    if (state?.closed) {
      throw new Error('WebMCP session is closing; retry after cleanup completes.');
    }
    if (state?.enabled) return state;
    if (state?.enablingPromise) return await state.enablingPromise;
    if (!state) {
      state = this._newWebMCPSession(tabId);
      this.webMcpSessions.set(tabId, state);
    }

    const register = (event, handler) => {
      this.on(tabId, event, handler);
      state.handlers.push({ event, handler });
    };
    register('WebMCP.toolsAdded', (params, source) => {
      this._storeWebMCPTools(state, params?.tools, source?.sessionId);
    });
    register('WebMCP.toolsRemoved', (params, source) => (
      this._removeWebMCPTools(state, params?.tools, source?.sessionId)
    ));
    register('WebMCP.toolResponded', (params, source) => (
      this._handleWebMCPResponse(state, params, source?.sessionId)
    ));
    register('Target.attachedToTarget', (params, source) => (
      this._enableWebMCPChildSession(tabId, state, params, source)
    ));
    register('Target.detachedFromTarget', params => {
      const sessionId = String(params?.sessionId || '');
      const child = state.childSessions.get(sessionId);
      if (!child) return;
      for (const frameId of child.frameIds) this._bumpWebMCPFrameMutation(state, frameId);
      this._removeWebMCPSessionTools(state, sessionId);
      this._finishWebMCPSessionInvocations(
        state,
        sessionId,
        'The WebMCP frame detached before Chrome reported the invocation outcome.',
      );
      state.childSessions.delete(sessionId);
    });
    register('Target.targetInfoChanged', params => {
      const targetInfo = params?.targetInfo || {};
      const child = [...state.childSessions.values()]
        .find(candidate => candidate.targetId === String(targetInfo.targetId || ''));
      if (child) child.url = String(targetInfo.url || child.url || '');
    });
    register('Page.frameNavigated', (params, source) => {
      const frame = params?.frame || {};
      const frameId = String(frame.id || '');
      if (!frameId) return;
      const sessionId = String(source?.sessionId || '');
      const child = state.childSessions.get(sessionId);
      if (!frame.parentId) {
        if (!sessionId) {
          // Main-document root navigation: invalidate discovery epoch, wipe
          // tools, and tear down OOPIF children so pre-nav sessions cannot
          // repopulate the catalog.
          this._handleWebMCPMainRootNavigation(tabId, state, frameId);
          return;
        }
        // OOPIF document root navigation: clear only that child session's
        // tools/invocations and re-seed its root frame id.
        this._removeWebMCPSessionTools(state, sessionId);
        this._finishWebMCPSessionInvocations(
          state,
          sessionId,
          'The WebMCP document navigated before Chrome reported the invocation outcome.',
        );
        this._bumpWebMCPFrameMutation(state, frameId);
        if (child) {
          child.frameIds.clear();
          child.frameIds.add(frameId);
          child.url = String(frame.url || child.url || '');
        }
        return;
      }
      this._removeWebMCPFrameTools(state, frameId);
      this._finishWebMCPFrameInvocations(
        state,
        frameId,
        'The WebMCP frame navigated before Chrome reported the invocation outcome.',
      );
      child?.frameIds.delete(frameId);
    });
    register('Page.frameDetached', (params, source) => {
      const frameId = String(params?.frameId || '');
      this._removeWebMCPFrameTools(state, frameId);
      this._finishWebMCPFrameInvocations(
        state,
        frameId,
        'The WebMCP frame detached before Chrome reported the invocation outcome.',
      );
      const child = state.childSessions.get(String(source?.sessionId || ''));
      child?.frameIds.delete(frameId);
    });

    state.enablingPromise = (async () => {
      try {
        await this.sendCommand(tabId, 'WebMCP.enable');
        // Page domain is required for frameNavigated/frameDetached on the main
        // target. Fail enable without it so we never mark the session healthy
        // without lifecycle cleanup. Child OOPIF sessions enable Page
        // separately when attached (best-effort there).
        await this.sendCommand(tabId, 'Page.enable');
        if (state.closed || this.webMcpSessions.get(tabId) !== state) {
          if (!this.webMcpSessions.has(tabId)) {
            await this.sendCommand(tabId, 'WebMCP.disable').catch(() => {});
          }
          throw new Error('WebMCP session closed while it was enabling');
        }
        state.enabled = true;
        // The protocol reports the initial catalog through toolsAdded rather
        // than the command result. Give that event one short task turn to land.
        await new Promise(resolve => setTimeout(resolve, WEBMCP_DISCOVERY_SETTLE_MS));
        if (state.closed || this.webMcpSessions.get(tabId) !== state) {
          throw new Error('WebMCP session closed while it was enabling');
        }
        // Chrome currently enumerates only the root frame when WebMCP.enable
        // runs. Query each already-live default execution context through the
        // browser's ModelContext API so tools registered earlier in child
        // frames enter the same opaque, untrusted CDP-backed registry.
        await this._discoverExistingWebMCPFrameTools(tabId, state);
        if (state.closed || this.webMcpSessions.get(tabId) !== state) {
          throw new Error('WebMCP session closed while it was enabling');
        }
        await this._enableWebMCPOOPIFTargets(tabId, state);
        if (state.closed || this.webMcpSessions.get(tabId) !== state) {
          throw new Error('WebMCP session closed while it was enabling');
        }
        return state;
      } catch (error) {
        if (error?.code === 'page_feedback_pending') throw error;
        this._removeWebMCPHandlers(tabId, state);
        if (!state.closed && this.webMcpSessions.get(tabId) === state) {
          this.webMcpSessions.delete(tabId);
        }
        const message = String(error?.message || error || 'unknown CDP error');
        throw new Error(`WebMCP is unavailable in this Chrome/page context: ${message}`);
      } finally {
        state.enablingPromise = null;
      }
    })();
    return await state.enablingPromise;
  }

  async disableWebMCP(tabId) {
    const state = this.webMcpSessions.get(tabId);
    if (!state) return false;
    // Close the state before awaiting protocol cleanup so in-flight discovery
    // and attached-target events cannot re-arm child sessions.
    state.closed = true;
    for (const pending of state.pendingInvocations.values()) {
      this.sendCommand(
        tabId,
        'WebMCP.cancelInvocation',
        { invocationId: pending.invocationId },
        pending.sessionId,
      ).catch(() => {});
    }
    // Drain child-enable work so it observes closed and tears down any
    // setAutoAttach(true) it may have issued after our first cleanup pass.
    await Promise.allSettled([...state.childEnablePromises]);
    if (this.sessions.has(tabId)) {
      const disableChild = sessionId => this._teardownWebMCPChildSession(tabId, sessionId);
      await Promise.allSettled([...state.childSessions.keys()].map(disableChild));
      // A late-finishing enable may re-insert itself into childSessions briefly;
      // wait again and disable anything still tracked.
      await Promise.allSettled([...state.childEnablePromises]);
      await Promise.allSettled([...state.childSessions.keys()].map(disableChild));
      await this.sendCommand(tabId, 'Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => {});
      if (state.enabled) {
        await this.sendCommand(tabId, 'WebMCP.disable').catch(() => {});
      }
    }
    // Unblock any discovery workers still waiting on the concurrency gate.
    for (const waiter of state.discoveryWaiters.splice(0)) {
      try { waiter(); } catch {}
    }
    state.childSessions.clear();
    this._removeWebMCPHandlers(tabId, state);
    this._dropWebMCPSession(tabId, 'WebMCP disabled');
    return true;
  }

  async disableAllWebMCP() {
    const tabIds = Array.from(this.webMcpSessions.keys());
    await Promise.all(tabIds.map(tabId => this.disableWebMCP(tabId).catch(() => false)));
    return tabIds.length;
  }

  _webMCPSafeFrameUrl(frame = {}) {
    const rawUrl = String(frame.url || '');
    const securityOrigin = String(frame.securityOrigin || '');
    // Prefer Chrome's effective security origin. Sandboxed/opaque frames may
    // retain an https-looking document URL but must not borrow that host's
    // grant. Older test doubles omit securityOrigin, so a valid network URL
    // remains a compatible fallback.
    if (securityOrigin) {
      try {
        const origin = new URL(securityOrigin);
        if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return '';
        try {
          const url = new URL(rawUrl);
          if (url.origin === origin.origin) return url.href;
        } catch {}
        return origin.origin;
      } catch {
        return '';
      }
    }
    try {
      const url = new URL(rawUrl);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  async _webMCPFrameUrls(tabId) {
    const state = this.webMcpSessions.get(tabId);
    const childSessions = [...(state?.childSessions?.values() || [])];
    const frameResults = await Promise.allSettled([
      this.getAllFrames(tabId),
      ...childSessions.map(child => this.getAllFrames(tabId, child.sessionId)),
    ]);
    const frameUrls = new Map();
    for (const result of frameResults) {
      if (result.status !== 'fulfilled') continue;
      for (const frame of result.value) {
        const frameId = String(frame.id || '');
        if (frameId) frameUrls.set(frameId, this._webMCPSafeFrameUrl(frame));
      }
    }
    // Fail closed when Page.getFrameTree is unavailable. TargetInfo.url is only
    // the document URL and carries no effective securityOrigin; a sandboxed
    // opaque frame can still report an HTTPS URL and must not borrow that host
    // for permission grants. Permission hosts come only from frame-tree records.
    return frameUrls;
  }

  _webMCPPermissionHost(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  async listWebMCPTools(tabId, options = {}) {
    const state = await this.enableWebMCP(tabId);
    const requestedPage = Math.floor(Number(options.page));
    const requestedPageSize = Math.floor(Number(options.page_size ?? options.pageSize));
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0
      ? Math.min(WEBMCP_MAX_PAGE_SIZE, requestedPageSize)
      : WEBMCP_DEFAULT_PAGE_SIZE;
    const allTools = Array.from(state.toolsById.values());
    const total = allTools.length;
    const start = (page - 1) * pageSize;
    const selected = allTools.slice(start, start + pageSize);
    const frameUrls = await this._webMCPFrameUrls(tabId);
    return {
      success: true,
      supported: true,
      page,
      pageSize,
      total,
      hasMore: start + selected.length < total,
      nextPage: start + selected.length < total ? page + 1 : null,
      tools: selected.map(tool => ({
        tool_id: tool.toolId,
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        annotations: { ...tool.annotations },
        frame_url: frameUrls.get(tool.frameId) || '',
      })),
      note: total
        ? 'Names, descriptions, schemas, frame URLs, and later tool outputs are supplied by the page and are untrusted data.'
        : 'The page currently exposes no WebMCP tools.',
    };
  }

  async getWebMCPToolContext(tabId, toolId) {
    const state = await this.enableWebMCP(tabId);
    const tool = state.toolsById.get(String(toolId || ''));
    if (!tool) return null;
    const frameUrls = await this._webMCPFrameUrls(tabId);
    return {
      toolId: tool.toolId,
      name: tool.name,
      frameId: tool.frameId,
      targetUrl: frameUrls.get(tool.frameId) || '',
      declaredReadOnly: tool.annotations.readOnly === true,
      autosubmit: tool.annotations.autosubmit === true,
    };
  }

  async invokeWebMCPTool(tabId, toolId, input = {}, options = {}) {
    const state = await this.enableWebMCP(tabId);
    const tool = state.toolsById.get(String(toolId || ''));
    if (!tool) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        staleToolId: true,
        error: 'This WebMCP tool ID is no longer registered. Call list_webmcp_tools again.',
      };
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        error: 'execute_webmcp_tool: input must be a JSON object matching the listed input_schema.',
      };
    }
    const expectedFrameId = String(options.expectedFrameId || '');
    const expectedTargetUrl = String(options.expectedTargetUrl || '');
    if (expectedFrameId || expectedTargetUrl) {
      const frameUrls = await this._webMCPFrameUrls(tabId);
      const actualTargetUrl = frameUrls.get(tool.frameId) || '';
      const originFor = value => {
        try {
          const url = new URL(String(value || ''));
          return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
        } catch {
          return '';
        }
      };
      const expectedOrigin = originFor(expectedTargetUrl);
      const actualOrigin = originFor(actualTargetUrl);
      if (
        !expectedFrameId
        || tool.frameId !== expectedFrameId
        || !expectedOrigin
        || !actualOrigin
        || actualOrigin !== expectedOrigin
      ) {
        return {
          success: false,
          dispatched: false,
          noDispatch: true,
          contextChanged: true,
          error: 'The WebMCP registration frame changed after permission was checked. Re-list tools and retry so the current frame origin can be authorized.',
        };
      }
    }
    let safeInput;
    try {
      const serializedInput = JSON.stringify(input);
      if (serializedInput.length > WEBMCP_MAX_VALUE_CHARS) {
        return {
          success: false,
          dispatched: false,
          noDispatch: true,
          error: `execute_webmcp_tool: input exceeds the ${WEBMCP_MAX_VALUE_CHARS.toLocaleString('en-US')}-character limit.`,
        };
      }
      safeInput = JSON.parse(serializedInput);
    } catch {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        error: 'execute_webmcp_tool: input must be JSON-serializable.',
      };
    }
    if (state.closed || this.webMcpSessions.get(tabId) !== state) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        error: 'The WebMCP session closed before the tool could be dispatched.',
      };
    }
    if (typeof options.beforeDispatch === 'function') await options.beforeDispatch();
    let invocation;
    try {
      invocation = await this.sendCommand(tabId, 'WebMCP.invokeTool', {
        frameId: tool.frameId,
        toolName: tool.name,
        input: safeInput,
      }, tool.sessionId);
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      return {
        success: false,
        dispatched: true,
        outcomeUnknown: true,
        error: `WebMCP invocation dispatch status is unknown: ${error?.message || error}`,
      };
    }
    const invocationId = String(invocation?.invocationId || '');
    if (!invocationId) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        error: 'Chrome did not return a WebMCP invocation ID.',
      };
    }

    const requestedTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(WEBMCP_MAX_INVOCATION_TIMEOUT_MS, Math.round(requestedTimeout))
      : WEBMCP_DEFAULT_INVOCATION_TIMEOUT_MS;
    const abortCheck = typeof options.abortCheck === 'function' ? options.abortCheck : null;
    const invocationKey = this._webMCPInvocationKey(tool.sessionId, invocationId);
    return await new Promise(resolve => {
      let timer = null;
      let abortTimer = null;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortTimer) clearInterval(abortTimer);
        state.pendingInvocations.delete(invocationKey);
        state.completedResponses.delete(invocationKey);
        resolve({
          ...result,
          tool_id: tool.toolId,
          name: tool.name,
          declaredReadOnly: tool.annotations.readOnly === true,
        });
      };
      const respond = (params = {}) => {
        const status = String(params.status || 'Error');
        if (status === 'Completed') {
          finish({
            success: true,
            dispatched: true,
            status,
            output: this._sanitizeWebMCPValue(params.output),
          });
          return;
        }
        const exceptionText = this._remoteObjectText(params.exception);
        finish({
          success: false,
          dispatched: true,
          cancelled: status === 'Canceled',
          outcomeUnknown: true,
          status,
          error: String(params.errorText || exceptionText || `WebMCP tool finished with status ${status}`).slice(0, 2000),
        });
      };
      state.pendingInvocations.set(invocationKey, {
        invocationId,
        sessionId: tool.sessionId,
        frameId: tool.frameId,
        finish,
        respond,
      });

      const earlyResponse = state.completedResponses.get(invocationKey);
      if (earlyResponse) {
        respond(earlyResponse);
        return;
      }
      timer = setTimeout(() => {
        state.pendingInvocations.delete(invocationKey);
        this.sendCommand(
          tabId,
          'WebMCP.cancelInvocation',
          { invocationId },
          tool.sessionId,
        ).catch(() => {});
        finish({
          success: false,
          dispatched: true,
          timedOut: true,
          outcomeUnknown: true,
          error: `WebMCP tool timed out after ${timeoutMs.toLocaleString('en-US')} ms.`,
        });
      }, timeoutMs);
      if (abortCheck) {
        abortTimer = setInterval(() => {
          let aborted = false;
          try { aborted = abortCheck() === true; } catch {}
          if (!aborted) return;
          state.pendingInvocations.delete(invocationKey);
          this.sendCommand(
            tabId,
            'WebMCP.cancelInvocation',
            { invocationId },
            tool.sessionId,
          ).catch(() => {});
          finish({
            success: false,
            dispatched: true,
            cancelled: true,
            outcomeUnknown: true,
            error: 'WebMCP tool invocation was stopped by the user.',
          });
        }, 100);
      }
    });
  }

  _pushBounded(list, value, max) {
    list.push(value);
    if (list.length > max) list.splice(0, list.length - max);
  }

  _consoleLevel(value) {
    const level = String(value || '').toLowerCase();
    if (level === 'warn' || level === 'warning') return 'warning';
    if (level === 'error' || level === 'assert') return 'error';
    if (level === 'debug' || level === 'verbose' || level === 'trace') return 'debug';
    if (level === 'info') return 'info';
    return 'log';
  }

  _remoteObjectText(remote) {
    if (!remote || typeof remote !== 'object') return '';
    if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
      const value = remote.value;
      if (typeof value === 'string') return value.slice(0, 4000);
      try { return JSON.stringify(value).slice(0, 4000); } catch {}
      return String(value).slice(0, 4000);
    }
    if (remote.unserializableValue != null) return String(remote.unserializableValue).slice(0, 4000);
    if (remote.description != null) return String(remote.description).slice(0, 4000);
    return String(remote.type || '').slice(0, 100);
  }

  _redactedHeaders(headers) {
    const out = {};
    const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
    const secretish = /(secret|token|session|credential|password|passwd|(?:private|api|subscription|access|auth|consumer|functions|signing|client|application)[-_]?key)/i;
    for (const [rawName, rawValue] of Object.entries(headers || {})) {
      const name = String(rawName).slice(0, 200);
      out[name] = (sensitive.test(name) || secretish.test(name))
        ? '[REDACTED]'
        : String(rawValue ?? '').slice(0, 4000);
    }
    return out;
  }

  /**
   * Start bounded Dev-mode console and network capture for a tab. Capture is
   * deliberately opt-in (called when a Dev run starts), and raw bodies are
   * never buffered. Sensitive headers are redacted at ingestion time so they
   * cannot leak later even when inspect_network_requests asks for headers.
   */
  async enableDevDiagnostics(tabId) {
    await this.attach(tabId);
    const existing = this.devDiagnostics.get(tabId);
    if (existing) return existing;

    const state = {
      capturingSince: Date.now(),
      console: [],
      network: [],
      networkByRequestId: new Map(),
      handlers: [],
    };
    this.devDiagnostics.set(tabId, state);
    const register = (event, handler) => {
      this.on(tabId, event, handler);
      state.handlers.push({ event, handler });
    };

    register('Runtime.consoleAPICalled', (params = {}) => {
      const frame = params.stackTrace?.callFrames?.[0] || null;
      this._pushBounded(state.console, {
        level: this._consoleLevel(params.type),
        source: 'console',
        text: (params.args || []).map(arg => this._remoteObjectText(arg)).join(' ').slice(0, 8000),
        seenAt: Date.now(),
        timestamp: Number(params.timestamp) || null,
        location: frame ? {
          url: String(frame.url || '').slice(0, 2000),
          line: Number(frame.lineNumber) + 1,
          column: Number(frame.columnNumber) + 1,
          functionName: String(frame.functionName || '').slice(0, 300),
        } : null,
      }, 200);
    });

    register('Runtime.exceptionThrown', (params = {}) => {
      const details = params.exceptionDetails || {};
      const exception = details.exception || {};
      const frame = details.stackTrace?.callFrames?.[0] || null;
      this._pushBounded(state.console, {
        level: 'error',
        source: 'uncaught_exception',
        text: String(exception.description || exception.value || details.text || 'Uncaught exception').slice(0, 8000),
        seenAt: Date.now(),
        timestamp: Number(params.timestamp) || null,
        location: frame ? {
          url: String(frame.url || details.url || '').slice(0, 2000),
          line: Number(frame.lineNumber) + 1,
          column: Number(frame.columnNumber) + 1,
          functionName: String(frame.functionName || '').slice(0, 300),
        } : {
          url: String(details.url || '').slice(0, 2000),
          line: Number(details.lineNumber) + 1,
          column: Number(details.columnNumber) + 1,
        },
      }, 200);
    });

    register('Log.entryAdded', (params = {}) => {
      const entry = params.entry || {};
      this._pushBounded(state.console, {
        level: this._consoleLevel(entry.level),
        source: String(entry.source || 'log').slice(0, 100),
        text: String(entry.text || '').slice(0, 8000),
        seenAt: Date.now(),
        timestamp: Number(entry.timestamp) || null,
        location: entry.url ? {
          url: String(entry.url).slice(0, 2000),
          line: Number(entry.lineNumber) + 1,
          column: null,
        } : null,
      }, 200);
    });

    register('Network.requestWillBeSent', (params = {}) => {
      const request = params.request || {};
      const prior = state.networkByRequestId.get(params.requestId);
      if (prior && params.redirectResponse) {
        prior.status = Number(params.redirectResponse.status) || null;
        prior.statusText = String(params.redirectResponse.statusText || '').slice(0, 300);
        prior.responseHeaders = this._redactedHeaders(params.redirectResponse.headers);
        prior.redirected = true;
        prior.finishedAt = Date.now();
      }
      const entry = {
        requestId: String(params.requestId || ''),
        loaderId: String(params.loaderId || ''),
        url: String(request.url || '').slice(0, 8000),
        method: String(request.method || 'GET').toUpperCase().slice(0, 30),
        resourceType: String(params.type || '').slice(0, 100),
        documentURL: String(params.documentURL || '').slice(0, 4000),
        initiatorType: String(params.initiator?.type || '').slice(0, 100),
        requestHeaders: this._redactedHeaders(request.headers),
        status: null,
        statusText: '',
        mimeType: '',
        protocol: '',
        responseHeaders: {},
        fromDiskCache: false,
        fromServiceWorker: false,
        encodedDataLength: null,
        errorText: '',
        blockedReason: '',
        canceled: false,
        startedAt: Date.now(),
        cdpTimestamp: Number(params.timestamp) || null,
        finishedAt: null,
        redirected: false,
      };
      this._pushBounded(state.network, entry, 300);
      state.networkByRequestId.set(params.requestId, entry);
      const retained = new Set(state.network.map(item => item.requestId));
      for (const requestId of state.networkByRequestId.keys()) {
        if (!retained.has(String(requestId))) state.networkByRequestId.delete(requestId);
      }
    });

    register('Network.responseReceived', (params = {}) => {
      const entry = state.networkByRequestId.get(params.requestId);
      if (!entry) return;
      const response = params.response || {};
      entry.status = Number(response.status) || 0;
      entry.statusText = String(response.statusText || '').slice(0, 300);
      entry.mimeType = String(response.mimeType || '').slice(0, 300);
      entry.protocol = String(response.protocol || '').slice(0, 100);
      entry.responseHeaders = this._redactedHeaders(response.headers);
      entry.fromDiskCache = !!response.fromDiskCache;
      entry.fromServiceWorker = !!response.fromServiceWorker;
    });

    register('Network.loadingFinished', (params = {}) => {
      const entry = state.networkByRequestId.get(params.requestId);
      if (!entry) return;
      entry.encodedDataLength = Number.isFinite(Number(params.encodedDataLength)) ? Number(params.encodedDataLength) : null;
      entry.finishedAt = Date.now();
    });

    register('Network.loadingFailed', (params = {}) => {
      const entry = state.networkByRequestId.get(params.requestId);
      if (!entry) return;
      entry.errorText = String(params.errorText || '').slice(0, 1000);
      entry.blockedReason = String(params.blockedReason || '').slice(0, 300);
      entry.canceled = !!params.canceled;
      entry.finishedAt = Date.now();
    });

    // Register handlers before enabling domains so no events emitted during
    // enablement are missed. A single unsupported domain should not disable
    // the others; callers still receive the buffers that are available.
    await Promise.allSettled([
      this.sendCommand(tabId, 'Runtime.enable'),
      this.sendCommand(tabId, 'Log.enable'),
      this.sendCommand(tabId, 'Network.enable', {
        maxTotalBufferSize: 10 * 1024 * 1024,
        maxResourceBufferSize: 2 * 1024 * 1024,
        maxPostDataSize: 64 * 1024,
      }),
    ]);
    return state;
  }

  async disableDevDiagnostics(tabId) {
    const state = this.devDiagnostics.get(tabId);
    if (!state) return false;
    for (const { event, handler } of state.handlers || []) {
      this.off(tabId, event, handler);
    }
    state.handlers = [];
    state.console.length = 0;
    state.network.length = 0;
    state.networkByRequestId.clear();
    this.devDiagnostics.delete(tabId);
    // Removing WebBrain's handlers stops local buffering, but the browser
    // continues producing domain events until the matching CDP domains are
    // disabled. Issue the commands after local teardown so late events cannot
    // repopulate the cleared buffers while shutdown is in flight. Other CDP
    // helpers explicitly re-enable Runtime before using it.
    if (this.sessions.has(tabId)) {
      await Promise.allSettled([
        this.sendCommand(tabId, 'Runtime.disable'),
        this.sendCommand(tabId, 'Log.disable'),
        this.sendCommand(tabId, 'Network.disable'),
      ]);
    }
    return true;
  }

  async disableAllDevDiagnostics() {
    const tabIds = [...this.devDiagnostics.keys()];
    const results = await Promise.allSettled(tabIds.map(tabId => this.disableDevDiagnostics(tabId)));
    return results.filter(result => result.status === 'fulfilled' && result.value === true).length;
  }

  async readConsole(tabId, options = {}) {
    const state = await this.enableDevDiagnostics(tabId);
    const levels = new Set(Array.isArray(options.levels) ? options.levels.map(v => this._consoleLevel(v)) : []);
    const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Math.max(0, Number(options.sinceMs)) : null;
    const cutoff = sinceMs == null ? 0 : Date.now() - sinceMs;
    const limit = Math.max(1, Math.min(200, Math.round(Number(options.limit) || 100)));
    const entries = state.console
      .filter(entry => (!levels.size || levels.has(entry.level)) && entry.seenAt >= cutoff)
      .slice(-limit)
      .map(entry => ({ ...entry, seenAt: new Date(entry.seenAt).toISOString() }));
    if (options.clear) state.console.length = 0;
    return {
      success: true,
      capturingSince: new Date(state.capturingSince).toISOString(),
      count: entries.length,
      entries,
      cleared: !!options.clear,
      note: 'Console capture begins when Dev diagnostics attach; messages logged before that point may be unavailable.',
    };
  }

  async inspectNetworkRequests(tabId, options = {}) {
    const state = await this.enableDevDiagnostics(tabId);
    const urlPattern = String(options.urlPattern || '').toLowerCase();
    const methods = new Set(Array.isArray(options.methods) ? options.methods.map(v => String(v).toUpperCase()) : []);
    const statusMin = Number.isFinite(Number(options.statusMin)) ? Number(options.statusMin) : null;
    const statusMax = Number.isFinite(Number(options.statusMax)) ? Number(options.statusMax) : null;
    const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Math.max(0, Number(options.sinceMs)) : null;
    const cutoff = sinceMs == null ? 0 : Date.now() - sinceMs;
    const limit = Math.max(1, Math.min(100, Math.round(Number(options.limit) || 50)));
    const includeHeaders = options.includeHeaders === true;
    const includeBodies = options.includeBodies === true;
    const bodyMaxChars = Math.max(100, Math.min(20000, Math.round(Number(options.bodyMaxChars) || 5000)));
    const selected = state.network.filter(entry => {
      if (entry.startedAt < cutoff) return false;
      if (urlPattern && !entry.url.toLowerCase().includes(urlPattern)) return false;
      if (methods.size && !methods.has(entry.method)) return false;
      if (statusMin != null && (entry.status == null || entry.status < statusMin)) return false;
      if (statusMax != null && (entry.status == null || entry.status > statusMax)) return false;
      return true;
    }).slice(-limit);

    const requests = [];
    for (const entry of selected) {
      const output = {
        requestId: entry.requestId,
        url: entry.url,
        method: entry.method,
        status: entry.status,
        statusText: entry.statusText,
        resourceType: entry.resourceType,
        mimeType: entry.mimeType,
        protocol: entry.protocol,
        encodedDataLength: entry.encodedDataLength,
        durationMs: entry.finishedAt ? Math.max(0, entry.finishedAt - entry.startedAt) : null,
        startedAt: new Date(entry.startedAt).toISOString(),
        finished: !!entry.finishedAt,
        failed: !!entry.errorText,
        errorText: entry.errorText || undefined,
        blockedReason: entry.blockedReason || undefined,
        canceled: entry.canceled || undefined,
        redirected: entry.redirected || undefined,
        fromDiskCache: entry.fromDiskCache,
        fromServiceWorker: entry.fromServiceWorker,
        initiatorType: entry.initiatorType || undefined,
      };
      if (includeHeaders) {
        output.requestHeaders = entry.requestHeaders;
        output.responseHeaders = entry.responseHeaders;
      }
      if (includeBodies) {
        if (!['GET', 'HEAD'].includes(entry.method) && !entry.redirected) {
          try {
            const requestBody = await this.sendCommand(tabId, 'Network.getRequestPostData', { requestId: entry.requestId });
            const body = String(requestBody?.postData || '');
            output.requestBody = body.length > bodyMaxChars ? body.slice(0, bodyMaxChars) + '\n[...body truncated]' : body;
          } catch {
            output.requestBodyUnavailable = true;
          }
        }
        const textual = /^(?:text\/|application\/(?:json|.+\+json|javascript|xml|x-www-form-urlencoded|graphql))/i.test(entry.mimeType || '');
        if (entry.status != null && textual && !entry.redirected) {
          try {
            const responseBody = await this.sendCommand(tabId, 'Network.getResponseBody', { requestId: entry.requestId });
            if (responseBody?.base64Encoded) {
              output.responseBodyUnavailable = 'CDP returned a base64-encoded body; binary/base64 payloads are omitted.';
            } else {
              const body = String(responseBody?.body || '');
              output.responseBody = body.length > bodyMaxChars ? body.slice(0, bodyMaxChars) + '\n[...body truncated]' : body;
            }
          } catch {
            output.responseBodyUnavailable = true;
          }
        } else if (entry.status != null && !textual) {
          output.responseBodyUnavailable = 'Non-text response body omitted.';
        }
      }
      requests.push(output);
    }
    if (options.clear) {
      state.network.length = 0;
      state.networkByRequestId.clear();
    }
    return {
      success: true,
      capturingSince: new Date(state.capturingSince).toISOString(),
      count: requests.length,
      requests,
      includesHeaders: includeHeaders,
      includesBodies: includeBodies,
      sensitiveHeadersRedacted: true,
      cleared: !!options.clear,
      note: 'Network capture begins when Dev diagnostics attach; reload or repeat an action when the request you need predates capture.',
    };
  }

  async findNodeByAttribute(tabId, attributeName, attributeValue) {
    await this.sendCommand(tabId, 'DOM.enable');
    const result = await this.sendCommand(tabId, 'DOM.getFlattenedDocument', { depth: -1, pierce: true });
    for (const node of result.nodes || []) {
      const attrs = node.attributes || [];
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === attributeName && attrs[i + 1] === attributeValue) return node;
      }
    }
    return null;
  }

  _formatEventListeners(listeners, relation, eventTypes = null) {
    const wanted = eventTypes?.size ? eventTypes : null;
    return (listeners || [])
      .filter(listener => !wanted || wanted.has(String(listener.type || '').toLowerCase()))
      .map(listener => ({
        relation,
        type: String(listener.type || ''),
        useCapture: !!listener.useCapture,
        passive: !!listener.passive,
        once: !!listener.once,
        scriptId: String(listener.scriptId || ''),
        line: Number(listener.lineNumber) + 1,
        column: Number(listener.columnNumber) + 1,
        handler: this._remoteObjectText(listener.handler || listener.originalHandler).slice(0, 1000),
      }));
  }

  async getEventListenersForNode(tabId, nodeId, relation = 'target', eventTypes = null) {
    const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return [];
    try {
      const result = await this.sendCommand(tabId, 'DOMDebugger.getEventListeners', {
        objectId,
        depth: 1,
        pierce: true,
      });
      return this._formatEventListeners(result?.listeners, relation, eventTypes);
    } finally {
      this.releaseObject(tabId, objectId);
    }
  }

  async getEventListenersForExpression(tabId, expression, relation, eventTypes = null) {
    await this.sendCommand(tabId, 'Runtime.enable');
    const evaluated = await this.sendCommand(tabId, 'Runtime.evaluate', { expression });
    const objectId = evaluated?.result?.objectId;
    if (!objectId) return [];
    try {
      const result = await this.sendCommand(tabId, 'DOMDebugger.getEventListeners', {
        objectId,
        depth: 1,
        pierce: true,
      });
      return this._formatEventListeners(result?.listeners, relation, eventTypes);
    } finally {
      this.releaseObject(tabId, objectId);
    }
  }

  /**
   * Get full DOM tree including shadow DOMs and iframes.
   */
  async getFullDOM(tabId) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    const result = await this.sendCommand(tabId, 'DOM.getFlattenedDocument', { depth: -1, pierce: true });
    return result;
  }

  /**
   * Query a selector in the main document and all open shadow roots.
   * DOM.querySelectorAll only searches the supplied root node; its protocol
   * schema has no shadow-piercing option. Resolve matches in page JS and keep
   * their Runtime object handles alive until the caller finishes using them.
   * This avoids frontend nodeIds, which are invalidated whenever another CDP
   * consumer refreshes Chrome's DOM mirror with DOM.getDocument.
   */
  async querySelectorPierce(tabId, selector) {
    await this.sendCommand(tabId, 'Runtime.enable');
    const objectGroup = `webbrain-query-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const evaluated = await this.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `
          (() => {
            const selector = ${JSON.stringify(selector)};
            const matches = [];
            const visit = (root) => {
              matches.push(...root.querySelectorAll(selector));
              for (const element of root.querySelectorAll('*')) {
                if (element.shadowRoot) visit(element.shadowRoot);
              }
            };
            visit(document);
            return matches;
          })()
        `,
        objectGroup,
        returnByValue: false,
      });
      if (evaluated?.exceptionDetails) {
        throw new Error(evaluated.exceptionDetails.text || 'Selector evaluation failed');
      }
      const arrayObjectId = evaluated?.result?.objectId;
      if (!arrayObjectId) {
        await this.releaseObjectGroup(tabId, objectGroup);
        return { objectIds: [], objectGroup: null };
      }
      const properties = await this.sendCommand(tabId, 'Runtime.getProperties', {
        objectId: arrayObjectId,
        ownProperties: true,
      });
      const objectIds = [];
      for (const property of properties?.result || []) {
        if (!/^\d+$/.test(property?.name || '')) continue;
        const objectId = property?.value?.objectId;
        if (!objectId) continue;
        objectIds.push(objectId);
      }
      return { objectIds, objectGroup };
    } catch (error) {
      if (error?.code === 'page_feedback_pending') throw error;
      await this.releaseObjectGroup(tabId, objectGroup);
      throw error;
    }
  }

  // Runtime cleanup is best effort: a stalled renderer or lost acknowledgement
  // must not delay a known observation/action result or replace its error.
  releaseObject(tabId, objectId, sessionId = '') {
    if (!objectId) return;
    try { void this.sendCommand(tabId, 'Runtime.releaseObject', { objectId }, sessionId).catch(() => {}); } catch {}
  }

  /**
   * Schedule release of Runtime objects returned by querySelectorPierce.
   */
  async releaseObjectGroup(tabId, objectGroup) {
    if (!objectGroup) return;
    try {
      void this.sendCommand(tabId, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
    } catch {}
  }

  /**
   * Get node info including shadow root.
   */
  async describeNode(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    return await this.sendCommand(tabId, 'DOM.describeNode', { nodeId });
  }

  /**
   * Resolve a JS path to a node (for accessing shadow DOM elements).
   */
  async resolveNode(tabId, objectId) {
    await this.sendCommand(tabId, 'DOM.enable');
    return await this.sendCommand(tabId, 'DOM.resolveNode', { objectId });
  }

  /**
   * Call a JS function on the page.
   */
  async evaluate(tabId, expression, returnByValue = true, options = {}) {
    await this.sendCommand(tabId, 'Runtime.enable');
    const params = {
      expression,
      returnByValue,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    };
    const requestedTimeout = Number(options?.timeoutMs);
    if (Number.isFinite(requestedTimeout) && requestedTimeout > 0) {
      params.timeout = Math.max(1, Math.min(30000, Math.round(requestedTimeout)));
    }
    const result = await this.sendCommand(tabId, 'Runtime.evaluate', params);
    return result;
  }

  /** Evaluate a function on the page global, passing data as protocol arguments. */
  async evaluateFunction(tabId, functionDeclaration, args = [], options = {}) {
    await this.sendCommand(tabId, 'Runtime.enable');
    const global = await this.sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'globalThis',
      returnByValue: false,
      userGesture: true,
    });
    const objectId = global?.result?.objectId;
    if (!objectId) return global;
    const requestedTimeout = Number(options?.timeoutMs);
    const params = {
      functionDeclaration,
      objectId,
      arguments: args.map(value => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    };
    if (Number.isFinite(requestedTimeout) && requestedTimeout > 0) {
      params.timeout = Math.max(1, Math.min(30000, Math.round(requestedTimeout)));
    }
    try {
      return await this.sendCommand(tabId, 'Runtime.callFunctionOn', params);
    } finally {
      // Object cleanup cannot delay or replace a known page result. In
      // particular, keep a proven no-dispatch result even if cleanup stalls.
      this.releaseObject(tabId, objectId);
    }
  }

  /**
   * Call function on an object.
   */
  async callFunctionOn(tabId, functionDeclaration, objectId, args = []) {
    await this.sendCommand(tabId, 'Runtime.enable');
    return await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
      functionDeclaration,
      objectId,
      arguments: args,
      returnByValue: true,
      userGesture: true,
    });
  }

  /**
   * Get all frames including cross-origin iframes.
   */
  async getAllFrames(tabId, sessionId = '') {
    await this.sendCommand(tabId, 'Page.enable', {}, sessionId);
    const result = await this.sendCommand(tabId, 'Page.getFrameTree', {}, sessionId);
    
    const frames = [];
    const collectFrames = (frameTree) => {
      if (frameTree.frame) {
        frames.push({
          id: frameTree.frame.id,
          url: frameTree.frame.url,
          securityOrigin: frameTree.frame.securityOrigin,
          name: frameTree.frame.name,
          parentId: frameTree.frame.parentId,
        });
      }
      if (frameTree.childFrames) {
        frameTree.childFrames.forEach(collectFrames);
      }
    };
    
    collectFrames(result.frameTree);
    return frames;
  }

  /**
   * Take a pixel-perfect screenshot of the full page.
   * @param {number} tabId
   * @param {{knownInfiniteScroll?:boolean,adapterName?:string}} [options]
   * @returns {Promise<{
   *   data:string,
   *   warning:string|null,
   *   captureBounds:{x:number,y:number,width:number,height:number}
   * }>} Capture bounds are CSS pixels in top-page coordinates.
   */
  async _scrollForFullPageCapture(tabId, x, y, captureState) {
    const guard = await beforePageAgentDispatch(globalThis.chrome, tabId, {
      kind: 'scroll', scrollIntoView: true, fenceOnly: true,
      ...(captureState.operationId ? { operationId: captureState.operationId } : {}),
    });
    if (guard?.operationId) captureState.operationId = guard.operationId;
    if (guard?.runToken) captureState.runToken = guard.runToken;
    const result = await this.evaluateFunction(tabId, `function (pageGuard, x, y) {
      ${SELECTOR_SCROLL_DISPATCH_SOURCE}
      if (!beforeSelectorScroll(document.documentElement, pageGuard)) return { scrolled: false, pageFeedbackPending: true };
      window.scrollTo(x, y);
      return { scrolled: true };
    }`, [guard || null, x, y]);
    const value = result?.result?.value;
    throwIfPageFeedbackPending(value);
    if (value?.scrolled !== true) throw new Error('Could not scroll the page for full-page capture');
  }

  async _finishFullPageCaptureScroll(tabId, captureState) {
    if (!captureState.runToken || !captureState.operationId || !hasPageAgentDispatchOwner(tabId)) return;
    try {
      await globalThis.chrome?.tabs?.sendMessage(tabId, { target: 'content', action: 'page_monitor_finish',
        params: { runToken: captureState.runToken, operationId: captureState.operationId } }, { frameId: 0 });
    } catch { /* The page may have navigated or the run may have ended. */ }
  }

  async captureFullPageScreenshot(tabId, options = {}) {
    await this.sendCommand(tabId, 'Page.enable');
    const metrics = await this.sendCommand(tabId, 'Page.getLayoutMetrics');
    const visualViewport = metrics?.cssVisualViewport;
    const contentSize = metrics?.cssContentSize;
    const tileWidth = Math.floor(Number(visualViewport?.clientWidth));
    const tileHeight = Math.floor(Number(visualViewport?.clientHeight));
    let contentWidth = Math.ceil(Number(contentSize?.width));
    let contentHeight = Math.ceil(Number(contentSize?.height));
    const scaleResult = await this.evaluate(tabId, 'window.devicePixelRatio');
    const nativeScale = Number(scaleResult?.result?.value);
    const deviceScale = Number.isFinite(nativeScale) && nativeScale > 0 ? nativeScale : 1;

    if (![tileWidth, tileHeight, contentWidth, contentHeight].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error('Could not determine page dimensions for full-page screenshot');
    }

    const contentX = Number.isFinite(Number(contentSize?.x)) ? Number(contentSize.x) : 0;
    const contentY = Number.isFinite(Number(contentSize?.y)) ? Number(contentSize.y) : 0;
    const originalScrollX = Number.isFinite(Number(visualViewport?.pageX)) ? Number(visualViewport.pageX) : 0;
    const originalScrollY = Number.isFinite(Number(visualViewport?.pageY)) ? Number(visualViewport.pageY) : 0;
    const tiles = [];
    const warnings = [];
    const knownInfiniteScroll = options?.knownInfiniteScroll === true;
    const adapterName = String(options?.adapterName || 'this').trim() || 'this';
    let contentGrowths = 0;
    let captureBoundsFrozen = false;
    let infiniteScrollWarningAdded = false;
    const captureState = {};
    const addInfiniteScrollWarning = () => {
      if (infiniteScrollWarningAdded) return;
      infiniteScrollWarningAdded = true;
      warnings.push(knownInfiniteScroll
        ? `The ${adapterName} page is known to use infinite scrolling. Captured a bounded snapshot after at most ${FULL_PAGE_MAX_CONTENT_GROWTHS} content expansions; later content may not be included.`
        : `The page appears to use infinite scrolling. Captured a bounded snapshot after ${FULL_PAGE_MAX_CONTENT_GROWTHS} content expansions instead of continuing indefinitely; later content may not be included.`);
    };
    if (knownInfiniteScroll) addInfiniteScrollWarning();
    const updateContentBounds = (nextMetrics) => {
      if (captureBoundsFrozen) return false;
      const nextSize = nextMetrics?.cssContentSize;
      const nextWidth = Math.ceil(Number(nextSize?.width));
      const nextHeight = Math.ceil(Number(nextSize?.height));
      let grew = false;
      if (Number.isFinite(nextWidth) && nextWidth > contentWidth) {
        contentWidth = nextWidth;
        grew = true;
      }
      if (Number.isFinite(nextHeight) && nextHeight > contentHeight) {
        contentHeight = nextHeight;
        grew = true;
      }
      if (grew) {
        contentGrowths++;
        if (contentGrowths >= FULL_PAGE_MAX_CONTENT_GROWTHS) {
          captureBoundsFrozen = true;
          addInfiniteScrollWarning();
        }
      }
      return grew;
    };

    try {
      // Discovery pass: walk the page before capture so intersection-based
      // lazy content can load. Re-read layout metrics until the bottom stays
      // stable twice; bounded steps keep infinite feeds finite.
      let stablePasses = 0;
      let discoveryOffsetY = 0;
      let discoverySteps = 0;
      while (
        stablePasses < FULL_PAGE_STABLE_PASSES &&
        discoverySteps < FULL_PAGE_MAX_DISCOVERY_STEPS &&
        !captureBoundsFrozen
      ) {
        const bottomY = contentY + Math.max(0, contentHeight - tileHeight);
        const targetY = Math.min(contentY + discoveryOffsetY, bottomY);
        await this._scrollForFullPageCapture(tabId, contentX, targetY, captureState);
        await new Promise(resolve => setTimeout(resolve, FULL_PAGE_SCROLL_SETTLE_MS));
        const grew = updateContentBounds(await this.sendCommand(tabId, 'Page.getLayoutMetrics'));
        const updatedBottomY = contentY + Math.max(0, contentHeight - tileHeight);
        const atBottom = targetY >= updatedBottomY;
        stablePasses = atBottom && !grew ? stablePasses + 1 : 0;
        if (targetY < updatedBottomY) {
          discoveryOffsetY = targetY - contentY + tileHeight;
        }
        discoverySteps++;
      }
      if (!captureBoundsFrozen && stablePasses < FULL_PAGE_STABLE_PASSES) {
        warnings.push(
          `Full-page discovery was limited after ${FULL_PAGE_MAX_DISCOVERY_STEPS} scroll steps; the returned image may be partial.`
        );
      }

      let captureLimitReached = false;
      for (let y = 0; y < contentHeight && !captureLimitReached; y += tileHeight) {
        for (let x = 0; x < contentWidth; x += tileWidth) {
          if (tiles.length >= FULL_PAGE_MAX_CAPTURE_TILES) {
            captureLimitReached = true;
            break;
          }
          const clipX = contentX + x;
          const clipY = contentY + y;
          await this._scrollForFullPageCapture(tabId, clipX, clipY, captureState);
          await new Promise(resolve => setTimeout(resolve, FULL_PAGE_SCROLL_SETTLE_MS));
          // The page can still grow during the capture pass. Expand the loop
          // bounds before sizing this tile so a newly moved footer is included,
          // unless discovery identified an unbounded infinite-scroll feed.
          if (!captureBoundsFrozen) {
            updateContentBounds(await this.sendCommand(tabId, 'Page.getLayoutMetrics'));
          }
          const width = Math.min(tileWidth, contentWidth - x);
          const height = Math.min(tileHeight, contentHeight - y);
          const screenshot = await this.sendCommand(tabId, 'Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: true,
            clip: {
              x: clipX,
              y: clipY,
              width,
              height,
              // Chrome already rasterizes CSS clip coordinates at the page's
              // device scale. Applying DPR here again would produce DPR² tiles
              // that the CSS×DPR compositor then crops to their top-left.
              scale: 1,
            },
          });
          tiles.push({ x, y, width, height, data: screenshot.data });
        }
      }
      if (captureLimitReached) {
        warnings.push(
          `The page exceeded the ${FULL_PAGE_MAX_CAPTURE_TILES}-tile full-page capture limit; the returned image is partial.`
        );
      }

      const assembledWidth = captureLimitReached
        ? Math.max(...tiles.map(tile => tile.x + tile.width))
        : contentWidth;
      const assembledHeight = captureLimitReached
        ? Math.max(...tiles.map(tile => tile.y + tile.height))
        : contentHeight;

      let outputBounds = { x: 0, y: 0, width: assembledWidth, height: assembledHeight };
      const data = await combineImages(tiles, assembledWidth, assembledHeight, deviceScale, {
        onWarning: warning => warnings.push(warning),
        onFallback: bounds => { outputBounds = bounds; },
      });
      return {
        data,
        warning: warnings.join(' ') || null,
        captureBounds: {
          x: contentX + outputBounds.x,
          y: contentY + outputBounds.y,
          width: outputBounds.width,
          height: outputBounds.height,
        },
      };
    } finally {
      try {
        if (!captureState.runToken || hasPageAgentDispatchOwner(tabId)) {
          await this._scrollForFullPageCapture(tabId, originalScrollX, originalScrollY, captureState);
        }
      } catch { /* Preserve the user's new position if the page changed during capture. */ }
      await this._finishFullPageCaptureScroll(tabId, captureState);
    }
  }

  /**
   * Take a screenshot of a specific element.
   */
  async captureElementScreenshot(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    const boxModel = await this.sendCommand(tabId, 'DOM.getBoxModel', { nodeId });
    if (!boxModel || !boxModel.model) {
      throw new Error('Could not get box model for element');
    }

    const { contentOffset, border, padding, width, height } = boxModel.model;
    const x = contentOffset[0];
    const y = contentOffset[1];
    const w = width;
    const h = height;

    await this.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: Math.ceil(w),
      screenHeight: Math.ceil(h),
      viewport: { x: -x + border[0], y: -y + border[1], width: Math.ceil(w), height: Math.ceil(h), scale: 1 },
    });

    await this.evaluate(tabId, `window.scrollTo(${x - border[0]}, ${y - border[1]})`);
    await new Promise(r => setTimeout(r, 100));

    const screenshot = await this.sendCommand(tabId, 'Page.captureScreenshot', {
      format: 'png',
      quality: 100,
      fromSurface: true,
    });

    return screenshot.data;
  }

  /**
   * Scroll to and highlight an element.
   */
  async scrollToElement(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    const boxModel = await this.sendCommand(tabId, 'DOM.getBoxModel', { nodeId });
    if (boxModel?.model) {
      const x = boxModel.model.contentOffset[0];
      const y = boxModel.model.contentOffset[1];
      await this.evaluate(tabId, `window.scrollTo(${x - 100}, ${y - 100})`);
      return { success: true, x, y };
    }
    return { success: false };
  }

  /**
   * Set file input files (for upload).
   */
  async setFileInputFiles(tabId, objectId, filePaths, options = {}) {
    const checkAbort = () => { if (options.abortSignal?.aborted) throw options.abortSignal.reason || new Error('File attachment stopped.'); };
    checkAbort();
    const input = await this.callFunctionOn(tabId, `function() { return { fileInput: this instanceof HTMLInputElement && this.type === 'file', accept: this.getAttribute('accept') || '' }; }`, objectId);
    const metadata = input?.result?.value;
    if (!metadata?.fileInput) return { success: false, dispatched: false, noDispatch: true, error: 'Target is not a current file input.' };
    const preparedFiles = [];
    for (const filePath of filePaths) {
      if (!metadata.accept.trim() || metadata.accept.trim() === '*' || metadata.accept.trim() === '*/*') continue;
      const bytes = await this.probeLocalFile(tabId, filePath, { includeData: true, maxBytes: 8192, readPrefixBytes: 8192 });
      const typeCheck = bytes?.readable === true ? validateUploadFile(metadata.accept, bytes) : { success: false, dispatched: false, noDispatch: true, outcomeUnknown: false, reasonCode: 'file_type_unverified', error: 'The actual saved file bytes could not be read before attachment.' };
      checkAbort();
      if (!typeCheck.success) {
        if (typeCheck.actualMime === 'text/html' && options.sourceUrl) {
          const viewer = await this.probeLocalFile(tabId, filePath, { includeData: true, maxBytes: 262144, readPrefixBytes: 262144 });
          checkAbort();
          const sameSavedFile = viewer?.readable === true && viewer.filename === bytes.filename && viewer.size === bytes.size && viewer.lastModified === bytes.lastModified && String(viewer.base64 || '').startsWith(String(bytes.base64 || '').slice(0, Math.floor(8192 / 3) * 4));
          const sourceResolution = sameSavedFile ? observedFileViewerResource(viewer.base64, options.sourceUrl) : null;
          if (sourceResolution) return { ...typeCheck, sourceResolution };
        }
        return typeCheck;
      }
      preparedFiles.push({ filePath, bytes });
    }
    checkAbort();
    for (const { filePath, bytes } of preparedFiles) {
      const currentBytes = await this.probeLocalFile(tabId, filePath, { includeData: true, maxBytes: 8192, readPrefixBytes: 8192 });
      checkAbort();
      if (currentBytes?.readable !== true || currentBytes.filename !== bytes.filename || currentBytes.size !== bytes.size || currentBytes.lastModified !== bytes.lastModified || currentBytes.base64 !== bytes.base64) return { success: false, dispatched: false, noDispatch: true, outcomeUnknown: false, reasonCode: 'file_identity_changed', error: 'The saved file changed after its content was inspected. Re-read the intended file before attaching it.' };
    }
    const current = await this.callFunctionOn(tabId, `function() { return { connected: this.isConnected, fileInput: this instanceof HTMLInputElement && this.type === 'file', disabled: this.disabled, accept: this.getAttribute('accept') || '' }; }`, objectId);
    if (!current?.result?.value?.connected || !current.result.value.fileInput || current.result.value.disabled || current.result.value.accept !== metadata.accept) return { success: false, dispatched: false, noDispatch: true, outcomeUnknown: false, error: 'The file input or accepted types changed before attachment. Re-observe the intended input.' };
    const target = hasPageAgentDispatchOwner(tabId) ? await this._pageAgentObjectTarget(tabId, objectId) : {};
    await beforePageAgentDispatch(globalThis.chrome, tabId, { kind: 'input', eventTypes: ['input', 'change'], ...target });
    checkAbort();
    options.beforeDispatch?.();
    await this.sendCommand(tabId, 'DOM.setFileInputFiles', {
      objectId,
      files: filePaths,
    });
    return { success: true };
  }

  /**
   * Attach in-memory user-selected bytes to an existing file input. Unlike
   * DOM.setFileInputFiles this needs no local path: the File and DataTransfer
   * are created in the page realm from a run-scoped attachment handle.
   */
  async setFileInputData(tabId, objectId, { base64, filename, mimeType }, options = {}) {
    const abortSignal = options?.abortSignal || null;
    const deadlineAt = Number(options?.deadlineAt) || 0;
    const throwIfAborted = () => {
      if (!abortSignal?.aborted) return;
      if (abortSignal.reason instanceof Error) throw abortSignal.reason;
      const error = new Error('The file attachment was aborted.');
      error.name = 'AbortError';
      throw error;
    };
    throwIfAborted();
    await this.sendCommand(tabId, 'Runtime.enable');
    throwIfAborted();
    const input = await this.callFunctionOn(tabId, `function() { return { connected: this.isConnected, fileInput: this instanceof HTMLInputElement && this.type === 'file', accept: this.getAttribute('accept') || '' }; }`, objectId);
    throwIfAborted();
    const accept = input?.result?.value?.accept;
    if (!input?.result?.value?.connected || !input.result.value.fileInput) return { success: false, dispatched: false, noDispatch: true, error: 'Target is not a current file input.' };
    const checked = validateUploadFile(accept, { base64, filename, mimeType });
    if (!checked.success) return checked;
    const target = hasPageAgentDispatchOwner(tabId) ? await this._pageAgentObjectTarget(tabId, objectId) : {};
    const pageGuard = await beforePageAgentDispatch(globalThis.chrome, tabId, {
      kind: 'input', eventTypes: ['input', 'change'], fenceOnly: true, prepareMonitor: true, ...target,
    });
    throwIfAborted();
    if (typeof options?.beforeDispatch === 'function') options.beforeDispatch();
    const res = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
      functionDeclaration: `function (base64, filename, mimeType, actionDeadlineAt, expectedAccept, pageGuard) {
        ${PAGE_AGENT_DOM_ACTION_SOURCE}
        const deadlineExpired = () => Number(actionDeadlineAt) > 0 && Date.now() >= Number(actionDeadlineAt);
        if (deadlineExpired()) {
          return { success: false, dispatched: false, deadlineExpired: true, error: 'Upload action deadline expired before dispatch' };
        }
        if (!(this instanceof HTMLInputElement) || this.type !== 'file') {
          return { success: false, dispatched: false, error: 'Target is not an <input type=file>.' };
        }
        if (!this.isConnected || (this.getAttribute('accept') || '') !== expectedAccept) return { success: false, dispatched: false, noDispatch: true, error: 'The file input or accepted types changed before attachment.' };
        ${FILE_UPLOAD_POLICY_SOURCE}
        const typeCheck = validateUploadFile(this.getAttribute('accept'), { base64, filename, mimeType });
        if (!typeCheck.success) return typeCheck;
        let dispatched = false;
        try {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const file = new File([bytes], filename, { type: mimeType || 'application/octet-stream' });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          if (deadlineExpired()) {
            return { success: false, dispatched: false, deadlineExpired: true, error: 'Upload action deadline expired before dispatch' };
          }
          if (!beforePageAgentDomAction(pageGuard, 'input', this)) {
            return { success: false, dispatched: false, noDispatch: true, pageFeedbackPending: true,
              error: 'The page changed before the in-memory upload could dispatch.' };
          }
          if (deadlineExpired()) {
            return { success: false, dispatched: false, deadlineExpired: true, error: 'Upload action deadline expired before dispatch' };
          }
          this.files = transfer.files;
          dispatched = true;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          if (deadlineExpired()) {
            return { success: false, dispatched: true, outcomeUnknown: true, retryable: false,
              deadlineExpired: true, error: 'Upload action deadline expired during input dispatch' };
          }
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, dispatched: true, name: file.name, size: file.size, type: file.type };
        } catch (error) {
          if (error?.code === 'page_feedback_pending') throw error;
          return { success: false, dispatched, error: error?.message || String(error) };
        }
      }`,
      objectId,
      arguments: [
        { value: String(base64 ?? '') },
        { value: String(filename || 'attachment') },
        { value: String(mimeType || 'application/octet-stream') },
        { value: deadlineAt },
        { value: accept },
        { value: pageGuard || null },
      ],
      returnByValue: true,
    });
    const result = res?.result?.value || { success: false, dispatched: false, error: 'The page did not return an upload result.' };
    if (result?.deadlineExpired && result?.dispatched !== true) return result;
    throwIfAborted();
    return result;
  }

  async _disarmProtocolFileChooserGuard(tabId) {
    const state = this.fileChooserGuards.get(tabId);
    if (!state) return;
    this.fileChooserGuards.delete(tabId);
    if (state.timer) clearTimeout(state.timer);
    this.off(tabId, 'Page.fileChooserOpened', state.handler);
    try {
      await this.sendCommand(tabId, 'Page.setInterceptFileChooserDialog', {
        enabled: false,
      });
    } catch {}
  }

  async _armProtocolFileChooserGuard(tabId, ttlMs) {
    await this._disarmProtocolFileChooserGuard(tabId);
    const state = {
      blocked: null,
      handler: null,
      timer: null,
    };
    state.handler = (params = {}) => {
      // Only the protocol saw this chooser: the page-world guard covers the
      // top document and its open shadow roots, so the input is in a frame
      // or a closed shadow root, where upload_file cannot reach it either.
      state.blocked = {
        blocked: true,
        selector: null,
        protocolOnly: true,
        ts: Date.now(),
        ...(params.backendNodeId ? { backendNodeId: params.backendNodeId } : {}),
      };
    };
    this.on(tabId, 'Page.fileChooserOpened', state.handler);
    this.fileChooserGuards.set(tabId, state);
    try {
      await this.sendCommand(tabId, 'Page.enable');
      await this.sendCommand(tabId, 'Page.setInterceptFileChooserDialog', {
        enabled: true,
        cancel: true,
      });
    } catch {
      this.off(tabId, 'Page.fileChooserOpened', state.handler);
      this.fileChooserGuards.delete(tabId);
      return;
    }
    state.timer = setTimeout(() => {
      this._disarmProtocolFileChooserGuard(tabId).catch(() => {});
    }, ttlMs);
  }

  /**
   * Temporarily suppress renderer-driven <input type=file> activation while an
   * agent click is being dispatched. The upload_file tool sets files directly
   * with DOM.setFileInputFiles; clicking a page's "Choose file" affordance
   * first only opens an OS dialog that CDP cannot operate and leaves it stale
   * after the direct upload succeeds.
   *
   * The capture listener is installed once per document, but it is inert
   * unless armed. A short expiry is a safety net for early-return/error paths,
   * so normal user clicks are never permanently affected.
   */
  async armFileInputClickGuard(tabId, ttlMs = 2500) {
    const ttl = Math.max(250, Math.min(Number(ttlMs) || 2500, 5000));
    await this._armProtocolFileChooserGuard(tabId, ttl);
    await this.evaluate(tabId, `
      (() => {
        // A prior content-script click may intentionally leave its MAIN-world
        // programmatic guard alive through a short TTL. Restore that wrapper
        // before CDP snapshots the native methods, otherwise the two restore
        // lifecycles can re-install each other's stale wrapper.
        document.dispatchEvent(new Event('webbrain:file-picker-guard-reset'));
        const uniqueFileInputSelector = (input) => {
          const allPiercedMatches = (selector) => {
            const matches = [];
            const visit = (root) => {
              try { matches.push(...root.querySelectorAll(selector)); } catch { return; }
              let elements = [];
              try { elements = root.querySelectorAll('*'); } catch {}
              for (const element of elements) {
                if (element.shadowRoot) visit(element.shadowRoot);
              }
            };
            visit(document);
            return matches;
          };
          const unique = (selector) => {
            if (!selector) return null;
            const matches = allPiercedMatches(selector);
            return matches.length === 1 && matches[0] === input ? selector : null;
          };
          try {
            if (input.id && window.CSS?.escape) {
              const byId = unique('#' + CSS.escape(input.id));
              if (byId) return byId;
            }
            if (input.name && window.CSS?.escape) {
              const byName = unique('input[type="file"][name=' + CSS.escape(String(input.name)) + ']');
              if (byName) return byName;
            }
            const parts = [];
            let node = input;
            while (node?.nodeType === Node.ELEMENT_NODE) {
              let part = node.tagName.toLowerCase();
              const parent = node.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
                if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
              }
              parts.unshift(part);
              const byPath = unique(parts.join(' > '));
              if (byPath) return byPath;
              node = parent;
            }
          } catch {}
          return null;
        };
        if (!window.__wb_file_input_click_guard) {
          window.__wb_file_input_click_guard = (event) => {
            if (Date.now() > Number(window.__wb_file_input_click_guard_until || 0)) return;
            const path = typeof event.composedPath === 'function'
              ? event.composedPath()
              : [event.target];
            const input = path.find(node =>
              node?.tagName === 'INPUT'
              && String(node.getAttribute?.('type') || node.type || '').toLowerCase() === 'file'
            );
            if (!input) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            window.__wb_file_input_click_guard_last = {
              blocked: true,
              selector: uniqueFileInputSelector(input),
              ts: Date.now(),
            };
          };
          document.addEventListener('click', window.__wb_file_input_click_guard, true);
        }
        if (typeof window.__wb_file_input_show_picker_guard_restore === 'function') {
          window.__wb_file_input_show_picker_guard_restore();
        }
        if (window.__wb_file_input_show_picker_guard_timer) {
          clearTimeout(window.__wb_file_input_show_picker_guard_timer);
          window.__wb_file_input_show_picker_guard_timer = null;
        }
        const showPickerProto = window.HTMLInputElement?.prototype;
        const showPickerDescriptor = showPickerProto
          && Object.getOwnPropertyDescriptor(showPickerProto, 'showPicker');
        const originalShowPicker = showPickerDescriptor?.value;
        const ownClickDescriptor = showPickerProto
          && Object.getOwnPropertyDescriptor(showPickerProto, 'click');
        const originalClick = showPickerProto?.click;
        if (typeof originalShowPicker === 'function' || typeof originalClick === 'function') {
          const isFileInput = (input) =>
            input?.tagName === 'INPUT'
            && String(input.getAttribute?.('type') || input.type || '').toLowerCase() === 'file';
          const blockInput = (input) => {
            window.__wb_file_input_click_guard_last = {
              blocked: true,
              selector: uniqueFileInputSelector(input),
              ts: Date.now(),
            };
          };
          const guardedShowPicker = function(...args) {
            if (
              isFileInput(this)
              && Date.now() <= Number(window.__wb_file_input_click_guard_until || 0)
            ) {
              blockInput(this);
              return undefined;
            }
            return Reflect.apply(originalShowPicker, this, args);
          };
          const guardedClick = function(...args) {
            if (
              isFileInput(this)
              && Date.now() <= Number(window.__wb_file_input_click_guard_until || 0)
            ) {
              blockInput(this);
              return undefined;
            }
            return Reflect.apply(originalClick, this, args);
          };
          let showPickerInstalled = false;
          let clickInstalled = false;
          if (typeof originalShowPicker === 'function') {
            try {
              Object.defineProperty(showPickerProto, 'showPicker', {
                ...showPickerDescriptor,
                value: guardedShowPicker,
              });
              showPickerInstalled = true;
            } catch {}
          }
          if (typeof originalClick === 'function') {
            try {
              Object.defineProperty(showPickerProto, 'click', {
                configurable: true,
                enumerable: ownClickDescriptor?.enumerable ?? false,
                writable: true,
                value: guardedClick,
              });
              clickInstalled = true;
            } catch {}
          }
          if (showPickerInstalled || clickInstalled) {
            window.__wb_file_input_show_picker_guard_restore = () => {
              try {
                if (showPickerInstalled && showPickerProto.showPicker === guardedShowPicker) {
                  Object.defineProperty(showPickerProto, 'showPicker', showPickerDescriptor);
                }
              } catch {}
              try {
                if (clickInstalled && showPickerProto.click === guardedClick) {
                  if (ownClickDescriptor) {
                    Object.defineProperty(showPickerProto, 'click', ownClickDescriptor);
                  } else {
                    delete showPickerProto.click;
                  }
                }
              } catch {}
              window.__wb_file_input_show_picker_guard_restore = null;
            };
          } else {
            window.__wb_file_input_show_picker_guard_restore = null;
          }
        }
        window.__wb_file_input_click_guard_last = null;
        window.__wb_file_input_click_guard_until = Date.now() + ${ttl};
        window.__wb_file_input_show_picker_guard_timer = setTimeout(() => {
          if (Date.now() <= Number(window.__wb_file_input_click_guard_until || 0)) return;
          window.__wb_file_input_show_picker_guard_timer = null;
          window.__wb_file_input_show_picker_guard_restore?.();
        }, ${ttl} + 25);
        return true;
      })()
    `);
  }

  /**
   * Disarm the temporary file-input click guard and return any intercepted
   * chooser activation from the current agent click.
   */
  async consumeFileInputClickGuard(tabId, settleMs = 500) {
    const delayMs = Math.max(0, Number(settleMs) || 0);
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    let rendererBlocked = null;
    try {
      const result = await this.evaluate(tabId, `
        (() => {
          const blocked = window.__wb_file_input_click_guard_last || null;
          window.__wb_file_input_click_guard_last = null;
          if (blocked) {
            window.__wb_file_input_click_guard_until = 0;
            if (window.__wb_file_input_show_picker_guard_timer) {
              clearTimeout(window.__wb_file_input_show_picker_guard_timer);
              window.__wb_file_input_show_picker_guard_timer = null;
            }
            window.__wb_file_input_show_picker_guard_restore?.();
          }
          return blocked;
        })()
      `);
      rendererBlocked = result?.result?.value || null;
    } catch {
      // A delivered click may navigate or reload before this best-effort probe
      // runs, destroying its execution context. Never turn that observation
      // race into a failed click (or let clickElement retry the action); the
      // short guard TTL disarms the abandoned document automatically.
    }
    const protocolBlocked = this.fileChooserGuards.get(tabId)?.blocked || null;
    const blocked = rendererBlocked || protocolBlocked;
    // Protocol interception cancels every chooser in the tab, including a
    // user's later trusted click, so it must never outlive this observation
    // window. The narrower page-world wrapper can remain on its TTL to cover
    // delayed programmatic click()/showPicker() callbacks.
    await this._disarmProtocolFileChooserGuard(tabId);
    return blocked;
  }

  fileInputClickBlockedResult(blocked, context = '') {
    const selector = typeof blocked?.selector === 'string' && blocked.selector
      ? blocked.selector
      : null;
    const guidance = selector
      ? `Call upload_file with selector ${JSON.stringify(selector)} and the existing downloadId or absolute filePath; it attaches the file without opening an OS dialog.`
      : 'Re-inspect the page to find an exact, unique <input type=file> selector, then call upload_file directly. Do not use a generic input[type="file"] selector when the page has multiple file inputs.';
    return {
      success: false,
      dispatched: true,
      filePickerBlocked: true,
      ...(selector ? { selector } : {}),
      ...(blocked?.protocolOnly === true ? { protocolOnly: true } : {}),
      error: ['Blocked a native file chooser.', context, guidance].filter(Boolean).join(' '),
    };
  }

  /**
   * Read back the FileList attached to an <input type=file> so callers can
   * confirm a setFileInputFiles actually took effect. CDP's
   * DOM.setFileInputFiles does NOT throw on a non-existent path — it silently
   * attaches an entry whose `size` reads as 0 — so a successful command is not
   * proof the file landed. We can't tell a missing path from a genuine empty
   * file by size alone (a real .gitkeep is also 0 bytes), so we additionally
   * try to READ one byte: a non-existent path rejects (NotFoundError /
   * NotReadableError) while a real file — even an empty one — reads fine.
   * Returns an array of {name, size, type, readable}, or null if the element
   * is not a file input / could not be resolved. `readable` is true/false when
   * the probe ran, or null if it couldn't be determined.
   */
  async getFileInputFiles(tabId, objectId) {
    await this.sendCommand(tabId, 'Runtime.enable');
    const res = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
      functionDeclaration: `async function () {
        if (!this.files) return null;
        const out = [];
        for (const f of Array.from(this.files)) {
          let readable = null;
          try {
            // Read 1 byte to force the browser to actually open the file.
            // Cheap at any size; rejects only when the path is missing.
            await f.slice(0, 1).arrayBuffer();
            readable = true;
          } catch (e) {
            if (e?.code === 'page_feedback_pending') throw e;
            readable = false;
          }
          out.push({ name: f.name, size: f.size, type: f.type, readable });
        }
        return out;
      }`,
      objectId,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.value ?? null;
  }

  /**
   * Probe whether a local file path is readable, WITHOUT routing it through
   * the page's real upload widget. Many uploaders consume the file on the
   * input's `change` event and then clear or swap the <input>, so reading the
   * TARGET input back can't distinguish "consumed a valid file" from "got a
   * bad path and there was never anything real to upload".
   *
   * Create a detached probe input in an isolated world when Chrome allows it.
   * If DOM.setFileInputFiles dispatches input/change, the event path is the
   * detached element only; delegated page handlers on document, forms, or drop
   * zones cannot treat the probe as a real user upload. Returns
   * {exists, readable, size}, or null if the probe could not run. includeData
   * retains the complete-payload attachment cap unless readPrefixBytes is
   * explicitly supplied; that bounded mode reports total size and the exact
   * byte-window length/truncation without loading the rest of the file.
   */
  async probeLocalFile(tabId, filePath, options = {}) {
    let objectId = null;
    try {
      await this.sendCommand(tabId, 'DOM.enable');
      await this.sendCommand(tabId, 'Runtime.enable');

      let contextId = null;
      try {
        await this.sendCommand(tabId, 'Page.enable');
        const frameTree = await this.sendCommand(tabId, 'Page.getFrameTree');
        const frameId = frameTree?.frameTree?.frame?.id;
        if (frameId) {
          const isolated = await this.sendCommand(tabId, 'Page.createIsolatedWorld', {
            frameId,
            worldName: 'webbrain-upload-probe',
            grantUniveralAccess: false,
          });
          contextId = isolated?.executionContextId || null;
        }
      } catch (e) {
        if (e?.code === 'page_feedback_pending') throw e;
        contextId = null;
      }

      // A protected conversation's file bytes must come from a detached
      // native input in an isolated realm. Do not fall back to page globals.
      if (options.includeData === true && !contextId) return null;

      const created = await this.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `(() => {
          const i = document.createElement('input');
          i.type = 'file';
          i.setAttribute('data-wb-upload-probe', '');
          return i;
        })()`,
        ...(contextId ? { contextId } : {}),
      });
      objectId = created?.result?.objectId || null;
      if (!objectId) return null;
      await this.sendCommand(tabId, 'DOM.setFileInputFiles', { objectId, files: [filePath] });
      const res = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
        functionDeclaration: `async function (includeData, maxBytes, prefixBytes) {
          const f = this.files && this.files[0];
          if (!f) return { exists: false, readable: null, size: 0 };
          let readable = null;
          try { await (f.size === 0 ? f : f.slice(0, 1)).arrayBuffer(); readable = true; }
          catch (e) { readable = false; }
          if (!includeData || !readable) return { exists: true, readable, size: f.size };
          if (!prefixBytes && f.size > maxBytes) return { exists: true, readable: false, size: f.size,
            error: 'Recipient-bound attachment exceeds the 25MB limit.' };
          try {
            const bytes = new Uint8Array(await (prefixBytes ? f.slice(0, prefixBytes) : f).arrayBuffer());
            if (bytes.length > maxBytes) return { exists: true, readable: false, size: bytes.length,
              error: 'Recipient-bound attachment exceeds the 25MB limit.' };
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            return { exists: true, readable: true, size: prefixBytes ? f.size : bytes.length,
              base64: btoa(binary), filename: f.name, mimeType: f.type, lastModified: f.lastModified,
              ...(prefixBytes ? { dataBytesRead: bytes.length, dataTruncated: bytes.length < f.size } : {}) };
          } catch { return { exists: true, readable: false, size: f.size }; }
        }`,
        objectId,
        arguments: [
          { value: options.includeData === true },
          { value: Math.min(25 * 1024 * 1024, Math.max(0, Number(options.maxBytes) || 25 * 1024 * 1024)) },
          { value: Math.min(25 * 1024 * 1024, Math.max(0, Number(options.maxBytes) || 25 * 1024 * 1024),
            Math.max(0, Math.floor(Number(options.readPrefixBytes) || 0))) },
        ],
        returnByValue: true,
        awaitPromise: true,
      });
      return res?.result?.value ?? null;
    } catch (e) {
      if (e?.code === 'page_feedback_pending') throw e;
      return null;
    } finally {
      if (objectId) {
        this.releaseObject(tabId, objectId);
      }
    }
  }

  /**
   * Dispatch mouse event.
   */
  async dispatchMouseEvent(tabId, type, x, y, button = 'left', options = {}) {
    // Use string button names as required by CDP Input.dispatchMouseEvent.
    // 'buttons' is a bitmask: 1 = left held. clickCount must be 1 on BOTH
    // mousePressed AND mouseReleased for the browser to synthesize a 'click'
    // DOM event — without it, React and other frameworks never see the click.
    const isDown = type === 'mousePressed';
    const isMove = type === 'mouseMoved';
    return await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: isMove ? 'none' : button,
      buttons: isDown ? 1 : 0,
      clickCount: isMove ? 0 : 1,
    }, '', options);
  }

  /**
   * Dispatch key event.
   */
  async dispatchKeyEvent(tabId, type, key, text = '') {
    return await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type,
      key,
      text: text || key,
    });
  }

  /**
   * Get download directory.
   */
  async getDownloadPath(tabId) {
    const result = await this.evaluate(tabId, `
      (async () => {
        if (chrome.downloads) {
          const search = () => new Promise(r => chrome.downloads.search({ exists: true, limit: 1 }, r));
          const downloads = await search();
          return downloads[0]?.filename || 'downloads/';
        }
        return 'downloads/';
      })()
    `);
    return result?.result?.value || 'downloads/';
  }

  /**
   * Handle file download via CDP.
   */
  async downloadFile(tabId, url, filename) {
    filename = await filenameInConfiguredDownloadDirectory(chrome, filename);
    return new Promise(async (resolve, reject) => {
      const downloadId = await new Promise((res) => {
        chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          res(id);
        });
      });

      chrome.downloads.onChanged.addListener(function onChanged(delta) {
        if (delta.id === downloadId) {
          if (delta.state?.current === 'complete') {
            chrome.downloads.search({ id: downloadId }, (items) => {
              chrome.downloads.onChanged.removeListener(onChanged);
              resolve({ success: true, filename: items[0]?.filename, id: downloadId });
            });
          } else if (delta.error) {
            chrome.downloads.onChanged.removeListener(onChanged);
            reject(new Error(delta.error));
          }
        }
      });
    });
  }

  /**
   * Get node attributes.
   */
  async getNodeAttributes(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    const result = await this.sendCommand(tabId, 'DOM.getAttributes', { nodeId });
    const attrs = {};
    for (let i = 0; i < result.attributes.length; i += 2) {
      attrs[result.attributes[i]] = result.attributes[i + 1];
    }
    return attrs;
  }

  /**
   * Traverse shadow DOM and collect elements.
   */
  async traverseShadowDOM(tabId, rootNodeId = null) {
    await this.sendCommand(tabId, 'DOM.enable');
    
    if (!rootNodeId) {
      const doc = await this.sendCommand(tabId, 'DOM.getDocument', { depth: 0 });
      rootNodeId = doc.root?.nodeId;
    }

    const result = await this.sendCommand(tabId, 'DOM.querySelectorAll', {
      nodeId: rootNodeId,
      selector: '*',
      piercesShadowDom: true,
    });

    const elements = [];
    for (const nodeId of result.nodeIds || []) {
      try {
        const desc = await this.sendCommand(tabId, 'DOM.describeNode', { nodeId });
        if (desc.node) {
          elements.push({
            nodeId,
            nodeName: desc.node.nodeName,
            backendNodeId: desc.node.backendNodeId,
            isShadowHost: desc.node.shadowRoots?.length > 0,
            shadowRootCount: desc.node.shadowRoots?.length || 0,
          });
        }
      } catch {
        // Skip inaccessible nodes
      }
    }

    return elements;
  }

  /**
   * Get inner text from a node.
   */
  async getNodeInnerText(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'DOM.requestChildNodes', { nodeId, depth: 1 });

    const result = await this.evaluate(tabId, `
      (() => {
        const node = window.webbrain_getNodeById(${nodeId});
        return node ? node.innerText : null;
      })()
    `).catch(() => null);

    return result?.result?.value || '';
  }

  /**
   * Highlight element with an overlay.
   */
  async highlightNode(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    const boxModel = await this.sendCommand(tabId, 'DOM.getBoxModel', { nodeId });
    if (!boxModel?.model) return null;

    const quad = boxModel.model.content;
    await this.sendCommand(tabId, 'Overlay.enable');
    await this.sendCommand(tabId, 'Overlay.highlightQuad', {
      quad,
      color: { r: 0, g: 200, b: 255, a: 0.3 },
      outlineColor: { r: 0, g: 100, b: 200, a: 1 },
    });

    return { success: true };
  }

  /**
   * Hide highlight overlay.
   */
  async hideHighlight(tabId) {
    try {
      await this.sendCommand(tabId, 'Overlay.hideHighlight');
    } catch {
      // Ignore if already hidden
    }
  }

  /**
   * Get all interactive elements with full DOM access.
   */
  async getInteractiveElements(tabId) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'DOM.getDocument', { depth: -1, pierce: true });

    // NOTE: this logic is intentionally kept in sync with
    // src/chrome/src/content/content.js (queryInteractive +
    // isVisiblyInteractive). If you change one, change the other —
    // index N from this function must map to the same element as
    // index N in the content-script fallback path, otherwise
    // click({index})/type_text({index}) will target the wrong node
    // on pages where the two paths race (shadow DOM, overlays, etc.).
    const result = await this.evaluate(tabId, `
      (() => {
        const hostname = String(location.hostname || '').toLowerCase().replace(/\\.$/, '');
        const onHost = (domain) => hostname === domain || hostname.endsWith('.' + domain);
        const SITE_RULES = onHost('bilibili.com') ? [
          ['.video-like', '点赞'], ['.video-coin', '投币'],
          ['.video-fav', '收藏'], ['.video-share', '分享'],
          ['.follow-btn', '关注'], ['.bpx-player-follow', '关注'],
          ['.reply-box-send', '发布评论'],
        ] : onHost('xiaohongshu.com') ? [
          ['.like-wrapper', '点赞'], ['.collect-wrapper', '收藏'],
          ['.chat-wrapper', '评论'], ['.share-wrapper', '分享'],
          ['.follow-wrapper', '关注'], ['.follow-btn', '关注'],
          ['.follow-button', '关注'], ['.send-btn', '发布评论'],
          ['.publish-btn', '发布'], ['.publish-button', '发布'],
        ] : onHost('tieba.baidu.com') ? [
          ['.pc-pb-first-floor-interactive .action-item', '转发', '#share_pb'],
          ['.pc-pb-first-floor-interactive .action-item', '点赞', '#agree_pb'],
          ['.pc-pb-first-floor-interactive .action-item', '收藏', '#collect'],
          ['.pc-pb-first-floor-interactive .more-action', '更多', '#ellipsis'],
          ['.pc-pb-comments-desc .zan-container-dark', '赞', '#agree_comment'],
          ['.pc-pb-comments-desc .reply-container', '回复', '#comment_comment'],
          ['.pc-pb-comments-desc .more-action', '更多', '#ellipsis_comment'],
          ['.follow-person-btn', '关注楼主'],
          ['.follow-forum-btn', '关注本吧'],
          ['.pc-pb-reply-box', '回复'],
          ['.pc-pb-reply-box .publish-btn', '发布'],
        ] : [];
        const NATIVE_SELECTORS = [
          'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
          '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
          '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
          '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
          '[onclick]', '[data-action]', 'summary', 'label'
        ];
        const SELECTORS = [...NATIVE_SELECTORS, ...SITE_RULES.map(([selector]) => selector)];

        function matchesSiteRule(el, [selector, , iconHref]) {
          try {
            if (!el.matches(selector)) return false;
          } catch (e) {
            if (e?.code === 'page_feedback_pending') throw e;
            return false;
          }
          if (!iconHref) return true;
          return Array.from(el.querySelectorAll('use')).some((use) => (
            use.getAttribute('href') === iconHref
            || use.getAttribute('xlink:href') === iconHref
          ));
        }

        function matchesAnySiteSelector(el) {
          return SITE_RULES.some(([selector]) => {
            try {
              return el.matches(selector);
            } catch (e) {
              if (e?.code === 'page_feedback_pending') throw e;
              return false;
            }
          });
        }

        function matchesNativeInteractive(el) {
          return NATIVE_SELECTORS.some((selector) => {
            try {
              return el.matches(selector);
            } catch (e) {
              if (e?.code === 'page_feedback_pending') throw e;
              return false;
            }
          });
        }

        function interactiveText(el) {
          for (const rule of SITE_RULES) {
            const [selector, label] = rule;
            try {
              if (!matchesSiteRule(el, rule)) continue;
            } catch (e) {
              if (e?.code === 'page_feedback_pending') throw e;
              continue;
            }
            const explicit = String(el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
            const rendered = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
            return explicit || (rendered && rendered.includes(label) ? rendered : rendered ? label + ' ' + rendered : label);
          }
          return (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim();
        }

        function isVisiblyInteractive(el) {
          if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') return false;
          if (el.closest('[aria-hidden="true"], [inert]')) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
          // Styled-wrapper: real input is 0x0 but a visible label/wrapper exists.
          const tag = el.tagName;
          if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
            if (el.id) {
              try {
                const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
                if (lab) {
                  const lr = lab.getBoundingClientRect();
                  if (lr.width > 0 && lr.height > 0) return true;
                }
              } catch (e) {}
            }
            let p = el.parentElement;
            for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
              const pr = p.getBoundingClientRect();
              if (pr.width > 0 && pr.height > 0) return true;
            }
          }
          return false;
        }

        const elements = [];
        const all = document.querySelectorAll(SELECTORS.join(', '));
        let index = 0;
        all.forEach((el) => {
          if (!isVisiblyInteractive(el)) return;
          if (!matchesNativeInteractive(el) && matchesAnySiteSelector(el) && !SITE_RULES.some(rule => matchesSiteRule(el, rule))) return;
          const rect = el.getBoundingClientRect();
          elements.push({
            index: index++,
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            role: el.getAttribute('role') || '',
            text: interactiveText(el).slice(0, 100),
            id: el.id || '',
            name: el.name || '',
            href: el.href || '',
            editable: el.isContentEditable || false,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            isInShadowDOM: el.getRootNode() !== document,
          });
        });
        return elements;
      })()
    `);

    return result?.result?.value || [];
  }

  /**
   * Read page content with full DOM access.
   *
   * Mirrors `getPageInfoFull` in content.js — article-priority selectors,
   * nav/footer/aside/ads stripped inside the chosen container, and a
   * `textSource` / `isArticlePage` hint so the model can recognize when
   * it has the complete article body and stop chasing more.
   *
   * Pass `{ includeChrome: true }` to opt out of stripping (e.g. when the
   * user is asking about the nav, footer, cookie banner, etc.).
   */
  // `opts.pageBlockerReadings` are the agent's page_blocker readings by text:
  // an overlay or article block counts as a wall only once its text was read
  // as one, in any language; texts nobody has read come back in
  // `pageTextsNeeded` (see detectPageGate in content.js).
  async readPage(tabId, opts = {}) {
    const includeChrome = !!opts.includeChrome;
    const pageBlockerReadings = opts.pageBlockerReadings && typeof opts.pageBlockerReadings === 'object'
      ? opts.pageBlockerReadings : {};
    const pageInfo = await this.evaluate(tabId, `
      ((includeChrome, pageBlockerReadings) => {
        const ARTICLE_SELECTORS = [
          '[itemprop="articleBody"]',
          'article [class*="article-body" i]',
          'article [class*="article__content" i]',
          'article [class*="article__body" i]',
          'article [class*="story-body" i]',
          'article [class*="post-content" i]',
          'article [class*="entry-content" i]',
          '[role="article"]',
          'article',
          'main article',
          '.article-body, .article__body, .article__content',
          '.post-content, .entry-content, .story-body, .story-content',
          'main',
          '[role="main"]',
          '.content',
          '#content',
        ];
        const CHROME_DROP_SELECTORS = [
          'nav', 'header', 'footer', 'aside',
          '[role="navigation"]', '[role="banner"]',
          '[role="contentinfo"]', '[role="complementary"]',
          'script', 'style', 'noscript', 'iframe', 'svg',
          '[aria-hidden="true"]',
          '[class*="advertisement" i]', '[class*="ad-slot" i]',
          '[class*="ad-container" i]',
          '[class*="newsletter" i][class*="signup" i]',
          '[class*="newsletter-promo" i]',
          '[class*="social-share" i]', '[class*="share-tools" i]',
          '[class*="related-articles" i]', '[class*="recommended" i]',
          '[class*="more-stories" i]', '[class*="paid-content" i]',
          '[class*="cookie-banner" i]', '[id*="cookie-banner" i]',
          '[class*="onetrust" i]',
        ];
        const PAGE_GATE_SELECTORS = [
          '[role="dialog"]', '[role="alertdialog"]', 'dialog[open]', '[aria-modal="true"]',
          '[class*="paywall" i]', '[id*="paywall" i]', '[class*="gateway" i]', '[id*="gateway" i]',
          '[class*="regiwall" i]', '[id*="regiwall" i]', '[class*="subscription" i]', '[id*="subscription" i]',
          '[data-testid*="paywall" i]', '[data-testid*="gateway" i]', '[data-testid*="subscription" i]', '[data-testid*="registration" i]',
        ];
        const gateElementIsRendered = (el) => {
          if (!el || !el.isConnected) return false;
          try {
            const rect = el.getBoundingClientRect();
            for (let node = el; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
              if (Number.parseFloat(style.opacity || '1') <= 0.01) return false;
              if (node.getAttribute?.('aria-hidden') === 'true') return false;
            }
            return rect.width >= 20 && rect.height >= 20;
          } catch (e) { return false; }
        };
        const pageHasArticleContext = () => {
          try {
            return !!(
              document.querySelector('meta[property="og:type"][content="article"]') ||
              document.querySelector('meta[name="article:published_time"]') ||
              document.querySelector('[itemtype*="Article" i]') ||
              document.querySelector('article, [role="article"]')
            );
          } catch (e) { return false; }
        };
        // The page-gate check of content.js, mirrored: texts keyed as the
        // readings key them, a block read in chunks in page order up to its
        // first wall, a block's wall starting at that chunk or at an unread
        // chunk before it, and the likeliest walls read first.
        const GATE_TEXT_LIMIT = 600;
        const GATE_TYPES = ['subscription', 'registration', 'login'];
        const unreadGateTexts = [];
        const gateNormalize = (value) => String(value ?? '').replace(/[\\u200b-\\u200d\\ufeff]/g, '').replace(/\\s+/g, ' ').trim();
        const gateSlice = (value) => gateNormalize(gateNormalize(value).slice(0, GATE_TEXT_LIMIT)
          .replace(/^[\\udc00-\\udfff]/, '').replace(/[\\ud800-\\udbff]$/, ''));
        // A text that differs only in its numbers from texts read as one
        // wall, such as a countdown's next second, is that wall, as in
        // content.js: at once, and still reported to be read until two texts
        // of its shape were read as that wall. Readings of texts with digits
        // by the text with each run of digits as one '#'; a shape with any
        // other reading carries nothing over.
        const gateDigitShape = (text) => (/\\p{Nd}/u.test(text) ? text.replace(/\\p{Nd}+/gu, '#') : '');
        const gateShapes = new Map();
        for (const [text, choice] of Object.entries(pageBlockerReadings)) {
          const shape = gateDigitShape(gateNormalize(text));
          if (!shape) continue;
          const entry = gateShapes.get(shape) || { choice: '', walls: 0, mixed: false };
          if (!GATE_TYPES.includes(choice) || (entry.choice && entry.choice !== choice)) entry.mixed = true;
          else { entry.choice = choice; entry.walls += 1; }
          gateShapes.set(shape, entry);
        }
        const gateReading = (text) => {
          if (!text) return 'other';
          const reading = Object.prototype.hasOwnProperty.call(pageBlockerReadings, text) ? String(pageBlockerReadings[text] || '') : '';
          if (reading) return GATE_TYPES.includes(reading) ? reading : 'other';
          const shaped = gateShapes.get(gateDigitShape(text));
          const wall = shaped && !shaped.mixed && shaped.walls > 0 ? shaped.choice : null;
          if (wall && shaped.walls >= 2) return wall;
          const provisional = wall;
          if (!unreadGateTexts.includes(text)) {
            if (unreadGateTexts.length >= 40) return provisional;
            unreadGateTexts.push(text);
          }
          return provisional;
        };
        const gateHasBlockChildren = (el, depth = 0) => {
          for (const child of el.children) {
            let display = '';
            try { display = getComputedStyle(child).display; } catch (e) { continue; }
            if (display === 'contents') {
              if (depth < 20 && gateHasBlockChildren(child, depth + 1)) return true;
              continue;
            }
            if (display && display !== 'none' && !display.startsWith('inline')) return true;
          }
          return false;
        };
        const gateParts = (el) => {
          const parts = [];
          const firstLine = value => gateNormalize(String(value || '').split('\\n').find(line => line.trim()) || '');
          const visit = (node, depth) => {
            for (const child of node.childNodes) {
              if (parts.length >= 600) return;
              if (child.nodeType === Node.TEXT_NODE) {
                const value = gateNormalize(child.data);
                if (value) parts.push({ text: value, line: value, element: node, heading: false });
                continue;
              }
              if (child.nodeType !== Node.ELEMENT_NODE || /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(child.tagName)) continue;
              let display = '';
              try { display = getComputedStyle(child).display; } catch (e) {}
              if (display === 'none') continue;
              if (display === 'contents') {
                if (depth < 40) visit(child, depth + 1);
                continue;
              }
              if (!child.getClientRects?.().length) continue;
              const raw = String(child.innerText || '');
              const value = gateNormalize(raw);
              if (!value) continue;
              if (value.length <= GATE_TEXT_LIMIT || depth >= 40 || !gateHasBlockChildren(child)) {
                parts.push({ text: value, line: firstLine(raw), element: child,
                  heading: child.matches?.('h1, h2, h3, h4, h5, h6, [role="heading"]') === true });
              } else {
                visit(child, depth + 1);
              }
            }
          };
          visit(el, 0);
          return parts;
        };
        const gateChunks = (parts) => {
          const chunks = [];
          for (const part of parts) {
            if (part.text.length > GATE_TEXT_LIMIT) {
              for (let offset = 0; offset < part.text.length && chunks.length < 1000; offset += GATE_TEXT_LIMIT) {
                chunks.push({ text: part.text.slice(offset, offset + GATE_TEXT_LIMIT), element: part.element,
                  line: offset ? '' : part.line, closed: true });
              }
              continue;
            }
            const last = chunks[chunks.length - 1];
            if (last && !last.closed && !part.heading && last.text.length + 1 + part.text.length <= GATE_TEXT_LIMIT) {
              last.text += ' ' + part.text;
            } else {
              chunks.push({ text: part.text, element: part.element, line: part.line, closed: false });
            }
          }
          return chunks.map(chunk => ({ ...chunk, text: gateSlice(chunk.text) }));
        };
        const gateWall = (el, inline) => {
          const named = [...new Set([el.getAttribute('aria-label'), el.getAttribute('title')].map(gateSlice))].filter(Boolean);
          const namedReadings = named.map(gateReading);
          const namedIndex = namedReadings.findIndex(reading => GATE_TYPES.includes(reading));
          const chunks = gateChunks(gateParts(el)).slice(0, 30);
          let wallIndex = -1, unread = -1, wallType = null;
          for (let index = 0; index < chunks.length; index += 1) {
            const reading = gateReading(chunks[index].text);
            if (GATE_TYPES.includes(reading)) {
              wallIndex = index;
              wallType = reading;
              break;
            }
            if (reading === null && unread < 0) unread = index;
          }
          if (wallIndex < 0 && namedIndex < 0) return null;
          const type = namedIndex >= 0 ? namedReadings[namedIndex] : wallType;
          const label = value => gateSlice(String(value || '').slice(0, 240));
          if (namedIndex >= 0) return { type, label: label(named[namedIndex]), element: el };
          if (!inline) return { type, label: label(chunks[wallIndex].line), element: el };
          const start = unread >= 0 && unread < wallIndex ? unread : wallIndex;
          return {
            type,
            label: start === wallIndex ? label(chunks[wallIndex].line) : '',
            element: start === 0 ? el : chunks[start].element,
          };
        };
        const gateOffersControl = (el) => {
          try {
            if (el.querySelector('button, input, select, textarea, form, [role="button"]')) return true;
            return Array.from(el.querySelectorAll('a[href]')).slice(0, 50)
              .some(link => !link.closest('p, li, blockquote, figcaption, td, dd'));
          } catch (e) {
            return false;
          }
        };
        const detectPageGate = () => {
          const seen = new Set();
          const found = [];
          const articleContext = pageHasArticleContext();
          for (const selector of PAGE_GATE_SELECTORS) {
            let matches = [];
            try { matches = document.querySelectorAll(selector); } catch (e) { continue; }
            for (const el of matches) {
              if (seen.has(el) || !gateElementIsRendered(el)) continue;
              seen.add(el);
              const role = String(el.getAttribute('role') || '').toLowerCase();
              let surface = (role === 'dialog' || role === 'alertdialog' || el.tagName === 'DIALOG' || el.getAttribute('aria-modal') === 'true') ? 'dialog' : 'inline';
              const inArticle = !!el.closest('article, [role="article"], main, [role="main"]');
              let coveringOverlay = false;
              try {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
                const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
                const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
                coveringOverlay = ['fixed', 'sticky', 'absolute'].includes(style.position) && ((visibleWidth * visibleHeight) / viewportArea) >= 0.2;
              } catch (e) {}
              if (coveringOverlay) surface = 'dialog';
              if (surface === 'dialog' ? !articleContext : !inArticle) continue;
              found.push({ el, surface, inArticle, coveringOverlay, offersControl: gateOffersControl(el) });
            }
          }
          found.sort((a, b) => (Number(b.surface === 'dialog') - Number(a.surface === 'dialog'))
            || (Number(b.offersControl) - Number(a.offersControl))
            || (a.el === b.el ? 0 : (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)));
          const candidates = [];
          for (const { el, surface, inArticle, coveringOverlay } of found) {
            const wall = gateWall(el, surface === 'inline');
            if (!wall) continue;
            const label = wall.label;
            const namedGate = /paywall|gateway|regiwall|subscription|registration/i.test([el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('data-testid') || ''].join(' '));
            const score = (surface === 'dialog' ? 100 : 0) + (inArticle ? 40 : 0) + (coveringOverlay ? 30 : 0) + (namedGate ? 15 : 0) - Math.min(label.length, 2000) / 2000;
            candidates.push({ element: wall.element, type: wall.type, surface, label, score });
          }
          const overlays = candidates.filter(candidate => candidate.surface === 'dialog').sort((a, b) => b.score - a.score);
          if (overlays.length) return overlays[0];
          const blocks = candidates.filter(candidate => candidate.surface === 'inline');
          blocks.sort((a, b) => (a.element === b.element ? 0 : (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)));
          return blocks[0] || null;
        };
        const textBeforeGate = (root, gateElement) => {
          if (!root || !gateElement || !root.contains(gateElement)) return '';
          const blocks = [];
          const seenText = new Set();
          let nodes = [];
          try { nodes = root.querySelectorAll('h1, h2, h3, p, li, blockquote, figcaption'); } catch (e) { return ''; }
          for (const node of nodes) {
            if (node === gateElement || gateElement.contains(node) || node.contains(gateElement)) continue;
            if (!(node.compareDocumentPosition(gateElement) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
            if (!gateElementIsRendered(node) || node.closest('nav, header, footer, aside, [aria-hidden="true"]')) continue;
            const value = String(node.innerText || '').replace(/\\s+/g, ' ').trim();
            if (!value || seenText.has(value)) continue;
            seenText.add(value);
            blocks.push(value);
          }
          return blocks.join('\\n\\n').trim();
        };
        const getVisibleLayers = () => {
          const selectors = [
            'header', 'nav', '[role="banner"]', '[role="navigation"]',
            '[role="toolbar"]', '[class*="toolbar" i]',
            '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
            'dialog[open]', '.modal.show', '[class*="DialogContent"]', '[class*="ModalContent"]',
            '[data-overlay]', '[class*="overlay" i]', '[class*="popover" i]', '[class*="drawer" i]',
          ].join(',');
          const layers = [];
          let candidates = [];
          try { candidates = Array.from(document.querySelectorAll(selectors)); } catch (e) { return []; }
          const dialogSelector = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],.modal.show,[class*="DialogContent"],[class*="ModalContent"]';
          // Preserve the active dialog even when the page has many fixed nav items.
          candidates.sort((a, b) => Number(b.matches(dialogSelector)) - Number(a.matches(dialogSelector)));
          for (const el of candidates) {
            if (layers.length >= 4) break;
            try {
              if (!gateElementIsRendered(el)) continue;
              const style = getComputedStyle(el);
              if (!['fixed', 'sticky', 'absolute'].includes(style.position) && !(el.tagName === 'DIALOG' && el.open)) continue;
              const r = el.getBoundingClientRect();
              const left = Math.max(0, r.left), right = Math.min(window.innerWidth, r.right);
              const top = Math.max(0, r.top), bottom = Math.min(window.innerHeight, r.bottom);
              if (right - left < 10 || bottom - top < 10) continue;
              if (layers.some(layer => layer.element.contains(el) || el.contains(layer.element))) continue;
              const text = String(el.innerText || el.getAttribute('aria-label') || '')
                .replace(/\\s+/g, ' ').trim().slice(0, 240);
              if (!text) continue;
              const points = [
                [(left + right) / 2, (top + bottom) / 2],
                [left + (right - left) * 0.2, top + (bottom - top) * 0.2],
                [right - (right - left) * 0.2, bottom - (bottom - top) * 0.2],
              ];
              if (!points.some(([x, y]) => {
                const hit = document.elementFromPoint(x, y);
                return hit === el || el.contains(hit);
              })) continue;
              layers.push({
                element: el,
                role: (el.getAttribute('role') || el.tagName.toLowerCase()).slice(0, 80),
                text,
                position: style.position,
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              });
            } catch (e) { /* ignore malformed or changing page surfaces */ }
          }
          return layers.map(({ element, ...layer }) => layer);
        };
        const stripChrome = (root) => {
          if (includeChrome || !root) return root;
          let clone;
          try { clone = root.cloneNode(true); } catch (e) { return root; }
          for (const sel of CHROME_DROP_SELECTORS) {
            try { clone.querySelectorAll(sel).forEach(n => n.remove()); } catch (e) {}
          }
          return clone;
        };
        let textSource = 'body';
        let isArticlePage = false;
        try {
          isArticlePage = !!(
            document.querySelector('meta[property="og:type"][content="article"]') ||
            document.querySelector('meta[name="article:published_time"]') ||
            document.querySelector('[itemtype*="Article" i]') ||
            document.querySelector('article')
          );
        } catch (e) {}
        const gate = detectPageGate();
        const pageGate = gate ? { type: gate.type, blocking: true, surface: gate.surface, label: gate.label } : null;
        const getText = () => {
          if (gate?.surface === 'dialog') {
            textSource = 'page-gate';
            return gate.label;
          }
          if (gate?.surface === 'inline') {
            const articleRoot = gate.element.closest('article, [role="article"], main, [role="main"]');
            textSource = 'article (pre-gate)';
            return textBeforeGate(articleRoot, gate.element) || gate.label;
          }
          for (const sel of ARTICLE_SELECTORS) {
            let el;
            try { el = document.querySelector(sel); } catch (e) { continue; }
            if (!el) continue;
            const cleaned = stripChrome(el);
            const txt = (cleaned && cleaned.innerText ? cleaned.innerText : '').trim();
            if (txt.length > 300) { textSource = sel; return txt; }
          }
          const fallback = stripChrome(document.body);
          textSource = includeChrome ? 'body (raw)' : 'body (chrome-stripped)';
          return (fallback && fallback.innerText ? fallback.innerText : '').trim();
        };

        const text = getText();
        const blockedAuxiliaryContent = pageGate?.blocking === true;
        return {
          url: window.location.href,
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.content || '',
          ...(pageGate ? { pageGate } : {}),
          ...(unreadGateTexts.length ? { pageTextsNeeded: unreadGateTexts.map(text => ({ kind: 'page_blocker', text })) } : {}),
          text,
          textSource,
          isArticlePage,
          includeChrome,
          visibleLayers: blockedAuxiliaryContent ? [] : getVisibleLayers(),
          links: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
            text: a.innerText.trim().slice(0, 100),
            href: a.href,
          })),
          forms: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('form')).map((form, i) => ({
            id: form.id || 'form-' + i,
            action: form.action,
            inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(el => ({
              type: el.type || el.tagName.toLowerCase(),
              name: el.name,
              id: el.id,
              placeholder: el.placeholder || '',
              value: el.value || '',
            })),
          })),
          shadowHosts: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot).map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            shadowRootMode: el.shadowRoot?.mode,
          })),
          iframes: blockedAuxiliaryContent ? [] : Array.from(document.querySelectorAll('iframe')).map(iframe => ({
            src: iframe.src,
            id: iframe.id || '',
            name: iframe.name || '',
            visible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0,
          })),
        };
      })(${JSON.stringify(includeChrome)}, ${JSON.stringify(pageBlockerReadings)})
    `);

    return pageInfo?.result?.value || pageInfo;
  }

  /**
   * Resolve a CSS selector to viewport-center coordinates and a backend nodeId.
   *
   * Tries three strategies in order:
   *   1. JS walker piercing OPEN shadow roots via Runtime.evaluate (fastest,
   *      handles 99% of real pages including Web Components).
   *   2. CDP DOM-tree traversal with `pierce: true`, which sees CLOSED shadow
   *      roots too. We collect every shadow-root nodeId in the document and
   *      run `DOM.querySelector` against each one until something matches.
   *   3. Returns null if nothing matched.
   *
   * Returns: { nodeId?, x, y, width, height, inViewport, hitOk, tag, text } or null.
   */
  _selectorActionDeadline(options = {}) {
    const abortSignal = options?.abortSignal || null;
    const deadlineAt = Number(options?.deadlineAt) || 0;
    const deadlineError = options?.deadlineError instanceof Error
      ? options.deadlineError
      : null;
    const expired = () => abortSignal?.aborted || (deadlineAt > 0 && Date.now() >= deadlineAt);
    const throwIfExpired = (force = false) => {
      if (!force && !expired()) return;
      if (abortSignal?.reason instanceof Error) throw abortSignal.reason;
      if (deadlineError) throw deadlineError;
      const error = new Error('Selector resolution was aborted.');
      error.name = 'AbortError';
      throw error;
    };
    return { abortSignal, deadlineAt, expired, throwIfExpired };
  }

  async resolveSelector(tabId, selector, options = {}) {
    const deadline = this._selectorActionDeadline(options);
    deadline.throwIfExpired();
    // Retry the resolution a few times so we tolerate elements that get
    // attached asynchronously after a click (framework hydration, dynamic
    // shadow root attachment, modal/menu open animations). Each attempt is
    // a fresh DOM walk + fresh CDP DOM.getDocument, so any newly attached
    // shadow root becomes visible on the next try.
    //
    // If a SPA navigation just happened on this tab, the new route is
    // probably still hydrating — extend the retry window so we wait through
    // the framework re-render instead of failing fast. background.js writes
    // to globalThis.__webbrainLastNav via chrome.webNavigation listeners.
    let retries = options.retries ?? 3;
    let delayMs = options.delayMs ?? 200;
    try {
      const navMap = globalThis.__webbrainLastNav;
      const last = navMap?.get(tabId);
      if (last && Date.now() - last.ts < 4000) {
        // Recent nav: give it ~3 seconds total (10 × 300ms).
        retries = Math.max(retries, 10);
        delayMs = Math.max(delayMs, 300);
      }
    } catch (e) { /* ignore */ }

    let lastResult = null;
    for (let i = 0; i <= retries; i++) {
      deadline.throwIfExpired();
      const result = await this._resolveSelectorOnce(tabId, selector, options);
      deadline.throwIfExpired();
      // Found and usable → done.
      if (result && result.found && (result.inViewport || result.nodeId)) {
        return result;
      }
      // Hard error from invalid selector — no point retrying.
      if (result && result.error) return result;
      lastResult = result;
      if (i < retries) {
        await new Promise(r => setTimeout(r, delayMs));
        deadline.throwIfExpired();
      }
    }
    return lastResult;
  }

  /**
   * Resolve a selector through the exact open/closed-shadow path used by
   * typeText(), then inspect that resolved element without dispatching input.
   * The content-script probe cannot see closed shadow roots, so selector-based
   * type_text preflight must live beside the trusted CDP resolver.
   */
  async probeRichTextToolbarSelector(tabId, selector, options = {}) {
    const deadline = this._selectorActionDeadline(options);
    deadline.throwIfExpired();
    if (typeof selector !== 'string' || !selector.trim()) return { resolved: false };
    const info = await this.resolveSelector(tabId, selector, options);
    deadline.throwIfExpired();
    if (!info) return { resolved: false };
    if (info.error) return { resolved: false, error: info.error };

    let objectId = null;
    let objectGroup = null;
    let releaseObject = false;
    try {
      if (info.nodeId) {
        await this.sendCommand(tabId, 'DOM.enable');
        deadline.throwIfExpired();
        const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: info.nodeId });
        deadline.throwIfExpired();
        objectId = resolved?.object?.objectId || null;
        releaseObject = !!objectId;
      } else {
        const pierced = await this.querySelectorPierce(tabId, selector);
        objectId = pierced?.objectIds?.[0] || null;
        objectGroup = pierced?.objectGroup || null;
      }
      if (!objectId) return { resolved: false };

      await this.sendCommand(tabId, 'DOM.enable');
      deadline.throwIfExpired();
      const described = await this.sendCommand(tabId, 'DOM.describeNode', { objectId }).catch(() => null);
      deadline.throwIfExpired();
      const selectorBackendNodeId = Number(described?.node?.backendNodeId) || null;
      if (!selectorBackendNodeId) return { resolved: false };

      const heuristicSource = await CDPClient._richTextToolbarHeuristicSource();
      deadline.throwIfExpired();
      if (!heuristicSource.trim()) {
        return {
          resolved: false,
          error: 'The packaged rich-text toolbar classifier could not be loaded.',
        };
      }
      const heuristicPrelude = heuristicSource
        ? `
          const __wbInstallRichTextToolbarHeuristicGlobal = false;
          ${heuristicSource}
          const __wbTrustedRichTextToolbarHeuristic = __wbRichTextToolbarHeuristic;
        `
        : 'const __wbTrustedRichTextToolbarHeuristic = null;';
      const inspected = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        awaitPromise: true,
        functionDeclaration: `async function (actionDeadlineAt) {
          ${heuristicPrelude}
          const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
          if (deadlineExpired()) return { deadlineExpired: true };
          const el = this;
          if (!el || el.nodeType !== 1 || !el.isConnected) return null;
          const settledRect = async (shouldScroll) => {
            if (shouldScroll) {
              if (deadlineExpired()) return { __deadlineExpired: true };
              try {
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              } catch {
                try { el.scrollIntoView(); } catch {}
              }
            }
            let previous = el.getBoundingClientRect();
            let stableFrames = 0;
            const deadline = performance.now() + 750;
            while (stableFrames < 2 && performance.now() < deadline) {
              await new Promise(resolve => {
                let finished = false;
                const finish = () => {
                  if (finished) return;
                  finished = true;
                  resolve();
                };
                setTimeout(finish, 40);
                try { requestAnimationFrame(finish); } catch {}
              });
              if (deadlineExpired()) return { __deadlineExpired: true };
              if (!el.isConnected) return null;
              const next = el.getBoundingClientRect();
              const delta = Math.max(
                Math.abs(next.x - previous.x),
                Math.abs(next.y - previous.y),
                Math.abs(next.width - previous.width),
                Math.abs(next.height - previous.height),
              );
              stableFrames = delta <= 0.5 ? stableFrames + 1 : 0;
              previous = next;
            }
            return el.isConnected ? el.getBoundingClientRect() : null;
          };
          const visible = node => {
            try {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return rect.width > 0 && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
            } catch { return false; }
          };
          const composedClosest = (node, selector) => {
            let current = node;
            const seen = new Set();
            while (current && !seen.has(current)) {
              seen.add(current);
              try { if (current.matches?.(selector)) return current; } catch {}
              current = current.assignedSlot
                || current.parentElement
                || current.getRootNode?.()?.host
                || null;
            }
            return null;
          };
          const composedParent = node => {
            if (!node) return null;
            return node.assignedSlot || node.parentElement || node.getRootNode?.()?.host || null;
          };
          const toolbarRegionKey = node => {
            try {
              if (!node?.isConnected) return '';
              const region = node.getBoundingClientRect();
              return [
                'rtb',
                String(node.tagName || '').toLowerCase(),
                Math.round(region.x + window.scrollX),
                Math.round(region.y + window.scrollY),
                Math.round(region.width),
                Math.round(region.height),
              ].join(':');
            } catch { return ''; }
          };
          const root = el.getRootNode?.() || document;
          const findById = id => {
            if (!id) return null;
            try {
              if (typeof root.getElementById === 'function') {
                const local = root.getElementById(id);
                if (local) return local;
              }
            } catch {}
            try {
              const escaped = globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/["\\\\]/g, '\\\\$&');
              const local = root.querySelector?.('#' + escaped);
              if (local) return local;
            } catch {}
            try { return document.getElementById(id); } catch { return null; }
          };
          const labelledByText = (() => {
            try {
              const ids = String(el.getAttribute?.('aria-labelledby') || '').trim().split(/\\s+/).filter(Boolean);
              const text = ids.map(findById).filter(Boolean)
                .map(node => String(node.textContent || '').trim()).filter(Boolean)
                .join(' ').replace(/\\s+/g, ' ').trim();
              return text ? text.slice(0, 120) : null;
            } catch { return null; }
          })();
          let labelText = null;
          try {
            if (el.id) {
              const escaped = globalThis.CSS?.escape ? CSS.escape(el.id) : el.id.replace(/["\\\\]/g, '\\\\$&');
              const label = root.querySelector?.('label[for="' + escaped + '"]')
                || document.querySelector?.('label[for="' + escaped + '"]');
              if (label) labelText = String(label.textContent || '').trim().slice(0, 120);
            }
            if (!labelText) {
              const wrapping = composedClosest(el, 'label');
              if (wrapping) labelText = String(wrapping.textContent || '').trim().slice(0, 120);
            }
          } catch {}
          const tag = String(el.tagName || '').toLowerCase();
          const fieldType = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
          const fieldMeta = {
            tag,
            type: fieldType,
            contentEditable: el.isContentEditable === true,
            name: el.getAttribute?.('name') || null,
            id: el.id || null,
            role: el.getAttribute?.('role') || null,
            autocomplete: el.getAttribute?.('autocomplete') || null,
            ariaLabel: el.getAttribute?.('aria-label') || null,
            ariaLabelledByText: labelledByText,
            placeholder: el.getAttribute?.('placeholder') || null,
            title: el.getAttribute?.('title') || null,
            labelText,
          };
          // The same password-field facts content.js _fieldMeta reports (keep
          // the two in step): how many visible password fields share the
          // form (outside a form, the root), how many fields of the form
          // (outside a form, the root's form-less fields) name an account,
          // and the text of the form's first visible submit control. The
          // sign-in password check (credential-fields.js
          // isSignInPasswordField) tells a sign-up's new password, and a
          // lone password field that is no account's, from a sign-in's by
          // them.
          if (fieldType === 'password') {
            try {
              const fields = el.form ? [...el.form.elements] : [...(root.querySelectorAll?.('input') || [])];
              fieldMeta.passwordFields = fields.filter(field => field.tagName === 'INPUT'
                && String(field.type || '').toLowerCase() === 'password'
                && field.getClientRects().length > 0).length;
              fieldMeta.usernameFields = fields.filter(field => {
                if (field === el || field.tagName !== 'INPUT' || field.form !== el.form) return false;
                const type = String(field.type || 'text').toLowerCase();
                if (!['text', 'email', 'tel', 'number'].includes(type)) return false;
                const autocomplete = String(field.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
                if (type === 'email' || autocomplete.includes('username') || autocomplete.includes('email')) return true;
                const identity = [field.getAttribute('name'), field.id, field.getAttribute('aria-label'), field.getAttribute('placeholder'),
                  ...[...(field.labels || [])].map(label => label.textContent)].map(value => String(value || '').slice(0, 120)).join(' ');
                return /user|log[-_ ]?[io]n|e-?mail|account|identifier/i.test(identity);
              }).length;
              const submit = el.form ? [...el.form.elements].find(control => control.getClientRects().length > 0
                && ((control.tagName === 'BUTTON' && String(control.type || 'submit').toLowerCase() === 'submit')
                  || (control.tagName === 'INPUT' && ['submit', 'image'].includes(String(control.type || '').toLowerCase())))) : null;
              const submitText = submit
                ? String((submit.tagName === 'INPUT' ? submit.value || submit.alt : submit.textContent)
                  || submit.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
                : '';
              if (submitText) fieldMeta.formSubmitText = submitText;
            } catch {}
          }
          // Still needed by the payload below, which reports toolbar context
          // even when the element itself does not score as a candidate.
          const semanticToolbar = composedClosest(el, '[role="toolbar"]');
          // Scoring comes from the shared heuristic module, injected above,
          // so this main-world probe and the content script cannot disagree
          // about whether an element is a toolbar control. No axRef is passed:
          // the isolated-world ref registry is unreachable from here, so the
          // candidate carries no refs and blocking falls back to regionKey.
          const candidate = __wbTrustedRichTextToolbarHeuristic
            ? __wbTrustedRichTextToolbarHeuristic.candidate(el, fieldMeta)
            : null;
          if (candidate) fieldMeta.toolbarCandidate = candidate;
          // Measure last, and only scroll for a candidate that will be
          // annotated into a screenshot. Ordinary selector typing must not
          // move the page to centre its target.
          const rect = await settledRect(Number(candidate?.score) >= 4);
          if (rect?.__deadlineExpired) return { deadlineExpired: true };
          if (!rect) return null;
          return {
            pageUrl: location.href,
            rect: {
              x: Math.round(rect.x), y: Math.round(rect.y),
              w: Math.round(rect.width), h: Math.round(rect.height),
              pageX: Math.round(rect.x + window.scrollX),
              pageY: Math.round(rect.y + window.scrollY),
            },
            fieldMeta,
            toolbarContext: !!semanticToolbar || !!candidate,
            toolbarRegionKey: semanticToolbar
              ? toolbarRegionKey(semanticToolbar)
              : (candidate?.regionKey || ''),
          };
        }`,
        arguments: [{ value: deadline.deadlineAt }],
      });
      deadline.throwIfExpired();
      const value = inspected?.result?.value;
      if (value?.deadlineExpired) deadline.throwIfExpired(true);
      if (!value?.rect || !value?.fieldMeta) return { resolved: false };
      return {
        resolved: true,
        refId: '',
        documentToken: '',
        refScopeUrl: String(value.pageUrl || ''),
        rect: value.rect,
        fieldMeta: value.fieldMeta,
        toolbarContext: value.toolbarContext === true,
        toolbarRegionRef: '',
        toolbarRegionKey: String(value.toolbarRegionKey || ''),
        shadowPierced: true,
        selectorBackendNodeId,
      };
    } finally {
      if (objectGroup) await this.releaseObjectGroup(tabId, objectGroup);
      if (releaseObject && objectId) {
        this.releaseObject(tabId, objectId);
      }
    }
  }

  async _resolveSelectorOnce(tabId, selector, options = {}) {
    const deadline = this._selectorActionDeadline(options);
    const scrollRequested = options?.scroll !== false;
    deadline.throwIfExpired();
    await this.sendCommand(tabId, 'Runtime.enable');
    deadline.throwIfExpired();

    const scrollGuard = scrollRequested ? await beforePageAgentDispatch(globalThis.chrome, tabId, {
      kind: 'scroll', selector, scrollIntoView: true, fenceOnly: true,
    }) : null;
    deadline.throwIfExpired();

    const selectorJSON = JSON.stringify(selector);
    const requireUnique = options?.requireUnique === true;

    // ---- Strategy 1: JS walker (open shadow roots) ----
    const jsExpr = `
      (() => {
        ${SELECTOR_SCROLL_DISPATCH_SOURCE}
        const pageGuard = ${JSON.stringify(scrollGuard || null)};
        const sel = ${selectorJSON};
        const requireUnique = ${requireUnique};
        const scrollRequested = ${scrollRequested};
        const actionDeadlineAt = ${deadline.deadlineAt};
        const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
        if (deadlineExpired()) return { found: false, deadlineExpired: true };
        const matches = [];
        const queryDeep = (root) => {
          try {
            const hits = root.querySelectorAll(sel);
            if (hits.length) {
              if (!requireUnique) return hits[0];
              matches.push(...hits);
            }
          } catch (e) {
            if (e?.code === 'page_feedback_pending') throw e;
            return { __error: 'Invalid selector: ' + e.message };
          }
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node = walker.currentNode;
          while (node) {
            if (node.shadowRoot) {
              const inner = queryDeep(node.shadowRoot);
              if (inner?.__error || (!requireUnique && inner)) return inner;
            }
            node = walker.nextNode();
          }
          return null;
        };
        const firstMatch = queryDeep(document);
        if (firstMatch?.__error) return { found: false, error: firstMatch.__error };
        if (requireUnique && matches.length !== 1) {
          return {
            found: false,
            error: 'Trusted selector matched ' + matches.length + ' elements; expected exactly one.',
            nonUnique: true,
            matchCount: matches.length,
          };
        }
        const found = requireUnique ? matches[0] : firstMatch;
        if (!found) return { found: false };
        const tag = String(found.tagName || '').toUpperCase();
        const type = String(found.getAttribute?.('type') || '').trim().toLowerCase();
        const isSubmitControl = tag === 'INPUT'
          ? type === 'submit' || type === 'image'
          : tag === 'BUTTON'
            ? type === 'submit' || (!type && !!(found.form || found.closest?.('form')))
            : false;
        if (deadlineExpired()) return { found: false, deadlineExpired: true };
        if (scrollRequested && found.tagName !== 'SELECT') {
          if (deadlineExpired()) return { found: false, deadlineExpired: true };
          if (!beforeSelectorScroll(found, pageGuard)) return { found: false, pageFeedbackPending: true };
          try { found.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        }
        const r = found.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const vw = window.innerWidth, vh = window.innerHeight;
        const inViewport = r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx <= vw && cy <= vh;
        let hitOk = false;
        if (inViewport) {
          let top = document.elementFromPoint(cx, cy);
          while (top && top.shadowRoot) {
            const inner = top.shadowRoot.elementFromPoint(cx, cy);
            if (!inner || inner === top) break;
            top = inner;
          }
          hitOk = !!(top && (top === found || found.contains(top) || (top.contains && top.contains(found))));
        }
        return {
          found: true,
          x: cx, y: cy,
          width: r.width, height: r.height,
          inViewport, hitOk,
          tag,
          type,
          isSubmitControl,
          text: (found.innerText || found.value || '').slice(0, 80),
        };
      })()
    `;

    const jsRes = await this.evaluate(tabId, jsExpr);
    deadline.throwIfExpired();
    const jsInfo = jsRes?.result?.value;
    throwIfPageFeedbackPending(jsInfo);
    if (jsInfo?.deadlineExpired) deadline.throwIfExpired(true);
    if (jsInfo?.error) return jsInfo;
    if (jsInfo?.found) {
      // Wait briefly for scroll to settle, then re-measure once.
      await new Promise(r => setTimeout(r, 60));
      deadline.throwIfExpired();
      const reMeasure = await this.evaluate(tabId, `
        (() => {
          const sel = ${selectorJSON};
          const requireUnique = ${requireUnique};
          const actionDeadlineAt = ${deadline.deadlineAt};
          const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
          if (deadlineExpired()) return { deadlineExpired: true };
          const matches = [];
          const queryDeep = (root) => {
            try {
              const hits = root.querySelectorAll(sel);
              if (hits.length) {
                if (!requireUnique) return hits[0];
                matches.push(...hits);
              }
            } catch (e) { return null; }
            const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n = w.currentNode;
            while (n) {
              if (n.shadowRoot) {
                const i = queryDeep(n.shadowRoot);
                if (!requireUnique && i) return i;
              }
              n = w.nextNode();
            }
            return null;
          };
          const firstMatch = queryDeep(document);
          if (requireUnique && matches.length !== 1) {
            return {
              error: 'Trusted selector matched ' + matches.length + ' elements; expected exactly one.',
              nonUnique: true,
              matchCount: matches.length,
            };
          }
          const el = requireUnique ? matches[0] : firstMatch;
          if (!el) return null;
          if (deadlineExpired()) return { deadlineExpired: true };
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
        })()
      `);
      deadline.throwIfExpired();
      const m = reMeasure?.result?.value;
      if (m?.deadlineExpired) deadline.throwIfExpired(true);
      if (m?.error) return m;
      if (m) { jsInfo.x = m.x; jsInfo.y = m.y; jsInfo.width = m.width; jsInfo.height = m.height; }
      return jsInfo;
    }

    // ---- Strategy 2: CDP traversal (closed shadow roots) ----
    try {
      deadline.throwIfExpired();
      await this.sendCommand(tabId, 'DOM.enable');
      deadline.throwIfExpired();
      const { root } = await this.sendCommand(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
      deadline.throwIfExpired();

      // Walk the tree, collecting the document nodeId plus every shadow root nodeId.
      const searchRoots = [];
      const walk = (node) => {
        if (!node) return;
        if (node.nodeName === '#document' || node.nodeType === 9) searchRoots.push(node.nodeId);
        if (node.shadowRoots) {
          for (const sr of node.shadowRoots) {
            searchRoots.push(sr.nodeId);
            walk(sr);
          }
        }
        if (node.children) for (const c of node.children) walk(c);
        if (node.contentDocument) walk(node.contentDocument);
      };
      walk(root);

      const foundNodeIds = [];
      for (const rootId of searchRoots) {
        deadline.throwIfExpired();
        try {
          if (requireUnique) {
            // querySelector reports only the first hit in a root, so two
            // matches inside one closed shadow root would pass the uniqueness
            // check below as a single identity. Count them all.
            const { nodeIds } = await this.sendCommand(tabId, 'DOM.querySelectorAll', { nodeId: rootId, selector });
            deadline.throwIfExpired();
            for (const nodeId of nodeIds || []) {
              if (nodeId && !foundNodeIds.includes(nodeId)) foundNodeIds.push(nodeId);
            }
            if (foundNodeIds.length > 1) break;
          } else {
            const { nodeId } = await this.sendCommand(tabId, 'DOM.querySelector', { nodeId: rootId, selector });
            deadline.throwIfExpired();
            if (nodeId && !foundNodeIds.includes(nodeId)) {
              foundNodeIds.push(nodeId);
              break;
            }
          }
        } catch (e) { /* invalid selector for this root, keep going */ }
      }

      if (requireUnique && foundNodeIds.length !== 1) {
        return {
          found: false,
          error: `Trusted selector matched ${foundNodeIds.length} elements; expected exactly one.`,
          nonUnique: true,
          matchCount: foundNodeIds.length,
        };
      }
      const foundNodeId = foundNodeIds[0] || null;
      if (!foundNodeId) return null;

      // Scroll in the page only after re-checking the absolute action deadline.
      // A queued DOM.scrollIntoViewIfNeeded command cannot inspect that
      // deadline when a frozen renderer resumes, so deadline-bound callers use
      // a guarded Runtime function on the exact closed-shadow node instead.
      if (scrollRequested) {
        if (deadline.deadlineAt > 0 || hasPageAgentDispatchOwner(tabId)) {
          let scrollObjectId = null;
          try {
            deadline.throwIfExpired();
            const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: foundNodeId });
            deadline.throwIfExpired();
            scrollObjectId = resolved?.object?.objectId || null;
            if (scrollObjectId) {
              const target = hasPageAgentDispatchOwner(tabId) ? await this._pageAgentObjectTarget(tabId, scrollObjectId) : {};
              const guard = await beforePageAgentDispatch(globalThis.chrome, tabId, {
                kind: 'scroll', scrollIntoView: true, fenceOnly: true, ...target,
              });
              deadline.throwIfExpired();
              const scrolled = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
                objectId: scrollObjectId,
                returnByValue: true,
                functionDeclaration: `function (actionDeadlineAt, pageGuard) {
                  ${SELECTOR_SCROLL_DISPATCH_SOURCE}
                  const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
                  if (deadlineExpired()) return { scrolled: false, deadlineExpired: true };
                  if (!beforeSelectorScroll(this, pageGuard)) return { scrolled: false, pageFeedbackPending: true };
                  try {
                    this.scrollIntoView({ block: 'center', inline: 'center' });
                  } catch {
                    try { this.scrollIntoView(); } catch {}
                  }
                  return { scrolled: true };
                }`,
                arguments: [{ value: deadline.deadlineAt }, { value: guard || null }],
              });
              deadline.throwIfExpired();
              throwIfPageFeedbackPending(scrolled?.result?.value);
              if (scrolled?.result?.value?.deadlineExpired) deadline.throwIfExpired(true);
            }
          } finally {
            if (scrollObjectId) {
              this.releaseObject(tabId, scrollObjectId);
            }
          }
        } else {
          try {
            deadline.throwIfExpired();
            await this.sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId: foundNodeId });
            deadline.throwIfExpired();
          } catch (error) {
            if (error?.code === 'page_feedback_pending') throw error;
            deadline.throwIfExpired();
            // Not all targets support this command.
          }
        }
      }

      const box = await this.sendCommand(tabId, 'DOM.getBoxModel', { nodeId: foundNodeId }).catch(() => null);
      deadline.throwIfExpired();
      if (!box?.model) return { nodeId: foundNodeId, found: true, inViewport: false, hitOk: false };

      // content quad: [x1,y1,x2,y2,x3,y3,x4,y4]
      const c = box.model.content;
      const cx = (c[0] + c[2] + c[4] + c[6]) / 4;
      const cy = (c[1] + c[3] + c[5] + c[7]) / 4;

      // Check viewport via window dims.
      const vp = await this.evaluate(tabId, '({w: window.innerWidth, h: window.innerHeight})');
      deadline.throwIfExpired();
      const vw = vp?.result?.value?.w || 1920;
      const vh = vp?.result?.value?.h || 1080;
      const inViewport = cx >= 0 && cy >= 0 && cx <= vw && cy <= vh && box.model.width > 0 && box.model.height > 0;

      return {
        found: true,
        nodeId: foundNodeId,
        x: cx, y: cy,
        width: box.model.width,
        height: box.model.height,
        inViewport,
        hitOk: inViewport, // can't reliably hit-test into closed roots
        tag: '',
        text: '',
        viaCDP: true,
      };
    } catch (e) {
      if (e?.code === 'page_feedback_pending') throw e;
      if (
        e === options?.deadlineError
        || e === options?.abortSignal?.reason
        || e?.name === 'AbortError'
      ) throw e;
      deadline.throwIfExpired();
      return null;
    }
  }

  /**
   * Click element by selector.
   *
   * Robust path:
   *  1. Locate the element via a shadow-DOM-piercing walker (open roots) inside
   *     a Runtime.evaluate. Selector is passed as a JSON-encoded string so
   *     quotes/backslashes/newlines can't break the eval.
   *  2. Scroll into view, wait a tick, read its center coordinates and check
   *     that the topmost element at that point is the target (or a descendant).
   *  3. Dispatch real mouse events via CDP Input.dispatchMouseEvent
   *     (mouseMoved → mousePressed → mouseReleased). These fire trusted
   *     pointer/mouse/click sequences that frameworks (React, Vue, Web
   *     Components) expect — el.click() alone often isn't enough.
   *  4. If coordinate-based clicking isn't viable (occluded, off-screen after
   *     scroll, zero box), fall back to calling el.click() on the resolved
   *     element so we still attempt the action, unless trustedOnly is set.
   */
  async clickElement(tabId, selector, options = {}) {
    const trustedOnly = options?.trustedOnly === true;
    const abortSignal = options?.abortSignal || null;
    const deadlineAt = Number(options?.deadlineAt) || 0;
    const deadlineError = options?.deadlineError instanceof Error
      ? options.deadlineError
      : null;
    const actionExpired = () => abortSignal?.aborted || (deadlineAt > 0 && Date.now() >= deadlineAt);
    const throwIfAborted = () => {
      if (!actionExpired()) return;
      if (abortSignal?.reason instanceof Error) throw abortSignal.reason;
      if (deadlineError) throw deadlineError;
      const error = new Error('The click was aborted.');
      error.name = 'AbortError';
      throw error;
    };
    const cancelPressedPointer = async () => {
      try {
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: -1, y: -1, button: 'left', buttons: 1, clickCount: 0,
        });
      } catch {}
      try {
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: 0,
        });
      } catch {}
    };
    const beforeDispatch = typeof options?.beforeDispatch === 'function'
      ? options.beforeDispatch
      : null;
    let dispatchAuthorized = false;
    const authorizeDispatch = async ({ x = null, y = null, tag = '', rect = null } = {}) => {
      throwIfAborted();
      if (dispatchAuthorized || !beforeDispatch) return { success: true };
      const validation = await beforeDispatch({ x, y, tag, rect });
      throwIfAborted();
      if (validation?.success !== true) {
        return {
          ...(validation || {}),
          success: false,
          dispatched: false,
          noDispatch: true,
        };
      }
      dispatchAuthorized = true;
      return { success: true };
    };
    throwIfAborted();
    const info = await this.resolveSelector(tabId, selector, options);
    throwIfAborted();
    if (!info) return { success: false, dispatched: false, error: 'Element not found' };
    if (info.error) return { success: false, dispatched: false, error: info.error };

    // <select> intercept: don't click or focus the element. This path runs
    // before dispatch authorization, so even a late Runtime.evaluate must
    // remain observation-only after the caller's action deadline expires.
    if (info.tag === 'SELECT') {
      const selectorJSON = JSON.stringify(selector);
      const optRes = await this.evaluate(tabId, `
        (() => {
          const el = document.querySelector(${selectorJSON});
          if (!el || el.tagName !== 'SELECT') return null;
          return {
            current: el.options[el.selectedIndex]?.text?.trim() || '',
            options: Array.from(el.options).map(o => o.text.trim()),
          };
        })()
      `);
      throwIfAborted();
      const opts = optRes?.result?.value;
      return {
        success: false,
        dispatched: false,
        tag: 'SELECT',
        text: opts?.current || info.text,
        error: `CANNOT CLICK a <select> dropdown — clicking opens a native OS popup that cannot be controlled. Use type_text({selector: ${JSON.stringify(selector)}, text: "option name"}) to change the value.` + (opts?.options ? ' Available: ' + opts.options.join(', ') : ''),
      };
    }

    // Step 1: real mouse events at center coordinates.
    // dispatchAttempted means a click-producing command may have reached the
    // page. It is set at the transport's last pre-protocol point (after the
    // page-feedback fence), and also for any rejection that cannot be placed
    // before that point, because a lost acknowledgement can follow delivery.
    let dispatchAttempted = false;
    const markDispatchAttempted = () => {
      if (dispatchAttempted) return;
      if (typeof options?.onDispatch === 'function') options.onDispatch();
      dispatchAttempted = true;
    };
    const pageDeadlineResult = (priorDispatchAttempted, error) => priorDispatchAttempted
      ? {
          success: false,
          dispatched: true,
          outcomeUnknown: true,
          retryable: false,
          deadlineExpired: true,
          error: `${error || 'Click action deadline expired'}. An earlier click attempt may already have reached the page.`,
        }
      : {
          success: false,
          dispatched: false,
          noDispatch: true,
          outcomeUnknown: false,
          retryable: true,
          deadlineExpired: true,
          error: error || 'Click action deadline expired before click dispatch',
        };
    const pageFeedbackClickResult = (priorDispatchAttempted, focusDispatched = false) => {
      if (!priorDispatchAttempted && !focusDispatched) return pageFeedbackPendingResult();
      return {
        success: false,
        dispatched: true,
        outcomeUnknown: true,
        retryable: false,
        pageFeedbackPending: true,
        error: 'The page changed during click preparation. A prior click or focus may have taken effect; inspect the page before retrying.',
      };
    };
    if (info.inViewport && info.hitOk) {
      const rect = {
        x: Math.round(info.x - (info.width || 1) / 2),
        y: Math.round(info.y - (info.height || 1) / 2),
        w: Math.round(info.width || 1),
        h: Math.round(info.height || 1),
      };
      let released = false;
      try {
        await this.armFileInputClickGuard(tabId);
        throwIfAborted();
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: info.x, y: info.y, button: 'none', buttons: 0,
        });
        throwIfAborted();
        const validation = await authorizeDispatch({
          x: info.x,
          y: info.y,
          tag: info.tag,
          rect,
        });
        if (validation.success !== true) return validation;
        let pressChecked = false;
        try {
          await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1,
          }, '', { beforeSend: () => { pressChecked = true; throwIfAborted(); markDispatchAttempted(); } });
        } catch (error) {
          if (!pressChecked && !isCdpCommandNotSentError(error)) markDispatchAttempted();
          throw error;
        }
        markDispatchAttempted();
        throwIfAborted();
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1,
        });
        released = true;
        throwIfAborted();
        const blockedFileInput = await this.consumeFileInputClickGuard(tabId);
        if (blockedFileInput?.blocked) {
          return this.fileInputClickBlockedResult(
            blockedFileInput,
            'Do not click file-upload controls before uploading.',
          );
        }
        return {
          success: true,
          method: info.viaCDP ? 'cdp-mouse-closed-shadow' : 'cdp-mouse',
          tag: info.tag,
          type: info.type,
          isSubmitControl: info.isSubmitControl === true,
          text: info.text,
          x: info.x,
          y: info.y,
          rect,
        };
      } catch (e) {
        if (dispatchAttempted) {
          // The trusted press may already have activated the target. A DOM or
          // JS fallback would be a second activation reusing the consumed
          // dispatch authorization, so report the possibly delivered click.
          if (!released) await cancelPressedPointer();
          if (actionExpired()) throwIfAborted();
          if (e?.code === 'page_feedback_pending') throw e;
          return {
            success: false,
            dispatched: true,
            outcomeUnknown: true,
            retryable: false,
            trusted: true,
            method: info.viaCDP ? 'cdp-mouse-closed-shadow' : 'cdp-mouse',
            tag: info.tag,
            text: info.text,
            x: info.x,
            y: info.y,
            rect,
            error: `The trusted click was sent but its acknowledgement was lost (${e?.message || String(e)}). Inspect the page before deciding whether to click again; no fallback click was sent.`,
          };
        }
        if (e?.code === 'page_feedback_pending') throw e;
        if (actionExpired()) throwIfAborted();
        // No press reached the protocol: fall through to the fallback.
      }
    }

    // Checkbox state changes may depend on event.isTrusted. In that mode a
    // successful DOM/JS fallback must not masquerade as a trusted click.
    if (trustedOnly) {
      return {
        success: false,
        dispatched: dispatchAttempted,
        ...(dispatchAttempted ? {} : { noDispatch: true }),
        trusted: false,
        error: 'Trusted CDP mouse click could not be completed for this target.',
      };
    }

    // Step 2: fallback. For closed shadow roots we have a nodeId — resolve it
    // and focus/click it inside one page-side deadline-guarded call. Keeping
    // focus in that same call preserves input-click semantics without queuing
    // a separate DOM.focus command that could run after the action timed out.
    if (info.nodeId) {
      let objectId = null;
      try {
        throwIfAborted();
        await this.armFileInputClickGuard(tabId);
        throwIfAborted();
        const { object } = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: info.nodeId });
        throwIfAborted();
        objectId = object?.objectId || null;
        if (objectId) {
          const priorDispatchAttempted = dispatchAttempted;
          const validation = await authorizeDispatch({ x: info.x, y: info.y, tag: info.tag });
          if (validation.success !== true) return validation;
          const pageGuard = await beforePageAgentDispatch(globalThis.chrome, tabId, { kind: 'click', selector, x: info.x, y: info.y });
          let clickChecked = false;
          const clicked = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function(actionDeadlineAt, pageGuard) {
              ${PAGE_AGENT_DOM_ACTION_SOURCE}
              let dispatched = false;
              const deadlineFailure = () => ({ success: false, dispatched, noDispatch: !dispatched,
                outcomeUnknown: dispatched, retryable: !dispatched, deadlineExpired: true,
                error: 'Click action deadline expired' });
              if (actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt) return deadlineFailure();
              if (!this || !this.isConnected) return false;
              if (!beforePageAgentDomAction(pageGuard, 'focus'))
                return { pageFeedbackPending: true, noDispatch: true, dispatched: false };
              if (actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt) return deadlineFailure();
              dispatched = true;
              try { this.focus(); } catch {}
              if (actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt) return deadlineFailure();
              if (!this.isConnected || !beforePageAgentDomAction(pageGuard, 'click'))
                return { pageFeedbackPending: true, noDispatch: false, dispatched: true };
              if (actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt) return deadlineFailure();
              this.click();
              return true;
            }`,
            arguments: [{ value: deadlineAt }, { value: pageGuard || null }],
            returnByValue: true,
            awaitPromise: false,
          }, '', { beforeSend: () => { clickChecked = true; throwIfAborted(); markDispatchAttempted(); } }).catch(error => {
            if (!clickChecked && !isCdpCommandNotSentError(error)) markDispatchAttempted();
            throw error;
          });
          if (clicked?.result?.value?.pageFeedbackPending === true) {
            await this.consumeFileInputClickGuard(tabId);
            return pageFeedbackClickResult(priorDispatchAttempted, clicked.result.value.dispatched === true);
          }
          if (clicked?.result?.value?.deadlineExpired === true) {
            return pageDeadlineResult(priorDispatchAttempted || clicked.result.value.dispatched === true, clicked.result.value.error);
          }
          if (clicked?.result?.value === false) {
            return pageDeadlineResult(priorDispatchAttempted, 'Click action deadline expired before click dispatch');
          }
          throwIfAborted();
          const blockedFileInput = await this.consumeFileInputClickGuard(tabId);
          if (blockedFileInput?.blocked) {
            return this.fileInputClickBlockedResult(
              blockedFileInput,
              'Do not click file-upload controls before uploading.',
            );
          }
          return {
            success: true,
            method: 'cdp-node-click',
            x: info.x,
            y: info.y,
            rect: {
              x: Math.round(info.x - (info.width || 1) / 2),
              y: Math.round(info.y - (info.height || 1) / 2),
              w: Math.round(info.width || 1),
              h: Math.round(info.height || 1),
            },
          };
        }
      } catch (e) {
        if (e?.code === 'page_feedback_pending') throw e;
        if (actionExpired()) throwIfAborted();
        // A node click whose response was lost may already have run.
        if (dispatchAttempted) {
          return {
            success: false, dispatched: true, outcomeUnknown: true, retryable: false,
            method: 'cdp-node-click',
            error: `The node click was sent but its response was lost (${e?.message || String(e)}). Inspect the page before deciding whether to click again; no fallback click was sent.`,
          };
        }
        // fall through
      } finally {
        if (objectId) {
          this.releaseObject(tabId, objectId);
        }
      }
    }

    // Step 3: JS fallback for open shadow roots.
    throwIfAborted();
    await this.armFileInputClickGuard(tabId);
    throwIfAborted();
    const fallbackValidation = await authorizeDispatch({ x: info.x, y: info.y, tag: info.tag });
    if (fallbackValidation.success !== true) return fallbackValidation;
    const priorDispatchAttempted = dispatchAttempted;
    const pageGuard = await beforePageAgentDispatch(globalThis.chrome, tabId, { kind: 'click', selector, x: info.x, y: info.y });
    throwIfAborted();
    markDispatchAttempted();
    const fb = await this.evaluateFunction(tabId, `function (sel, actionDeadlineAt, pageGuard) {
        ${PAGE_AGENT_DOM_ACTION_SOURCE}
        const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
        let dispatched = false;
        const deadlineFailure = () => ({ success: false, dispatched, noDispatch: !dispatched,
          outcomeUnknown: dispatched, retryable: !dispatched, deadlineExpired: true, error: 'Click action deadline expired' });
        if (deadlineExpired()) return deadlineFailure();
        const queryDeep = (root) => {
          try { const h = root.querySelector(sel); if (h) return h; } catch (e) { return null; }
          const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let n = w.currentNode;
          while (n) { if (n.shadowRoot) { const i = queryDeep(n.shadowRoot); if (i) return i; } n = w.nextNode(); }
          return null;
        };
        const el = queryDeep(document);
        if (!el) return { success: false, error: 'Element not found (fallback)' };
        const tag = String(el.tagName || '').toUpperCase();
        const type = String(el.getAttribute?.('type') || '').trim().toLowerCase();
        const isSubmitControl = tag === 'INPUT'
          ? type === 'submit' || type === 'image'
          : tag === 'BUTTON'
            ? type === 'submit' || (!type && !!(el.form || el.closest?.('form')))
            : false;
        if (deadlineExpired()) return deadlineFailure();
        if (!beforePageAgentDomAction(pageGuard, 'focus'))
          return { success: false, pageFeedbackPending: true, noDispatch: true, dispatched: false };
        if (deadlineExpired()) return deadlineFailure();
        dispatched = true;
        try { el.focus(); } catch (e) {}
        if (deadlineExpired()) return deadlineFailure();
        if (!el.isConnected)
          return { success: false, dispatched: true, outcomeUnknown: true, retryable: false, error: 'Click target changed during focus.' };
        if (!beforePageAgentDomAction(pageGuard, 'click'))
          return { success: false, pageFeedbackPending: true, noDispatch: false, dispatched: true };
        if (deadlineExpired()) return deadlineFailure();
        el.click();
        const r = el.getBoundingClientRect();
        return {
          success: true,
          dispatched: true,
          method: 'js-click',
          tag,
          type,
          isSubmitControl,
          text: (el.innerText || '').slice(0, 80),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      }`, [selector, deadlineAt, pageGuard || null], { timeoutMs: deadlineAt > 0 ? Math.max(1, Math.min(15000, deadlineAt - Date.now())) : 15000 });
    const fallbackResult = fb?.result?.value || { success: false, error: 'Click failed' };
    if (fallbackResult.pageFeedbackPending === true) {
      await this.consumeFileInputClickGuard(tabId);
      return pageFeedbackClickResult(priorDispatchAttempted, fallbackResult.dispatched === true);
    }
    if (fallbackResult.outcomeUnknown === true && fallbackResult.dispatched === true) return fallbackResult;
    if (fallbackResult.deadlineExpired === true && fallbackResult.dispatched !== true) {
      return pageDeadlineResult(priorDispatchAttempted, fallbackResult.error);
    }
    throwIfAborted();
    const blockedFileInput = await this.consumeFileInputClickGuard(tabId);
    if (blockedFileInput?.blocked) {
      return this.fileInputClickBlockedResult(
        blockedFileInput,
        'Do not click file-upload controls before uploading.',
      );
    }
    if (fallbackResult.success === false && fallbackResult.dispatched == null) {
      fallbackResult.dispatched = dispatchAttempted;
    }
    return fallbackResult;
  }

  async textEntrySignature(tabId, { selector = '', nodeId = null, focused = false } = {}) {
    const signatureFunction = `function () {
      const el = this;
      if (!el || el.nodeType !== 1 || !el.isConnected) return null;
      const tag = String(el.tagName || '').toUpperCase();
      if (!(el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(tag))) return null;
      const draftJs = (${isDraftJsEditor.toString()})(el);
      const semantic = draftJs ? (${readDraftJsText.toString()})(el)
        : ((${readProseMirrorText.toString()})(el) ?? (${readEmptyCaretText.toString()})(el));
      if (draftJs && semantic === null) return null;
      const value = semantic !== null ? semantic : String(el.isContentEditable
        ? (el.textContent === '' && el.innerText === '\\n' ? '\\n' : (el.textContent || '')) : (el.value || ''));
      return (${TEXT_ENTRY_SIGNATURE_SOURCE})(value);
    }`;
    if (Number.isInteger(nodeId) && nodeId > 0) {
      let objectId = null;
      try {
        await this.sendCommand(tabId, 'DOM.enable');
        const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId });
        objectId = resolved?.object?.objectId || null;
        if (!objectId) return null;
        const result = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
          objectId,
          returnByValue: true,
          functionDeclaration: signatureFunction,
        });
        return typeof result?.result?.value === 'string' ? result.result.value : null;
      } catch {
        return null;
      } finally {
        if (objectId) {
          this.releaseObject(tabId, objectId);
        }
      }
    }
    const selectorJSON = JSON.stringify(String(selector || ''));
    const result = await this.evaluate(tabId, `
      (() => {
        const selector = ${selectorJSON};
        const queryDeep = (root) => {
          try { const match = root.querySelector(selector); if (match) return match; } catch (e) { return null; }
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node = walker.currentNode;
          while (node) {
            if (node.shadowRoot) {
              const inner = queryDeep(node.shadowRoot);
              if (inner) return inner;
            }
            node = walker.nextNode();
          }
          return null;
        };
        const activeDeep = () => {
          let active = document.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          return active;
        };
        const el = ${focused === true} ? activeDeep() : (selector ? queryDeep(document) : null);
        if (!el || !el.isConnected) return null;
        const tag = String(el.tagName || '').toUpperCase();
        if (!(el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(tag))) return null;
        const draftJs = (${isDraftJsEditor.toString()})(el);
        const semantic = draftJs ? (${readDraftJsText.toString()})(el)
        : ((${readProseMirrorText.toString()})(el) ?? (${readEmptyCaretText.toString()})(el));
        if (draftJs && semantic === null) return null;
        const value = semantic !== null ? semantic : String(el.isContentEditable
        ? (el.textContent === '' && el.innerText === '\\n' ? '\\n' : (el.textContent || '')) : (el.value || ''));
        return (${TEXT_ENTRY_SIGNATURE_SOURCE})(value);
      })()
    `).catch(() => null);
    return typeof result?.result?.value === 'string' ? result.result.value : null;
  }

  async selectAllModifier(tabId) {
    let platform = '';
    try {
      const result = await this.evaluate(tabId, `(() => navigator.userAgentData?.platform || navigator.platform || '')()`);
      platform = String(result?.result?.value || '');
    } catch {}
    if (!platform) {
      try { platform = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || ''); } catch {}
    }
    // CDP modifier bits: Alt=1, Control=2, Meta=4, Shift=8.
    return /mac/i.test(platform) ? 4 : 2;
  }

  async captureTextClearReceipt(tabId, { selector = '', nodeId = null, focused = false } = {}) {
    let targetObjectId = null, receiptObjectId = null;
    try {
      if (Number.isInteger(nodeId) && nodeId > 0) {
        const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId });
        targetObjectId = resolved?.object?.objectId;
        if (targetObjectId) receiptObjectId = (await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
          objectId: targetObjectId, returnByValue: false,
          functionDeclaration: `function () { return (${nativeTextClearReceipt.toString()})(this); }`,
        }))?.result?.objectId;
      } else {
        receiptObjectId = (await this.sendCommand(tabId, 'Runtime.evaluate', {
          returnByValue: false,
          expression: `(() => {
            const find = root => {
              const matches = root.querySelectorAll(${JSON.stringify(selector || ':not(*)')});
              if (matches.length > 1) return null;
              if (matches.length === 1) return matches[0];
              for (const node of root.querySelectorAll('*')) if (node.shadowRoot) { const found = find(node.shadowRoot); if (found) return found; }
              return null;
            };
            let active = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
            return (${nativeTextClearReceipt.toString()})(${focused === true} ? active : find(document));
          })()`,
        }))?.result?.objectId;
      }
      if (!receiptObjectId) return null;
      const invoke = async name => {
        try {
          const result = await this.sendCommand(tabId, 'Runtime.callFunctionOn', { objectId: receiptObjectId,
            returnByValue: true, functionDeclaration: 'function (name) { return this[name](); }', arguments: [{ value: name }] });
          return result?.result?.value === true;
        } catch { return false; }
      };
      return {
        current: () => invoke('current'), verify: () => invoke('verify'),
        dispose: async () => { await invoke('dispose'); await this.releaseObject(tabId, receiptObjectId); },
      };
    } catch {
      if (receiptObjectId) await this.releaseObject(tabId, receiptObjectId);
      return null;
    } finally {
      if (targetObjectId) await this.releaseObject(tabId, targetObjectId);
    }
  }

  async _managedTextReplacementSelection(tabId, selector, nodeId) {
    let objectId = null, objectGroup = null;
    try {
      if (Number.isInteger(nodeId) && nodeId > 0) {
        objectId = (await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId }))?.object?.objectId;
      } else {
        const targets = await this.querySelectorPierce(tabId, selector);
        objectGroup = targets?.objectGroup;
        if (targets?.objectIds?.length === 1) objectId = targets.objectIds[0];
      }
      if (!objectId) return null;
      const result = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: `function () {
          const draftJs = (${isDraftJsEditor.toString()})(this);
          if (!draftJs && !this.classList.contains('ProseMirror')) return { managedEditor: false };
          const failed = { managedEditor: true, selected: false };
          if (!this.isConnected || !this.isContentEditable || this.getAttribute('aria-readonly') === 'true') return failed;
          const root = this.getRootNode(), view = this.ownerDocument.defaultView;
          if (root.activeElement !== this) return failed;
          const selection = root.getSelection?.() || view.getSelection();
          if (selection?.rangeCount !== 1) return failed;
          const range = selection.getRangeAt(0);
          if (!this.contains(range.startContainer) || !this.contains(range.endContainer)) return failed;
          if (draftJs && (${readDraftJsText.toString()})(this) === null) return failed;
          // Selection coverage is structural, independent of the text reader's
          // supported block formats. Empty blocks and inline atoms also occupy
          // document positions even though they contribute no text nodes.
          const walker = this.ownerDocument.createTreeWalker(this, view.NodeFilter.SHOW_TEXT | view.NodeFilter.SHOW_ELEMENT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.nodeType === 3) {
              if (node.length && (range.comparePoint(node, 0) !== 0 || range.comparePoint(node, node.length) !== 0)) return failed;
              continue;
            }
            const placeholder = node.tagName === 'BR' && (draftJs
              || node.classList.contains('ProseMirror-trailingBreak'));
            if (placeholder) {
              if (!node.parentElement.textContent && range.comparePoint(node.parentNode,
                  Array.prototype.indexOf.call(node.parentNode.childNodes, node)) !== 0) return failed;
            } else if (node.getAttribute('contenteditable') === 'false' || /^(BR|IMG|HR|INPUT|VIDEO|AUDIO|IFRAME)$/.test(node.tagName)) {
              const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
              if (range.comparePoint(node.parentNode, index) !== 0 || range.comparePoint(node.parentNode, index + 1) !== 0) return failed;
            } else if (!node.childNodes.length && /^(block|list-item|table-cell|flow-root|flex|grid)$/.test(view.getComputedStyle(node).display)
                && range.comparePoint(node, 0) !== 0) return failed;
          }
          return { managedEditor: true, selected: true };
        }`,
      });
      return result?.result?.value || null;
    } catch { return null; }
    finally {
      if (objectGroup) await this.sendCommand(tabId, 'Runtime.releaseObjectGroup', { objectGroup }).catch(() => null);
      else if (objectId) await this.releaseObject(tabId, objectId);
    }
  }

  /**
   * Prove a text edit landed. Returns `true` when proven and `null` when it
   * could not be proven — never `false`.
   *
   * The distinction matters well beyond this file: `verified === false` is read
   * as an action failure by the loop detector, the delivery-progress checkpoint
   * and the observation boundary. Masked inputs, `maxlength` truncation, React
   * controlled reformatting and whitespace-normalizing contenteditables all
   * fail an exact-match proof on edits that actually worked, and a CDP hiccup
   * fails it too. Reporting those as unproven keeps them out of the failure
   * path; only a positive `true` is ever asserted.
   */
  // Positive proof of a text write: true, else null. With `details`, an
  // object instead: { found, verified, reader, compared }. `reader` is
  // 'exact' for a native field's value, 'semantic' for an editor's own model
  // (ProseMirror, DraftJS) and 'rendered' for textContent; `compared` says
  // the readback was actually compared with the expected value, so a
  // compared, unverified exact or semantic reading is a known mismatch.
  async verifyTextEntry(tabId, {
    selector = '', nodeId = null, text = '', clear = false, focused = false, beforeSignature = null,
    details = false,
  } = {}) {
    await new Promise(resolve => setTimeout(resolve, 30));
    const expected = String(text || '');
    const outcome = value => (details
      ? { found: value?.found === true, verified: value?.verified === true,
        reader: ['exact', 'semantic', 'rendered'].includes(value?.reader) ? value.reader : 'unknown',
        compared: value?.compared === true }
      : (value?.verified === true ? true : null));
    const verifyFunction = `function (expected, shouldClear, beforeSignature) {
      const el = this;
      if (!el || el.nodeType !== 1 || !el.isConnected) return { found: false, verified: false };
      const tag = String(el.tagName || '').toUpperCase();
      const typeable = el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(tag);
      if (!typeable) return { found: true, verified: false };
      const draftJs = (${isDraftJsEditor.toString()})(el);
      const semantic = draftJs ? (${readDraftJsText.toString()})(el)
        : ((${readProseMirrorText.toString()})(el) ?? (${readEmptyCaretText.toString()})(el));
      if (draftJs && semantic === null) return { found: true, verified: false };
      if (semantic !== null) expected = expected.replace(/\\r\\n?/g, '\\n');
      const value = semantic !== null ? semantic : String(el.isContentEditable
        ? (el.textContent === '' && el.innerText === '\\n' ? '\\n' : (el.textContent || '')) : (el.value || ''));
      const signatureOf = ${TEXT_ENTRY_SIGNATURE_SOURCE};
      const exactInsertion = () => {
        if (value.length > ${TEXT_ENTRY_PROOF_MAX_CHARS}) return false;
        const separator = beforeSignature.indexOf(':');
        const beforeLength = separator > 0 ? Number(beforeSignature.slice(0, separator)) : NaN;
        if (!expected || !Number.isInteger(beforeLength) || value.length !== beforeLength + expected.length) return false;
        let index = value.indexOf(expected);
        while (index >= 0) {
          if (signatureOf(value.slice(0, index) + value.slice(index + expected.length)) === beforeSignature) return true;
          index = value.indexOf(expected, index + 1);
        }
        return false;
      };
      return {
        found: true,
        reader: semantic !== null ? 'semantic' : (el.isContentEditable ? 'rendered' : 'exact'),
        compared: shouldClear || (!!beforeSignature && /^\\d+:/.test(beforeSignature) && !!expected
          && value.length <= ${TEXT_ENTRY_PROOF_MAX_CHARS}),
        verified: shouldClear
          ? value === expected && !(expected === '' && semantic === null && el.isContentEditable
            && (el.innerText !== '' || el.querySelector('br')))
          : !!beforeSignature && exactInsertion(),
      };
    }`;

    if (Number.isInteger(nodeId) && nodeId > 0) {
      let objectId = null;
      try {
        await this.sendCommand(tabId, 'DOM.enable');
        const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId });
        objectId = resolved?.object?.objectId || null;
        if (!objectId) return outcome(null);
        const result = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
          objectId,
          returnByValue: true,
          functionDeclaration: verifyFunction,
          arguments: [
            { value: expected },
            { value: clear === true },
            { value: typeof beforeSignature === 'string' ? beforeSignature : '' },
          ],
        });
        return outcome(result?.result?.value);
      } catch {
        return outcome(null);
      } finally {
        if (objectId) {
          this.releaseObject(tabId, objectId);
        }
      }
    }

    const selectorJSON = JSON.stringify(String(selector || ''));
    const expectedJSON = JSON.stringify(expected);
    const result = await this.evaluate(tabId, `
      (() => {
        const selector = ${selectorJSON};
        let expected = ${expectedJSON};
        const shouldClear = ${clear === true};
        const beforeSignature = ${JSON.stringify(typeof beforeSignature === 'string' ? beforeSignature : '')};
        const queryDeep = (root) => {
          try { const match = root.querySelector(selector); if (match) return match; } catch (e) { return null; }
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node = walker.currentNode;
          while (node) {
            if (node.shadowRoot) {
              const inner = queryDeep(node.shadowRoot);
              if (inner) return inner;
            }
            node = walker.nextNode();
          }
          return null;
        };
        const activeDeep = () => {
          let active = document.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          return active;
        };
        const el = ${focused === true} ? activeDeep() : (selector ? queryDeep(document) : null);
        if (!el || !el.isConnected) return { found: false, verified: false };
        const tag = String(el.tagName || '').toUpperCase();
        const typeable = el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(tag);
        if (!typeable) return { found: true, verified: false };
        const draftJs = (${isDraftJsEditor.toString()})(el);
        const semantic = draftJs ? (${readDraftJsText.toString()})(el)
        : ((${readProseMirrorText.toString()})(el) ?? (${readEmptyCaretText.toString()})(el));
        if (draftJs && semantic === null) return { found: true, verified: false };
        if (semantic !== null) expected = expected.replace(/\\r\\n?/g, '\\n');
        const value = semantic !== null ? semantic : String(el.isContentEditable
        ? (el.textContent === '' && el.innerText === '\\n' ? '\\n' : (el.textContent || '')) : (el.value || ''));
        const signatureOf = ${TEXT_ENTRY_SIGNATURE_SOURCE};
        const exactInsertion = () => {
          if (value.length > ${TEXT_ENTRY_PROOF_MAX_CHARS}) return false;
          const separator = beforeSignature.indexOf(':');
          const beforeLength = separator > 0 ? Number(beforeSignature.slice(0, separator)) : NaN;
          if (!expected || !Number.isInteger(beforeLength) || value.length !== beforeLength + expected.length) return false;
          let index = value.indexOf(expected);
          while (index >= 0) {
            if (signatureOf(value.slice(0, index) + value.slice(index + expected.length)) === beforeSignature) return true;
            index = value.indexOf(expected, index + 1);
          }
          return false;
        };
        return {
          found: true,
          reader: semantic !== null ? 'semantic' : (el.isContentEditable ? 'rendered' : 'exact'),
          compared: shouldClear || (!!beforeSignature && /^\\d+:/.test(beforeSignature) && !!expected
            && value.length <= ${TEXT_ENTRY_PROOF_MAX_CHARS}),
          verified: shouldClear
            ? value === expected && !(expected === '' && semantic === null && el.isContentEditable
              && (el.innerText !== '' || el.querySelector('br')))
            : !!beforeSignature && exactInsertion(),
        };
      })()
    `).catch(() => null);
    return outcome(result?.result?.value);
  }

  async _cleanupRichTextToolbarTargetMarker(tabId, attribute, marker, { includeClosed = false } = {}) {
    await this.evaluate(tabId, `
      (() => {
        const selector = ${JSON.stringify(`[${attribute}="${marker}"]`)};
        const roots = [document];
        const seen = new Set();
        while (roots.length) {
          const root = roots.shift();
          if (!root || seen.has(root)) continue;
          seen.add(root);
          for (const match of root.querySelectorAll(selector)) match.removeAttribute(${JSON.stringify(attribute)});
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot && !seen.has(element.shadowRoot)) roots.push(element.shadowRoot);
          }
        }
      })()
    `).catch(() => null);
    if (!includeClosed) return;
    try {
      await this.sendCommand(tabId, 'DOM.enable');
      const { root } = await this.sendCommand(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
      const roots = [];
      const walk = node => {
        if (!node) return;
        if (node.nodeName === '#document' || node.nodeType === 9) roots.push(node.nodeId);
        for (const shadowRoot of node.shadowRoots || []) {
          roots.push(shadowRoot.nodeId);
          walk(shadowRoot);
        }
        for (const child of node.children || []) walk(child);
        if (node.contentDocument) walk(node.contentDocument);
      };
      walk(root);
      const selector = `[${attribute}="${marker}"]`;
      const matches = new Set();
      for (const rootNodeId of roots) {
        const result = await this.sendCommand(tabId, 'DOM.querySelectorAll', {
          nodeId: rootNodeId,
          selector,
        }).catch(() => null);
        for (const nodeId of result?.nodeIds || []) matches.add(nodeId);
      }
      await Promise.all(Array.from(matches, nodeId => this.sendCommand(tabId, 'DOM.removeAttribute', {
        nodeId,
        name: attribute,
      }).catch(() => null)));
    } catch {}
  }

  // Multiline DraftJS input must pass through its public paste handler. A
  // single native multiline insertion can duplicate the framework's DOM.
  async _pasteDraftJsText(tabId, selector, info, text, clear, options = {}) {
    let objectId = null, objectGroup = null, originalSnapshotId = null, attempted = false;
    const failure = error => ({ success: false, verified: false, dispatched: attempted,
      ...(attempted ? { outcomeUnknown: true, mutationMayHaveOccurred: true, recoveryRequired: 'verify_or_restore_field' } : { noDispatch: true }),
      retryable: false, error });
    try {
      if (info.nodeId) objectId = (await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: info.nodeId }))?.object?.objectId;
      else {
        const found = await this.querySelectorPierce(tabId, selector);
        objectGroup = found?.objectGroup;
        if (found?.objectIds?.length === 1) objectId = found.objectIds[0];
      }
      if (!objectId) return failure('The original rich-text target could not be preserved.');
      const draft = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: `function () { return !!this.isContentEditable && (this.classList.contains('public-DraftEditor-content')
          || Array.from(this.children).some(child => child.getAttribute('data-contents') === 'true')); }`,
      });
      if (draft?.result?.value !== true) return null;
      if (options.abortSignal?.aborted) return failure('Text entry was aborted before plain-text paste.');
      // Keep DOM object identities in the renderer across the separate focus
      // and input fences. A focus handler cannot become a new append baseline.
      const snapshot = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          return { element: this, doc: this.ownerDocument, view: this.ownerDocument.defaultView,
            root: this.getRootNode(), url: this.ownerDocument.URL,
            value: (${readDraftJsText.toString()})(this), html: this.innerHTML };
        }`,
      });
      originalSnapshotId = snapshot?.result?.objectId || null;
      if (!originalSnapshotId || snapshot.exceptionDetails) return failure('The original DraftJS document could not be preserved.');
      const target = hasPageAgentDispatchOwner(tabId) ? await this._pageAgentObjectTarget(tabId, objectId) : {};
      const focusGuard = await beforePageAgentDispatch(globalThis.chrome, tabId, {
        kind: 'click', tool: 'type_text', eventTypes: ['focus', 'focusin', 'blur', 'focusout'],
        navigationCandidate: false, fenceOnly: true, prepareMonitor: true, ...target,
      });
      if (options.abortSignal?.aborted) return failure('Text entry was aborted before plain-text paste.');
      if (typeof options.beforeDispatch === 'function') options.beforeDispatch();
      attempted = true;
      const focused = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true, userGesture: true,
        functionDeclaration: `function (deadlineAt, targetToken, focusGuard, original) {
          ${PAGE_AGENT_DOM_ACTION_SOURCE}
          if (deadlineAt > 0 && Date.now() >= deadlineAt) return { success: false, noDispatch: true, dispatched: false, deadlineExpired: true };
          if (!this.isConnected || original.element !== this || this.ownerDocument !== original.doc
              || original.doc.defaultView !== original.view || original.view.document !== original.doc
              || this.getRootNode() !== original.root || original.doc.URL !== original.url
              || typeof original.value !== 'string' || (${readDraftJsText.toString()})(this) !== original.value || this.innerHTML !== original.html
              || (targetToken && this[Symbol.for('webbrain.dispatchBinding')] !== targetToken)
              || !beforePageAgentDomAction(focusGuard, 'focus', this))
            return { success: false, noDispatch: true, dispatched: false, pageFeedbackPending: true };
          this.focus({ preventScroll: true });
          return { success: true };
        }`,
        arguments: [...[Number(options.deadlineAt) || 0, String(options.dispatchBindingToken || ''), focusGuard || null].map(value => ({ value })), { objectId: originalSnapshotId }],
      });
      if (focused?.exceptionDetails || !focused?.result?.value) return failure('The editor focus response became unavailable. No paste was sent.');
      if (focused.result.value.success !== true) return { ...focused.result.value, verified: false, retryable: false, error: 'The editor could not be focused before plain-text paste.' };
      const pageGuard = await beforePageAgentDispatch(globalThis.chrome, tabId, {
        kind: 'input', tool: 'type_text', eventTypes: ['paste', 'beforeinput', 'input', 'change'], fenceOnly: true, prepareMonitor: true, ...target,
      });
      if (options.abortSignal?.aborted) return failure('Text entry was aborted before plain-text paste.');
      if (typeof options.beforeDispatch === 'function') options.beforeDispatch();
      attempted = true;
      const pasted = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true, awaitPromise: true, userGesture: true,
        functionDeclaration: `async function (text, clear, deadlineAt, targetToken, pageGuard, original) {
          ${PAGE_AGENT_DOM_ACTION_SOURCE}
          const el = this;
          const originalScope = () => el.isConnected && original.element === el && el.ownerDocument === original.doc
            && original.doc.defaultView === original.view && original.view.document === original.doc
            && el.getRootNode() === original.root && original.doc.URL === original.url;
          const originalFocused = () => {
            let active = original.root.activeElement || original.doc.activeElement;
            while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
            return active === el;
          };
          if (!originalScope() || !originalFocused() || typeof original.value !== 'string'
              || (${readDraftJsText.toString()})(el) !== original.value || el.innerHTML !== original.html)
            return { success: false, verified: false, dispatched: true, mutationMayHaveOccurred: true,
              outcomeUnknown: true, retryable: false, recoveryRequired: 'verify_or_restore_field',
              error: 'The original editor changed during focus preparation. No paste was sent.' };
          return await (${pasteDraftJsText.toString()})(el, text, clear, (${readDraftJsText.toString()}), {
            deadlineExpired: () => deadlineAt > 0 && Date.now() >= deadlineAt,
            beforeDispatch: phase => originalScope() && originalFocused()
              && (!targetToken || el[Symbol.for('webbrain.dispatchBinding')] === targetToken)
              && (phase === 'focus' || beforePageAgentDomAction(pageGuard, phase, el)),
          });
        }`,
        arguments: [...[text, clear, Number(options.deadlineAt) || 0, String(options.dispatchBindingToken || ''), pageGuard || null].map(value => ({ value })), { objectId: originalSnapshotId }],
      });
      const result = pasted?.result?.value;
      if (!result || pasted.exceptionDetails) return failure('The plain-text paste response became unavailable. No additional text was sent.');
      return { ...result, tag: info.tag, rect: { x: Math.round(info.x - (info.width || 1) / 2),
        y: Math.round(info.y - (info.height || 1) / 2), w: Math.round(info.width || 1), h: Math.round(info.height || 1) } };
    } catch (error) {
      return { ...failure(error?.message || String(error)), ...(error?.code === 'page_feedback_pending' ? { pageFeedbackPending: true } : {}) };
    } finally {
      if (originalSnapshotId) this.releaseObject(tabId, originalSnapshotId);
      if (objectGroup) await this.releaseObjectGroup(tabId, objectGroup);
      else if (objectId) this.releaseObject(tabId, objectId);
    }
  }

  /**
   * Resolve and verify the original target before text entry. DraftJS multiline
   * text uses the page's plain-text paste handler; other text uses trusted
   * Input.insertText after focus and optional native selection/deletion.
   */
  async typeText(tabId, selector, text, clear = false, expectedBackendNodeId = null, resolveOptions = {}) {
    const abortSignal = resolveOptions?.abortSignal || null;
    const deadlineAt = Number(resolveOptions?.deadlineAt) || 0;
    const deadlineError = resolveOptions?.deadlineError instanceof Error
      ? resolveOptions.deadlineError
      : null;
    const actionExpired = () => abortSignal?.aborted || (deadlineAt > 0 && Date.now() >= deadlineAt);
    const beforeDispatch = typeof resolveOptions?.beforeDispatch === 'function'
      ? resolveOptions.beforeDispatch
      : null;
    const throwIfAborted = () => {
      if (!actionExpired()) return;
      if (abortSignal?.reason instanceof Error) throw abortSignal.reason;
      if (deadlineError) throw deadlineError;
      const error = new Error('Text entry was aborted.');
      error.name = 'AbortError';
      throw error;
    };
    // Dispatch is recorded once the page-feedback fence has passed, immediately
    // before an input command can reach the page, and for any rejection the
    // transport cannot place before that point. A vetoed command stays unsent.
    let inputSent = false;
    const markSent = () => {
      // The caller's hook may refuse (owner ended); then nothing was sent.
      if (beforeDispatch) beforeDispatch();
      inputSent = true;
    };
    const sendInput = async (method, params) => {
      let checked = false;
      try {
        const result = await this.sendCommand(tabId, method, params, '', {
          beforeSend: () => { checked = true; throwIfAborted(); markSent(); },
        });
        if (!inputSent) markSent();
        return result;
      } catch (error) {
        // A rejection from our own last check, or one the transport places
        // before the protocol call, sent nothing; any other may follow delivery.
        if (!checked && !isCdpCommandNotSentError(error)) markSent();
        throw error;
      }
    };
    const cancelPressedPointer = async () => {
      try {
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: -1, y: -1, button: 'left', buttons: 1, clickCount: 0,
        });
      } catch {}
      try {
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: 0,
        });
      } catch {}
    };
    const dispatchKeyPress = async ({ key, code, windowsVirtualKeyCode, modifiers = 0, commands = [] }) => {
      const keyParams = { key, code, windowsVirtualKeyCode, ...(modifiers ? { modifiers } : {}) };
      const releaseKey = async () => {
        try {
          await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            ...keyParams,
          });
        } catch {}
      };
      try {
        await sendInput('Input.dispatchKeyEvent', {
          type: 'keyDown',
          ...keyParams,
          ...(commands.length ? { commands } : {}),
        });
      } catch (error) {
        if (error?.code === 'page_feedback_pending') throw error;
        if (actionExpired() && !isCdpCommandNotSentError(error)) {
          // A delayed debugger response can mean keyDown reached the page even
          // though the action deadline already expired. Release defensively so
          // later user or agent input cannot inherit a stuck key state.
          await releaseKey();
          throwIfAborted();
        }
        throw error;
      }
      if (actionExpired()) {
        await releaseKey();
        throwIfAborted();
      }
      try {
        await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...keyParams,
        });
      } catch (error) {
        if (error?.code === 'page_feedback_pending') throw error;
        if (actionExpired()) {
          await releaseKey();
          throwIfAborted();
        }
        throw error;
      }
      throwIfAborted();
    };
    throwIfAborted();
    const expectedNodeId = Number(expectedBackendNodeId);
    if (Number.isInteger(expectedNodeId) && expectedNodeId > 0) {
      const currentInfo = await this.resolveSelector(tabId, selector, resolveOptions);
      throwIfAborted();
      if (!currentInfo) return { success: false, dispatched: false, noDispatch: true, error: 'Element not found' };
      if (currentInfo.error) return { success: false, dispatched: false, noDispatch: true, error: currentInfo.error };

      let objectId = null;
      let objectGroup = null;
      let releaseObject = false;
      const markerAttribute = 'data-webbrain-dispatch-binding';
      const entropy = new Uint32Array(3);
      globalThis.crypto.getRandomValues(entropy);
      const marker = `wbdb_${Date.now().toString(36)}_${Array.from(entropy, value => value.toString(36)).join('_')}`;
      try {
        if (currentInfo.nodeId) {
          await this.sendCommand(tabId, 'DOM.enable');
          const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: currentInfo.nodeId });
          objectId = resolved?.object?.objectId || null;
          releaseObject = !!objectId;
        } else {
          const pierced = await this.querySelectorPierce(tabId, selector);
          objectId = pierced?.objectIds?.[0] || null;
          objectGroup = pierced?.objectGroup || null;
        }
        if (!objectId) {
          return { success: false, dispatched: false, noDispatch: true, retryable: true, error: 'Could not preserve the selector target for safe typing. Re-read the page and retry.' };
        }
        await this.sendCommand(tabId, 'DOM.enable');
        const described = await this.sendCommand(tabId, 'DOM.describeNode', { objectId }).catch(() => null);
        const currentBackendNodeId = Number(described?.node?.backendNodeId) || null;
        if (currentBackendNodeId !== expectedNodeId) {
          return { success: false, dispatched: false, noDispatch: true, retryable: true, error: 'The selector target changed after the rich-text toolbar safety preflight. Re-read the page and retry.' };
        }
        const marked = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
          objectId,
          returnByValue: true,
          functionDeclaration: `function (attribute, marker) {
            if (!this || this.nodeType !== 1 || !this.isConnected) return false;
            const tokenKey = Symbol.for('webbrain.dispatchBinding');
            try {
              Object.defineProperty(this, tokenKey, { value: marker, configurable: true });
            } catch {
              this[tokenKey] = marker;
            }
            this.setAttribute(attribute, marker);
            return this.getAttribute(attribute) === marker && this[tokenKey] === marker;
          }`,
          arguments: [{ value: markerAttribute }, { value: marker }],
        }).catch(() => null);
        if (marked?.result?.value !== true) {
          return { success: false, dispatched: false, noDispatch: true, retryable: true, error: 'Could not preserve the selector target for safe typing. Re-read the page and retry.' };
        }
        const trustedSelector = `[${markerAttribute}="${marker}"]`;
        return await this.typeText(tabId, trustedSelector, text, clear, null, {
          ...resolveOptions,
          requireUnique: true,
          dispatchBindingToken: marker,
        });
      } finally {
        if (objectId) {
          await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
            objectId,
            returnByValue: true,
            functionDeclaration: `function (attribute, marker) {
              const tokenKey = Symbol.for('webbrain.dispatchBinding');
              if (this?.getAttribute?.(attribute) === marker) this.removeAttribute(attribute);
              if (this?.[tokenKey] === marker) {
                try { delete this[tokenKey]; } catch {}
              }
              return true;
            }`,
            arguments: [{ value: markerAttribute }, { value: marker }],
          }).catch(() => null);
        }
        await this._cleanupRichTextToolbarTargetMarker(tabId, markerAttribute, marker, {
          includeClosed: Number.isInteger(currentInfo.nodeId) && currentInfo.nodeId > 0,
        });
        if (objectGroup) await this.releaseObjectGroup(tabId, objectGroup);
        if (releaseObject && objectId) {
          this.releaseObject(tabId, objectId);
        }
      }
    }

    const info = await this.resolveSelector(tabId, selector, resolveOptions);
    throwIfAborted();
    if (!info) return { success: false, dispatched: false, noDispatch: true, error: 'Element not found' };
    if (info.error) return { success: false, dispatched: false, noDispatch: true, error: info.error };
    const dispatchBindingToken = String(resolveOptions?.dispatchBindingToken || '');
    if (/[\r\n]/.test(String(text ?? ''))) {
      const pasted = await this._pasteDraftJsText(tabId, selector, info, text, clear, resolveOptions);
      if (pasted) return pasted;
      throwIfAborted();
    }

    // Empty appends mutate nothing on text-entry controls: inserting zero
    // characters cannot change any value, so report a proven no-op without
    // dispatching. Native <select> elements are excluded: choosing their
    // empty-valued option below IS the requested mutation. (A clear:true
    // call still empties the field and takes the verified path.) Without
    // this, the append proof — which rejects an empty expected string —
    // reports uncertainty debt that blocks later legitimate typing.
    if (String(text ?? '') === '' && clear !== true && info?.tag !== 'SELECT') {
      return {
        success: true,
        dispatched: false,
        noDispatch: true,
        noop: true,
        method: 'cdp-insert-text',
      };
    }

    // A native date or time field ignores inserted text and takes keys in
    // the order of the browser's locale. Nothing is sent here: the agent sets
    // its value through the content script (content.js _fillNativeDateInput).
    if (info.tag === 'INPUT' && NATIVE_DATE_INPUT_TYPES.has(info.type)) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        nativeDateInput: info.type,
        error: `The <input type="${info.type}"> field takes one value, not typed text.`,
      };
    }

    // ── <select> fast-path ──────────────────────────────────────────────
    // Native <select> elements CANNOT be typed into via Input.insertText.
    // Clicking them opens a browser-native dropdown that CDP mouse events
    // can't interact with. Instead, focus the select, find the target
    // option index, and use CDP keyboard ArrowDown/ArrowUp events to
    // navigate to it. This fires native browser events that React sees.
    if (info.tag === 'SELECT') {
      const selectorJSON = JSON.stringify(selector);
      const textJSON = JSON.stringify((text || '').trim());
      const targetTokenJSON = JSON.stringify(dispatchBindingToken);
      const result = await this.evaluate(tabId, `
        (() => {
          const actionDeadlineAt = ${deadlineAt};
          const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
          if (deadlineExpired()) return { success: false, deadlineExpired: true, error: 'Select action deadline expired' };
          const sel = ${selectorJSON};
          const needle = ${textJSON};
          const targetToken = ${targetTokenJSON};
          const queryDeep = (root) => {
            try { const h = root.querySelector(sel); if (h) return h; } catch (e) { return null; }
            const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n = w.currentNode;
            while (n) { if (n.shadowRoot) { const i = queryDeep(n.shadowRoot); if (i) return i; } n = w.nextNode(); }
            return null;
          };
          const el = queryDeep(document);
          if (!el || el.tagName !== 'SELECT') return { success: false, error: 'Select element not found' };
          if (targetToken && el[Symbol.for('webbrain.dispatchBinding')] !== targetToken) {
            return { success: false, targetChanged: true, error: 'The selector target changed after safety preflight' };
          }
          if (deadlineExpired()) return { success: false, deadlineExpired: true, error: 'Select action deadline expired' };
          el.focus();
          const opts = Array.from(el.options);
          const match = opts.find(o => o.value === needle)
            || opts.find(o => o.text.trim() === needle)
            || opts.find(o => o.text.trim().toLowerCase().includes(needle.toLowerCase()));
          if (!match) {
            const available = opts.map(o => o.text.trim()).join(', ');
            return { success: false, error: 'No option matching "' + needle + '". Available: ' + available };
          }
          return {
            success: true,
            currentIndex: el.selectedIndex,
            targetIndex: match.index,
            targetText: match.text.trim(),
            targetValue: match.value,
          };
        })()
      `);
      throwIfAborted();
      const sInfo = result?.result?.value;
      if (!sInfo?.success) {
        return {
          ...(sInfo || { success: false, error: 'Select interaction failed' }),
          dispatched: false,
          noDispatch: true,
          ...(sInfo?.targetChanged ? { retryable: true } : {}),
        };
      }

      // Close any open native dropdown
      await dispatchKeyPress({
        key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
      });

      // Navigate with arrow keys
      const delta = sInfo.targetIndex - sInfo.currentIndex;
      const arrowKey = delta > 0 ? 'ArrowDown' : 'ArrowUp';
      const arrowVK = delta > 0 ? 40 : 38;
      for (let i = 0; i < Math.abs(delta); i++) {
        await dispatchKeyPress({
          key: arrowKey, code: arrowKey, windowsVirtualKeyCode: arrowVK,
        });
      }
      const selectorJSONAfter = JSON.stringify(selector);
      const verifiedResult = await this.evaluate(tabId, `
        (() => {
          const sel = ${selectorJSONAfter};
          const queryDeep = (root) => {
            try { const match = root.querySelector(sel); if (match) return match; } catch (e) { return null; }
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node = walker.currentNode;
            while (node) {
              if (node.shadowRoot) {
                const inner = queryDeep(node.shadowRoot);
                if (inner) return inner;
              }
              node = walker.nextNode();
            }
            return null;
          };
          const el = queryDeep(document);
          if (!el || el.tagName !== 'SELECT') return { verified: false };
          const option = el.options[el.selectedIndex];
          return {
            verified: el.value === ${JSON.stringify(sInfo.targetValue)}
              || String(option?.text || '').trim() === ${JSON.stringify(sInfo.targetText)},
          };
        })()
      `).catch(() => null);
      return {
        success: true,
        // Positive proof only — see verifyTextEntry. A `false` here would be
        // read as a failed action by the loop detector and the delivery
        // checkpoint, and this evaluate returns null on any CDP hiccup.
        ...(verifiedResult?.result?.value?.verified === true ? { verified: true } : {}),
        method: 'select-keyboard',
        selectedText: sInfo.targetText,
        selectedValue: sInfo.targetValue,
        keyPresses: Math.abs(delta),
      };
    }

    // HTML text entry uses LF document separators. Sending raw CRLF through
    // Input.insertText can insert an extra space for each CR in ProseMirror.
    // Normalize the payload before the single native write and verify that
    // exact payload; the native select matching path above stays separate.
    const insertionText = String(text ?? '').replace(/\r\n?/g, '\n');
    const beforeSignature = await this.textEntrySignature(tabId, {
      selector,
      nodeId: info.nodeId,
    });
    throwIfAborted();
    let focused = false;
    let dispatched = false;

    if (dispatchBindingToken) {
      let guardedFocus = null;
      if (Number.isInteger(info.nodeId) && info.nodeId > 0) {
        let objectId = null;
        try {
          const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: info.nodeId });
          objectId = resolved?.object?.objectId || null;
          if (objectId) {
            guardedFocus = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
              objectId,
              returnByValue: true,
              functionDeclaration: `function (targetToken, actionDeadlineAt) {
                if (actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt) return false;
                if (!this || !this.isConnected || this[Symbol.for('webbrain.dispatchBinding')] !== targetToken) return false;
                try { this.focus(); } catch { return false; }
                const root = this.getRootNode?.();
                return root?.activeElement === this || document.activeElement === this;
              }`,
              arguments: [{ value: dispatchBindingToken }, { value: deadlineAt }],
            }).catch(() => null);
            throwIfAborted();
          }
        } finally {
          if (objectId) {
            this.releaseObject(tabId, objectId);
          }
        }
      } else {
        const selectorJSON = JSON.stringify(selector);
        const targetTokenJSON = JSON.stringify(dispatchBindingToken);
        guardedFocus = await this.evaluate(tabId, `
          (() => {
            const actionDeadlineAt = ${deadlineAt};
            const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
            if (deadlineExpired()) return false;
            const sel = ${selectorJSON};
            const targetToken = ${targetTokenJSON};
            const queryDeep = (root) => {
              try { const match = root.querySelector(sel); if (match) return match; } catch (e) { return null; }
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let node = walker.currentNode;
              while (node) {
                if (node.shadowRoot) {
                  const inner = queryDeep(node.shadowRoot);
                  if (inner) return inner;
                }
                node = walker.nextNode();
              }
              return null;
            };
            const activeDeep = () => {
              let active = document.activeElement;
              while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
              return active;
            };
            const el = queryDeep(document);
            if (!el || !el.isConnected || el[Symbol.for('webbrain.dispatchBinding')] !== targetToken) return false;
            if (deadlineExpired()) return false;
            try { el.focus(); } catch { return false; }
            return activeDeep() === el;
          })()
        `).catch(() => null);
        throwIfAborted();
      }
      if (guardedFocus?.result?.value !== true) {
        return {
          success: false,
          dispatched: false,
          noDispatch: true,
          retryable: true,
          error: 'The selector target changed after the rich-text toolbar safety preflight. Re-read the page and retry.',
        };
      }
      focused = true;
    }

    // Focus path A: real mouse click (most reliable, fires trusted events).
    if (!focused && info.inViewport && info.hitOk) {
      let pointerPressed = false;
      try {
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: info.x, y: info.y, button: 'none', buttons: 0,
        });
        throwIfAborted();
        dispatched = true;
        // Focusing the field is preparation: only text-changing commands
        // below record text dispatch for the caller.
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1,
        });
        pointerPressed = true;
        throwIfAborted();
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1,
        });
        pointerPressed = false;
        throwIfAborted();
        focused = true;
      } catch (e) {
        if (e?.code === 'page_feedback_pending') throw e;
        if (actionExpired()) {
          if (pointerPressed) await cancelPressedPointer();
          throwIfAborted();
        }
        // try next
      }
    }

    // Focus path B: DOM.focus by nodeId (closed shadow root case).
    if (!focused && info.nodeId) {
      let focusObjectId = null;
      try {
        const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: info.nodeId });
        throwIfAborted();
        focusObjectId = resolved?.object?.objectId || null;
        if (focusObjectId) {
          const focusResult = await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
            objectId: focusObjectId,
            returnByValue: true,
            functionDeclaration: `function (actionDeadlineAt) {
              if (actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt) return false;
              if (!this || !this.isConnected) return false;
              try { this.focus(); } catch { return false; }
              const root = this.getRootNode?.();
              return root?.activeElement === this || document.activeElement === this;
            }`,
            arguments: [{ value: deadlineAt }],
          });
          throwIfAborted();
          focused = focusResult?.result?.value === true;
        }
      } catch (e) {
        if (e?.code === 'page_feedback_pending') throw e;
        if (e?.code === 'content_action_timeout' || actionExpired()) throw e;
        // try next
      }
      finally {
        if (focusObjectId) {
          this.releaseObject(tabId, focusObjectId);
        }
      }
    }

    // Focus path C: JS .focus() (open shadow root case).
    if (!focused) {
      const selectorJSON = JSON.stringify(selector);
      const focusResult = await this.evaluate(tabId, `
        (() => {
          const actionDeadlineAt = ${deadlineAt};
          const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
          if (deadlineExpired()) return false;
          const sel = ${selectorJSON};
          const queryDeep = (root) => {
            try { const h = root.querySelector(sel); if (h) return h; } catch (e) { return null; }
            const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n = w.currentNode;
            while (n) { if (n.shadowRoot) { const i = queryDeep(n.shadowRoot); if (i) return i; } n = w.nextNode(); }
            return null;
          };
          const el = queryDeep(document);
          if (!el || !el.focus || deadlineExpired()) return false;
          el.focus();
          const root = el.getRootNode?.();
          return root?.activeElement === el || document.activeElement === el;
        })()
      `);
      throwIfAborted();
      focused = focusResult?.result?.value === true;
    }

    const clearReceipt = clear ? await this.captureTextClearReceipt(tabId, { selector, nodeId: info.nodeId }) : null;
    try {
      // Keep managed replacements atomic; explicit empty clears and generic
      // fields still use the native Select All + Delete path.
      if (clear) {
        const replacement = insertionText !== ''
          ? await this._managedTextReplacementSelection(tabId, selector, info.nodeId) : null;
        throwIfAborted();
        try {
          // Select all
          const selectAllModifiers = await this.selectAllModifier(tabId);
          throwIfAborted();
          dispatched = true;
          await dispatchKeyPress({
            key: 'a', code: 'KeyA', modifiers: selectAllModifiers, windowsVirtualKeyCode: 65, commands: ['selectAll'],
          });
          if (replacement?.managedEditor !== true) {
            await dispatchKeyPress({
              key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
            });
          }
        } catch (e) {
          if (e?.code === 'page_feedback_pending') throw e;
          if (actionExpired()) throwIfAborted();
          // Only a select-all/Delete that may have reached the page can have
          // changed the text; a refused key leaves the value untouched.
          return {
            success: false,
            dispatched: inputSent,
            ...(inputSent ? {} : { noDispatch: true }),
            verified: false,
            mutationMayHaveOccurred: inputSent,
            error: `Could not safely clear the text field: ${e?.message || String(e)}`,
          };
        }
        const selectedReplacement = replacement?.managedEditor === true
          ? await this._managedTextReplacementSelection(tabId, selector, info.nodeId) : null;
        throwIfAborted();
        if (replacement?.managedEditor === true && selectedReplacement?.selected !== true) {
          const unchanged = typeof beforeSignature === 'string' && await this.textEntrySignature(tabId, {
            selector, nodeId: info.nodeId,
          }) === beforeSignature;
          throwIfAborted();
          const failure = { success: false, dispatched: true, verified: false, mutationMayHaveOccurred: !unchanged,
            outcomeUnknown: !unchanged, retryable: unchanged, repeatBlocked: !unchanged,
            recoveryRequired: unchanged ? 'fresh_tree' : 'verify_or_restore_field',
            error: 'The original editor could not be proven fully selected. No replacement text was inserted. Re-observe before trying again.' };
          if (unchanged && typeof resolveOptions.onUnchangedPreparation === 'function') resolveOptions.onUnchangedPreparation(failure);
          return failure;
        }
        // Managed editors replace the proved selection atomically. Deleting first
        // mounts placeholders and changes Post state before the insertion.
        const cleared = replacement?.managedEditor === true ? true : await this.verifyTextEntry(tabId, {
          selector,
          nodeId: info.nodeId,
          text: '',
          clear: true,
        });
        throwIfAborted();
        if ((clearReceipt && await clearReceipt.current() !== true)
            || (cleared !== true && (String(text ?? '') === '' || await clearReceipt?.verify() !== true))) {
          return {
            success: false,
            dispatched: true,
            verified: false,
            mutationMayHaveOccurred: true,
            error: 'The existing field value could not be proven empty, so no replacement text was inserted.',
          };
        }
      }

      // Capture this exact operation before input changes the editor. Only its
      // acknowledged, verified write may finish; lost input retains uncertainty.
      const inputGuard = await beforePageAgentDispatch(globalThis.chrome, tabId, { kind: 'input', selector, fenceOnly: true });
      const finishInput = capturePageAgentInputCompletion(globalThis.chrome, tabId, inputGuard);
      // Type via Input.insertText — atomic, fires beforeinput/input correctly.
      try {
        dispatched = true;
        await sendInput('Input.insertText', { text: insertionText });
        throwIfAborted();
      } catch (e) {
        if (e?.code === 'page_feedback_pending') throw e;
        if (actionExpired()) throwIfAborted();
        if (!inputSent) {
          // Refused before the protocol call and no earlier input reached the
          // page: nothing changed, so this is not an uncertain write.
          return {
            success: false,
            dispatched: false,
            noDispatch: true,
            verified: false,
            retryable: true,
            error: `Text insertion was not sent: ${e?.message || String(e)}`,
          };
        }
        return {
          success: false,
          dispatched: true,
          verified: false,
          mutationMayHaveOccurred: true,
          error: `Text insertion outcome became uncertain: ${e?.message || String(e)}`,
        };
      }

      const readback = await this.verifyTextEntry(tabId, {
        selector,
        nodeId: info.nodeId,
        text: insertionText,
        clear,
        beforeSignature,
        details: true,
      });
      const verification = readback && typeof readback === 'object' ? readback : { verified: readback === true };
      // The text went out in both cases below; `unverified` lets the agent's
      // policy report it as a failure (Strict checks) or a noted success.
      // verifyTextEntry reads textContent for generic editors, which drops
      // block line breaks, so its doubt is not proof of a wrong value. A
      // native field's value, or an editor's own model, read back as another
      // value is: readbackExact ends a batch before a submit runs on it.
      if (verification.verified !== true) {
        const exact = verification.found && verification.compared
          && (verification.reader === 'exact' || verification.reader === 'semantic');
        return {
          success: false,
          dispatched: true,
          verified: false,
          mutationMayHaveOccurred: true,
          unverified: exact ? { reason: 'readback_mismatch', reader: verification.reader }
            : { reason: 'readback_unproven', reader: 'unknown' },
          ...(exact ? { readbackExact: true } : {}),
          error: exact ? 'Text was inserted, but the field reads back a different value.'
            : 'Text was inserted, but the complete settled field value could not be verified exactly.',
        };
      }
      if (finishInput && !await finishInput()) {
        return { success: false, dispatched: true, verified: false, outcomeUnknown: true,
          mutationMayHaveOccurred: true, retryable: false,
          unverified: { reason: 'input_unconfirmed', reader: 'unknown' },
          error: 'The editor value was verified, but its owned input operation could not be completed. Re-observe before acting.' };
      }
      return {
        success: true,
        verified: true,
        method: 'cdp-insert-text',
        tag: info.tag,
        rect: {
          x: Math.round(info.x - (info.width || 1) / 2),
          y: Math.round(info.y - (info.height || 1) / 2),
          w: Math.round(info.width || 1),
          h: Math.round(info.height || 1),
        },
      };
    } finally { await clearReceipt?.dispose(); }
  }

  /**
   * Scroll page.
   */
  async scrollPage(tabId, direction, amount = 500) {
    await beforePageAgentDispatch(globalThis.chrome, tabId, { kind: 'scroll' });
    const scrollCode = {
      down: `window.scrollBy(0, ${amount})`,
      up: `window.scrollBy(0, -${amount})`,
      top: 'window.scrollTo(0, 0)',
      bottom: 'window.scrollTo(0, document.body.scrollHeight)',
    };

    const result = await this.evaluate(tabId, `
      (() => {
        ${scrollCode[direction] || scrollCode.down};
        return {
          success: true,
          scrollY: window.scrollY,
          scrollHeight: document.body.scrollHeight,
          viewportHeight: window.innerHeight,
        };
      })()
    `);

    return result?.result?.value || result;
  }
}

export const cdpClient = new CDPClient();
