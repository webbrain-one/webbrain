/**
 * Offscreen document — fetch proxy for local network LLM servers.
 *
 * Chrome MV3 service workers can't always reach HTTP servers on the local
 * network (Private Network Access + CORS restrictions). This offscreen
 * document receives fetch requests from the service worker, makes them
 * from a regular page context (which has different networking rules),
 * and sends the response back.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'offscreen-fetch') return false;

  (async () => {
    try {
      const res = await fetch(msg.url, {
        method: msg.method || 'POST',
        headers: msg.headers || {},
        body: msg.body || undefined,
      });

      const text = await res.text();
      sendResponse({
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        body: text,
      });
    } catch (e) {
      sendResponse({
        ok: false,
        status: 0,
        error: e.message,
      });
    }
  })();

  return true; // keep sendResponse channel open for async
});
