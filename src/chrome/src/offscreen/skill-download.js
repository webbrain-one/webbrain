/**
 * Stage large skill downloads inside the offscreen document.
 *
 * The service worker cannot create durable blob: URLs. This helper performs
 * the actual credentialless, manual-redirect GET, streams it into OPFS, and
 * exposes a local blob URL to chrome.downloads. The browser download therefore
 * never makes a second remote request that could redirect somewhere unvetted.
 */
(function () {
  'use strict';

  const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
  const staged = new Map();

  async function cleanupStaleStages() {
    try {
      const storageRoot = await navigator.storage.getDirectory();
      const dir = await storageRoot.getDirectoryHandle('skill-downloads', { create: true });
      for await (const filename of dir.keys()) {
        try { await dir.removeEntry(filename); } catch {}
      }
    } catch {}
  }

  // A previous service-worker/offscreen shutdown can prevent the normal
  // release message from arriving. Clear only files left by an earlier
  // offscreen-document lifetime before accepting this lifetime's first stage.
  const startupCleanup = cleanupStaleStages();

  function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }

  function parseLength(value) {
    if (!/^\d+$/.test(String(value || '').trim())) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function safeMimeType(value) {
    const type = String(value || '').split(';')[0].trim().toLowerCase();
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)
      ? type
      : 'application/octet-stream';
  }

  function sameSafeOrigin(finalUrl, expectedUrl) {
    try {
      const final = new URL(finalUrl);
      const expected = new URL(expectedUrl);
      return final.protocol === 'https:' && final.origin === expected.origin;
    } catch {
      return false;
    }
  }

  async function removeStage(entry) {
    if (!entry) return;
    try { URL.revokeObjectURL(entry.localUrl); } catch {}
    if (entry.dir && entry.filename) {
      try { await entry.dir.removeEntry(entry.filename); } catch {}
    }
  }

  async function release(token) {
    const entry = staged.get(String(token || ''));
    if (!entry) return false;
    staged.delete(String(token));
    await removeStage(entry);
    return true;
  }

  async function stageResponse(response, maxBytes) {
    await startupCleanup;
    const token = crypto.randomUUID();
    const filename = `${token}.media`;
    const expectedSize = parseLength(response.headers.get('content-length'));
    const contentType = safeMimeType(response.headers.get('content-type'));
    const contentDisposition = String(response.headers.get('content-disposition') || '').slice(0, 2048);
    if (expectedSize != null && expectedSize > maxBytes) {
      try { await response.body?.cancel?.(); } catch {}
      throw new Error(`Skill download exceeds the staged-file limit (${expectedSize} bytes > ${maxBytes} bytes).`);
    }

    const storageRoot = await navigator.storage.getDirectory();
    const dir = await storageRoot.getDirectoryHandle('skill-downloads', { create: true });
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    let bytesReceived = 0;
    try {
      const reader = response.body?.getReader?.();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          bytesReceived += chunk.byteLength;
          if (bytesReceived > maxBytes) {
            try { await reader.cancel(); } catch {}
            throw new Error(`Skill download exceeds the staged-file limit (${bytesReceived} bytes > ${maxBytes} bytes).`);
          }
          await writable.write(chunk);
        }
      } else {
        const blob = await response.blob();
        bytesReceived = blob.size;
        if (bytesReceived > maxBytes) {
          throw new Error(`Skill download exceeds the staged-file limit (${bytesReceived} bytes > ${maxBytes} bytes).`);
        }
        await writable.write(blob);
      }
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch {}
      try { await dir.removeEntry(filename); } catch {}
      throw error;
    }

    const file = await handle.getFile();
    const typedBlob = file.type === contentType ? file : new Blob([file], { type: contentType });
    const localUrl = URL.createObjectURL(typedBlob);
    staged.set(token, { localUrl, dir, filename, typedBlob });
    return { token, localUrl, bytesReceived, contentType, contentDisposition };
  }

  async function prepare(message) {
    const url = String(message.url || '');
    const expectedUrl = String(message.expectedUrl || url);
    const maxBytes = Math.max(1, Math.min(DEFAULT_MAX_BYTES, Number(message.maxBytes) || DEFAULT_MAX_BYTES));
    if (!sameSafeOrigin(url, expectedUrl)) {
      return { success: false, blocked: true, finalUrl: url, error: 'Skill download URL is outside its expected HTTPS origin.' };
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        cache: 'no-store',
      });
      if (response.type === 'opaqueredirect' || isRedirectStatus(response.status)) {
        return {
          success: false,
          blocked: true,
          status: response.status,
          finalUrl: url,
          error: 'Skill download redirects are not allowed because the final URL cannot be validated before saving.',
        };
      }
      const finalUrl = response.url || url;
      if (!sameSafeOrigin(finalUrl, expectedUrl)) {
        return { success: false, blocked: true, status: response.status, finalUrl, error: 'Skill download response left its expected HTTPS origin.' };
      }
      if (!response.ok) {
        return { success: false, status: response.status, finalUrl, error: `Skill download file request failed with HTTP ${response.status}.` };
      }
      const prepared = await stageResponse(response, maxBytes);
      return {
        success: true,
        status: response.status,
        finalUrl,
        localUrl: prepared.localUrl,
        releaseToken: prepared.token,
        bytesReceived: prepared.bytesReceived,
        contentType: prepared.contentType,
        ...(prepared.contentDisposition ? { contentDisposition: prepared.contentDisposition } : {}),
      };
    } catch (error) {
      return { success: false, finalUrl: url, error: `Skill download staging failed: ${error.message}` };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'skill-download-prepare') {
      prepare(message).then(sendResponse);
      return true;
    }
    if (message?.type === 'skill-download-release') {
      release(message.releaseToken).then((released) => sendResponse({ success: true, released }));
      return true;
    }
    return false;
  });
})();
