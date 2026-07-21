/**
 * Offscreen document — outbound WebSocket bridge for managed cloud sessions.
 *
 * The droplet sidecar listens on localhost. The extension connects outbound
 * from this offscreen page, receives command messages, forwards them to the
 * background service worker, then returns the response over the socket.
 */

(() => {
  // Provisioning seeds Settings from a privileged extension page before this
  // bridge starts. Keep configuration mutations out of the WebSocket command
  // surface; the bridge is intentionally limited to managed run operations.
  const ALLOWED_BRIDGE_ACTIONS = new Set(['cloud_run', 'cloud_status', 'cloud_respond', 'cloud_abort']);
  let socket = null;
  let bridgeUrl = null;
  let enabled = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lastError = '';

  function normalizeBridgeUrl(value) {
    const url = new URL(String(value || 'ws://127.0.0.1:17373/extension'));
    const host = url.hostname.toLowerCase();
    // WHATWG URL keeps the brackets on IPv6 literals: ws://[::1]/… parses to
    // hostname "[::1]", so both spellings must be allowlisted.
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      throw new Error('Cloud bridge URL must use ws:// on localhost.');
    }
    return url.href;
  }

  function status() {
    return {
      enabled,
      url: bridgeUrl,
      connected: socket?.readyState === WebSocket.OPEN,
      readyState: socket ? socket.readyState : null,
      reconnectAttempt,
      lastError,
    };
  }

  function sendJson(obj, target = socket) {
    if (!target || target.readyState !== WebSocket.OPEN) return;
    try {
      target.send(JSON.stringify(obj));
    } catch (e) {
      lastError = e.message || String(e);
    }
  }

  function scheduleReconnect() {
    if (!enabled || !bridgeUrl || reconnectTimer) return;
    const delay = Math.min(30000, 500 * Math.pow(2, reconnectAttempt++));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!enabled || !bridgeUrl) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    try {
      const nextSocket = new WebSocket(bridgeUrl);
      socket = nextSocket;
      nextSocket.addEventListener('open', () => {
        if (socket !== nextSocket) return;
        reconnectAttempt = 0;
        lastError = '';
        sendJson({ type: 'hello', client: 'webbrain-extension', status: status() }, nextSocket);
      });
      nextSocket.addEventListener('message', async (event) => {
        if (socket !== nextSocket) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          sendJson({ ok: false, error: `Invalid JSON message: ${e.message}` }, nextSocket);
          return;
        }

        const id = msg.id || null;
        const action = msg.action || msg.command;
        const payload = msg.payload || msg;
        if (!action) {
          sendJson({ id, ok: false, error: 'Missing action' }, nextSocket);
          return;
        }
        if (!ALLOWED_BRIDGE_ACTIONS.has(action)) {
          sendJson({ id, ok: false, error: `Unsupported cloud bridge action: ${action}` }, nextSocket);
          return;
        }

        try {
          const response = await chrome.runtime.sendMessage({
            ...payload,
            target: 'background',
            action,
          });
          const isRunSnapshot = !!response
            && (response.runId != null || response.run_id != null)
            && typeof response.status === 'string';
          if (response?.error && !isRunSnapshot) {
            sendJson({ id, ok: false, error: response.error, status: response.status || 500 }, nextSocket);
          } else {
            sendJson({ id, ok: true, result: response }, nextSocket);
          }
        } catch (e) {
          sendJson({ id, ok: false, error: e.message || String(e) }, nextSocket);
        }
      });
      nextSocket.addEventListener('close', () => {
        if (socket !== nextSocket) return;
        socket = null;
        scheduleReconnect();
      });
      nextSocket.addEventListener('error', () => {
        if (socket !== nextSocket) return;
        lastError = 'WebSocket error';
      });
    } catch (e) {
      lastError = e.message || String(e);
      socket = null;
      scheduleReconnect();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'cloud-bridge-start') {
      let nextUrl;
      try {
        nextUrl = normalizeBridgeUrl(msg.url || bridgeUrl);
      } catch (error) {
        lastError = error.message || String(error);
        sendResponse({ ...status(), error: lastError });
        return false;
      }
      const changed = bridgeUrl && bridgeUrl !== nextUrl;
      enabled = true;
      bridgeUrl = nextUrl;
      if (changed && socket) {
        const previousSocket = socket;
        socket = null;
        try { previousSocket.close(); } catch {}
      }
      connect();
      sendResponse(status());
      return false;
    }
    if (msg.type === 'cloud-bridge-stop') {
      enabled = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectAttempt = 0;
      if (socket) {
        const previousSocket = socket;
        socket = null;
        try { previousSocket.close(); } catch {}
      }
      sendResponse(status());
      return false;
    }
    if (msg.type === 'cloud-bridge-status') {
      sendResponse(status());
      return false;
    }
    return false;
  });
})();
