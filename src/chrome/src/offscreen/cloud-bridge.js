/**
 * Offscreen document — outbound WebSocket bridge for managed cloud sessions.
 *
 * The droplet sidecar listens on localhost. The extension connects outbound
 * from this offscreen page, receives command messages, forwards them to the
 * background service worker, then returns the response over the socket.
 */

(() => {
  let socket = null;
  let bridgeUrl = null;
  let enabled = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lastError = '';

  function normalizeBridgeUrl(value) {
    const url = new URL(String(value || 'ws://127.0.0.1:17373/extension'));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
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

  function sendJson(obj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(obj));
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
      socket = new WebSocket(bridgeUrl);
      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
        lastError = '';
        sendJson({ type: 'hello', client: 'webbrain-extension', status: status() });
      });
      socket.addEventListener('message', async (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          sendJson({ ok: false, error: `Invalid JSON message: ${e.message}` });
          return;
        }

        const id = msg.id || null;
        const action = msg.action || msg.command;
        const payload = msg.payload || msg;
        if (!action) {
          sendJson({ id, ok: false, error: 'Missing action' });
          return;
        }

        try {
          const response = await chrome.runtime.sendMessage({
            ...payload,
            target: 'background',
            action,
          });
          if (response && response.error) {
            sendJson({ id, ok: false, error: response.error });
          } else {
            sendJson({ id, ok: true, result: response });
          }
        } catch (e) {
          sendJson({ id, ok: false, error: e.message || String(e) });
        }
      });
      socket.addEventListener('close', () => {
        socket = null;
        scheduleReconnect();
      });
      socket.addEventListener('error', () => {
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
        try { socket.close(); } catch {}
        socket = null;
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
        try { socket.close(); } catch {}
      }
      socket = null;
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
