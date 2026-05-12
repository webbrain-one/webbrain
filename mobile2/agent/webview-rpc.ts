/**
 * WebView <-> React Native RPC.
 *
 * The agent runs in the React Native JS context but its tools (read AX tree,
 * click an element, type text) need to execute inside the page running in the
 * WebView. We bridge the two with a request/response RPC over
 * `WebView.injectJavaScript` (RN→page) and `window.ReactNativeWebView.postMessage`
 * (page→RN).
 *
 * Lifecycle:
 *   1. Browser screen mounts a <WebView> and calls registerWebView(ref).
 *   2. Page-side script (mobile/agent/inject.ts → PAGE_SCRIPT) installs a
 *      handler dispatcher on window.__wbHandle(msg). Every page navigation
 *      re-runs that script via injectedJavaScriptBeforeContentLoaded.
 *   3. Agent calls webRpc.call('click_ax', { ref_id }).
 *   4. We assign a unique id, store a pending promise, then invoke
 *      webRef.injectJavaScript('window.__wbHandle({...}, "<id>")').
 *   5. Page side runs the handler, posts back JSON {id, ok, result|error}.
 *   6. WebView's onMessage delivers it; we resolve/reject the matching
 *      pending promise.
 *
 * Calls made before a WebView is registered are queued and flushed on
 * register, so the agent can issue tool calls during the very first frame.
 */
import type WebView from 'react-native-webview';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const TIMEOUT_MS = 15000;

let webRef: WebView | null = null;
let nextId = 1;
const pending = new Map<string, Pending>();
const queue: Array<{ id: string; payload: string }> = [];

function flushQueue() {
  if (!webRef) return;
  while (queue.length) {
    const { payload } = queue.shift()!;
    webRef.injectJavaScript(payload);
  }
}

export function registerWebView(ref: WebView | null) {
  webRef = ref;
  if (ref) flushQueue();
}

export function call<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = String(nextId++);
  const body = JSON.stringify({ id, method, params });
  // The trailing `true;` is required: injectJavaScript on iOS warns when the
  // injected code's last expression isn't serializable.
  const payload = `(function(){try{window.__wbHandle && window.__wbHandle(${body});}catch(e){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({id:${JSON.stringify(id)},ok:false,error:String(e&&e.message||e)}));}})();true;`;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC ${method} timed out after ${TIMEOUT_MS}ms`));
      }
    }, TIMEOUT_MS);
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    if (webRef) {
      webRef.injectJavaScript(payload);
    } else {
      queue.push({ id, payload });
    }
  });
}

/**
 * Hand a message from <WebView onMessage> back to the RPC layer. Returns
 * true if the message was an RPC reply (and should be consumed silently),
 * false if it should be handled by other listeners.
 */
export function handleWebViewMessage(raw: string): boolean {
  let parsed: { id?: string; ok?: boolean; result?: unknown; error?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed.id !== 'string') return false;
  const p = pending.get(parsed.id);
  if (!p) return true; // late reply, swallow
  pending.delete(parsed.id);
  if (p.timer) clearTimeout(p.timer);
  if (parsed.ok) {
    p.resolve(parsed.result);
  } else {
    p.reject(new Error(parsed.error || 'RPC error'));
  }
  return true;
}

/** Reset on hard reset (logout, settings change, etc.). Tests use this. */
export function _resetForTesting() {
  webRef = null;
  pending.forEach((p) => p.timer && clearTimeout(p.timer));
  pending.clear();
  queue.length = 0;
  nextId = 1;
}
