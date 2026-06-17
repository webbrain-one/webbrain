/**
 * CDP Client for Chrome DevTools Protocol
 * Provides access to shadow DOM, cross-origin iframes, pixel-perfect screenshots,
 * downloads, and uploads via chrome.debugger API.
 */

export class CDPClient {
  constructor() {
    this.sessions = new Map(); // tabId -> debugger session
    this.eventHandlers = new Map(); // tabId -> { eventName -> [handlers] }
  }

  /**
   * Attach debugger to a tab.
   */
  async attach(tabId) {
    if (this.sessions.has(tabId)) {
      return this.sessions.get(tabId);
    }

    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', async () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const session = { tabId, attached: true };
        this.sessions.set(tabId, session);

        chrome.debugger.onEvent.addListener((source, method, params) => {
          if (source.tabId !== tabId) return;
          const handlers = this.eventHandlers.get(tabId)?.[method];
          if (handlers) {
            handlers.forEach(h => h(params));
          }
        });

        chrome.debugger.onDetach.addListener((source, reason) => {
          if (source.tabId === tabId) {
            this.sessions.delete(tabId);
            this.eventHandlers.delete(tabId);
          }
        });

        resolve(session);
      });
    });
  }

  /**
   * Detach debugger from a tab.
   */
  async detach(tabId) {
    if (!this.sessions.has(tabId)) return;

    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        this.sessions.delete(tabId);
        this.eventHandlers.delete(tabId);
        resolve();
      });
    });
  }

  /**
   * Send a CDP command and get the result.
   */
  async sendCommand(tabId, method, params = {}) {
    if (!this.sessions.has(tabId)) {
      throw new Error(`Not attached to tab ${tabId}`);
    }

    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result, error) => {
        if (error) {
          reject(new Error(error.message || error));
          return;
        }
        resolve(result);
      });
    });
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
   * Query a selector in the main frame or any iframe/shadow DOM (pierce).
   */
  async querySelectorPierce(tabId, selector) {
    await this.sendCommand(tabId, 'DOM.enable');
    const doc = await this.sendCommand(tabId, 'DOM.getDocument', { depth: 0, pierce: false });
    const rootNodeId = doc.root?.nodeId;
    if (!rootNodeId) throw new Error('No document root');

    const result = await this.sendCommand(tabId, 'DOM.querySelectorAll', {
      nodeId: rootNodeId,
      selector,
      piercesShadowDom: true,
    });
    return result.nodeIds || [];
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
  async evaluate(tabId, expression, returnByValue = true) {
    await this.sendCommand(tabId, 'Runtime.enable');
    const result = await this.sendCommand(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    return result;
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
  async getAllFrames(tabId) {
    await this.sendCommand(tabId, 'Page.enable');
    const result = await this.sendCommand(tabId, 'Page.getFrameTree');
    
    const frames = [];
    const collectFrames = (frameTree) => {
      if (frameTree.frame) {
        frames.push({
          id: frameTree.frame.id,
          url: frameTree.frame.url,
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
   */
  async captureFullPageScreenshot(tabId) {
    await this.sendCommand(tabId, 'Page.enable');
    await this.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: 1920,
      screenHeight: 1080,
      viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    });

    const { visualViewport } = await this.evaluate(tabId, `
      (() => {
        const vp = window.visualViewport;
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          contentWidth: document.documentElement.scrollWidth,
          contentHeight: document.documentElement.scrollHeight,
          scale: vp ? vp.scale : 1
        };
      })()
    `);

    const scrollWidth = visualViewport?.contentWidth || 1920;
    const scrollHeight = visualViewport?.contentHeight || 1080;
    // Remember pre-capture scroll so we can restore it (we're in an MV3
    // service worker here — there is no `window`, so read from the page eval).
    const originalScrollX = visualViewport?.scrollX || 0;
    const originalScrollY = visualViewport?.scrollY || 0;

    const viewports = [];
    for (let y = 0; y < scrollHeight; y += 1080) {
      for (let x = 0; x < scrollWidth; x += 1920) {
        viewports.push({ x, y, width: Math.min(1920, scrollWidth - x), height: Math.min(1080, scrollHeight - y) });
      }
    }

    const tiles = [];
    for (const vp of viewports) {
      await this.evaluate(tabId, `window.scrollTo(${vp.x}, ${vp.y})`);
      await new Promise(r => setTimeout(r, 100));

      await this.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
        deviceScaleFactor: 2,
        mobile: false,
        screenWidth: vp.width,
        screenHeight: vp.height,
        viewport: { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 },
      });

      const screenshot = await this.sendCommand(tabId, 'Page.captureScreenshot', {
        format: 'png',
        quality: 100,
        fromSurface: true,
      });
      tiles.push({ x: vp.x, y: vp.y, width: vp.width, height: vp.height, data: screenshot.data });
    }

    await this.evaluate(tabId, `window.scrollTo(${originalScrollX}, ${originalScrollY})`);

    const { combineImages } = await import('./image-utils.js').catch(() => ({ combineImages: null }));
    if (combineImages) {
      return await combineImages(tiles, scrollWidth, scrollHeight, 2);
    }

    // Last-resort fallback if image-utils failed to load: return just the
    // first tile. Previously this returned `images[0]`, which looked like a
    // full-page screenshot but silently dropped everything below the fold.
    return tiles[0]?.data || '';
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
  async setFileInputFiles(tabId, nodeId, filePaths) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'DOM.setFileInputFiles', {
      nodeId,
      files: filePaths,
    });
    return { success: true };
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
  async getFileInputFiles(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'Runtime.enable');
    const resolved = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return null;
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
   * {exists, readable, size}, or null if the probe could not run.
   */
  async probeLocalFile(tabId, filePath) {
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
        contextId = null;
      }

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
        functionDeclaration: `async function () {
          const f = this.files && this.files[0];
          if (!f) return { exists: false, readable: null, size: 0 };
          let readable = null;
          try { await f.slice(0, 1).arrayBuffer(); readable = true; }
          catch (e) { readable = false; }
          return { exists: true, readable, size: f.size };
        }`,
        objectId,
        returnByValue: true,
        awaitPromise: true,
      });
      return res?.result?.value ?? null;
    } catch (e) {
      return null;
    } finally {
      if (objectId) {
        try { await this.sendCommand(tabId, 'Runtime.releaseObject', { objectId }); } catch (e) {}
      }
    }
  }

  /**
   * Dispatch mouse event.
   */
  async dispatchMouseEvent(tabId, type, x, y, button = 'left') {
    await this.sendCommand(tabId, 'Input.enable');
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
    });
  }

  /**
   * Dispatch key event.
   */
  async dispatchKeyEvent(tabId, type, key, text = '') {
    await this.sendCommand(tabId, 'Input.enable');
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
        const SELECTORS = [
          'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
          '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
          '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
          '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
          '[onclick]', '[data-action]', 'summary', 'label'
        ];

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
          const rect = el.getBoundingClientRect();
          elements.push({
            index: index++,
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            role: el.getAttribute('role') || '',
            text: (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim().slice(0, 100),
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
  async readPage(tabId, opts = {}) {
    const includeChrome = !!opts.includeChrome;
    const pageInfo = await this.evaluate(tabId, `
      ((includeChrome) => {
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
        const getText = () => {
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
        return {
          url: window.location.href,
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.content || '',
          text,
          textSource,
          isArticlePage,
          includeChrome,
          links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
            text: a.innerText.trim().slice(0, 100),
            href: a.href,
          })),
          forms: Array.from(document.querySelectorAll('form')).map((form, i) => ({
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
          shadowHosts: Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot).map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            shadowRootMode: el.shadowRoot?.mode,
          })),
          iframes: Array.from(document.querySelectorAll('iframe')).map(iframe => ({
            src: iframe.src,
            id: iframe.id || '',
            name: iframe.name || '',
            visible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0,
          })),
        };
      })(${JSON.stringify(includeChrome)})
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
  async resolveSelector(tabId, selector, options = {}) {
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
      const result = await this._resolveSelectorOnce(tabId, selector);
      // Found and usable → done.
      if (result && result.found && (result.inViewport || result.nodeId)) {
        return result;
      }
      // Hard error from invalid selector — no point retrying.
      if (result && result.error) return result;
      lastResult = result;
      if (i < retries) await new Promise(r => setTimeout(r, delayMs));
    }
    return lastResult;
  }

  async _resolveSelectorOnce(tabId, selector) {
    await this.sendCommand(tabId, 'Runtime.enable');

    const selectorJSON = JSON.stringify(selector);

    // ---- Strategy 1: JS walker (open shadow roots) ----
    const jsExpr = `
      (() => {
        const sel = ${selectorJSON};
        const queryDeep = (root) => {
          try {
            const hit = root.querySelector(sel);
            if (hit) return hit;
          } catch (e) {
            return { __error: 'Invalid selector: ' + e.message };
          }
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
        const found = queryDeep(document);
        if (!found) return { found: false };
        if (found.__error) return { found: false, error: found.__error };
        if (found.tagName !== 'SELECT') { try { found.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {} }
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
          tag: found.tagName,
          text: (found.innerText || found.value || '').slice(0, 80),
        };
      })()
    `;

    const jsRes = await this.evaluate(tabId, jsExpr);
    const jsInfo = jsRes?.result?.value;
    if (jsInfo?.error) return { error: jsInfo.error };
    if (jsInfo?.found) {
      // Wait briefly for scroll to settle, then re-measure once.
      await new Promise(r => setTimeout(r, 60));
      const reMeasure = await this.evaluate(tabId, `
        (() => {
          const sel = ${selectorJSON};
          const queryDeep = (root) => {
            try { const h = root.querySelector(sel); if (h) return h; } catch (e) { return null; }
            const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n = w.currentNode;
            while (n) { if (n.shadowRoot) { const i = queryDeep(n.shadowRoot); if (i) return i; } n = w.nextNode(); }
            return null;
          };
          const el = queryDeep(document);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
        })()
      `);
      const m = reMeasure?.result?.value;
      if (m) { jsInfo.x = m.x; jsInfo.y = m.y; jsInfo.width = m.width; jsInfo.height = m.height; }
      return jsInfo;
    }

    // ---- Strategy 2: CDP traversal (closed shadow roots) ----
    try {
      await this.sendCommand(tabId, 'DOM.enable');
      const { root } = await this.sendCommand(tabId, 'DOM.getDocument', { depth: -1, pierce: true });

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

      let foundNodeId = null;
      for (const rootId of searchRoots) {
        try {
          const { nodeId } = await this.sendCommand(tabId, 'DOM.querySelector', { nodeId: rootId, selector });
          if (nodeId) { foundNodeId = nodeId; break; }
        } catch (e) { /* invalid selector for this root, keep going */ }
      }

      if (!foundNodeId) return null;

      // Scroll into view and measure.
      try {
        await this.sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId: foundNodeId });
      } catch (e) { /* not all targets support this */ }

      const box = await this.sendCommand(tabId, 'DOM.getBoxModel', { nodeId: foundNodeId }).catch(() => null);
      if (!box?.model) return { nodeId: foundNodeId, found: true, inViewport: false, hitOk: false };

      // content quad: [x1,y1,x2,y2,x3,y3,x4,y4]
      const c = box.model.content;
      const cx = (c[0] + c[2] + c[4] + c[6]) / 4;
      const cy = (c[1] + c[3] + c[5] + c[7]) / 4;

      // Check viewport via window dims.
      const vp = await this.evaluate(tabId, '({w: window.innerWidth, h: window.innerHeight})');
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
   *     element so we still attempt the action.
   */
  async clickElement(tabId, selector) {
    await this.sendCommand(tabId, 'Input.enable').catch(() => {});

    const info = await this.resolveSelector(tabId, selector);
    if (!info) return { success: false, error: 'Element not found' };
    if (info.error) return { success: false, error: info.error };

    // <select> intercept: don't click — focus the element (so type_text
    // finds it as activeElement) and return guidance.
    if (info.tag === 'SELECT') {
      const selectorJSON = JSON.stringify(selector);
      const optRes = await this.evaluate(tabId, `
        (() => {
          const el = document.querySelector(${selectorJSON});
          if (!el || el.tagName !== 'SELECT') return null;
          el.focus();
          return {
            current: el.options[el.selectedIndex]?.text?.trim() || '',
            options: Array.from(el.options).map(o => o.text.trim()),
          };
        })()
      `);
      const opts = optRes?.result?.value;
      return {
        success: false,
        tag: 'SELECT',
        text: opts?.current || info.text,
        error: `CANNOT CLICK a <select> dropdown — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused (current: "${opts?.current || ''}"). Use type_text({text: "option name"}) to change the value.` + (opts?.options ? ' Available: ' + opts.options.join(', ') : ''),
      };
    }

    // Step 1: real mouse events at center coordinates.
    if (info.inViewport && info.hitOk) {
      try {
        const rect = {
          x: Math.round(info.x - (info.width || 1) / 2),
          y: Math.round(info.y - (info.height || 1) / 2),
          w: Math.round(info.width || 1),
          h: Math.round(info.height || 1),
        };
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: info.x, y: info.y, button: 'none', buttons: 0,
        });
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1,
        });
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1,
        });
        return {
          success: true,
          method: info.viaCDP ? 'cdp-mouse-closed-shadow' : 'cdp-mouse',
          tag: info.tag,
          text: info.text,
          x: info.x,
          y: info.y,
          rect,
        };
      } catch (e) {
        // fall through to fallback
      }
    }

    // Step 2: fallback. For closed shadow roots we have a nodeId — use DOM.focus
    // and Runtime.callFunctionOn to invoke .click() on the resolved object.
    if (info.nodeId) {
      try {
        await this.sendCommand(tabId, 'DOM.focus', { nodeId: info.nodeId }).catch(() => {});
        const { object } = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: info.nodeId });
        if (object?.objectId) {
          await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function() { this.click(); }',
            awaitPromise: false,
          });
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
      } catch (e) { /* fall through */ }
    }

    // Step 3: JS fallback for open shadow roots.
    const selectorJSON = JSON.stringify(selector);
    const fb = await this.evaluate(tabId, `
      (() => {
        const sel = ${selectorJSON};
        const queryDeep = (root) => {
          try { const h = root.querySelector(sel); if (h) return h; } catch (e) { return null; }
          const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let n = w.currentNode;
          while (n) { if (n.shadowRoot) { const i = queryDeep(n.shadowRoot); if (i) return i; } n = w.nextNode(); }
          return null;
        };
        const el = queryDeep(document);
        if (!el) return { success: false, error: 'Element not found (fallback)' };
        try { el.focus(); } catch (e) {}
        el.click();
        const r = el.getBoundingClientRect();
        return {
          success: true,
          method: 'js-click',
          tag: el.tagName,
          text: (el.innerText || '').slice(0, 80),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      })()
    `);
    return fb?.result?.value || { success: false, error: 'Click failed' };
  }

  /**
   * Type text into an element.
   *
   * Robust path:
   *   1. Resolve via shared shadow-piercing resolver (open + closed roots).
   *   2. Focus via real mouse click at the element's coordinates so the page
   *      sees a trusted focus event (matters for contenteditable, rich editors,
   *      and Google-style search boxes).
   *   3. Optionally clear existing value.
   *   4. Type via Input.insertText — this generates an actual `beforeinput` /
   *      `input` event that frameworks accept, and works for both <input>,
   *      <textarea>, and contenteditable.
   *   5. Falls back to a JS-level value setter if Input.insertText is rejected
   *      (e.g. element isn't focusable through CDP because it's in a closed
   *      shadow root with no usable hit point).
   */
  async typeText(tabId, selector, text, clear = false) {
    await this.sendCommand(tabId, 'Input.enable').catch(() => {});

    const info = await this.resolveSelector(tabId, selector);
    if (!info) return { success: false, error: 'Element not found' };
    if (info.error) return { success: false, error: info.error };

    // ── <select> fast-path ──────────────────────────────────────────────
    // Native <select> elements CANNOT be typed into via Input.insertText.
    // Clicking them opens a browser-native dropdown that CDP mouse events
    // can't interact with. Instead, focus the select, find the target
    // option index, and use CDP keyboard ArrowDown/ArrowUp events to
    // navigate to it. This fires native browser events that React sees.
    if (info.tag === 'SELECT') {
      const selectorJSON = JSON.stringify(selector);
      const textJSON = JSON.stringify((text || '').trim());
      const result = await this.evaluate(tabId, `
        (() => {
          const sel = ${selectorJSON};
          const needle = ${textJSON};
          const queryDeep = (root) => {
            try { const h = root.querySelector(sel); if (h) return h; } catch (e) { return null; }
            const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n = w.currentNode;
            while (n) { if (n.shadowRoot) { const i = queryDeep(n.shadowRoot); if (i) return i; } n = w.nextNode(); }
            return null;
          };
          const el = queryDeep(document);
          if (!el || el.tagName !== 'SELECT') return { success: false, error: 'Select element not found' };
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
      const sInfo = result?.result?.value;
      if (!sInfo?.success) return sInfo || { success: false, error: 'Select interaction failed' };

      // Close any open native dropdown
      await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
      });
      await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
      });

      // Navigate with arrow keys
      const delta = sInfo.targetIndex - sInfo.currentIndex;
      const arrowKey = delta > 0 ? 'ArrowDown' : 'ArrowUp';
      const arrowVK = delta > 0 ? 40 : 38;
      for (let i = 0; i < Math.abs(delta); i++) {
        await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: arrowKey, code: arrowKey, windowsVirtualKeyCode: arrowVK,
        });
        await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: arrowKey, code: arrowKey, windowsVirtualKeyCode: arrowVK,
        });
      }
      return {
        success: true,
        method: 'select-keyboard',
        selectedText: sInfo.targetText,
        selectedValue: sInfo.targetValue,
        keyPresses: Math.abs(delta),
      };
    }

    let focused = false;

    // Focus path A: real mouse click (most reliable, fires trusted events).
    if (info.inViewport && info.hitOk) {
      try {
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: info.x, y: info.y, button: 'none', buttons: 0,
        });
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1,
        });
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1,
        });
        focused = true;
      } catch (e) { /* try next */ }
    }

    // Focus path B: DOM.focus by nodeId (closed shadow root case).
    if (!focused && info.nodeId) {
      try {
        await this.sendCommand(tabId, 'DOM.focus', { nodeId: info.nodeId });
        focused = true;
      } catch (e) { /* try next */ }
    }

    // Focus path C: JS .focus() (open shadow root case).
    if (!focused) {
      const selectorJSON = JSON.stringify(selector);
      await this.evaluate(tabId, `
        (() => {
          const sel = ${selectorJSON};
          const queryDeep = (root) => {
            try { const h = root.querySelector(sel); if (h) return h; } catch (e) { return null; }
            const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n = w.currentNode;
            while (n) { if (n.shadowRoot) { const i = queryDeep(n.shadowRoot); if (i) return i; } n = w.nextNode(); }
            return null;
          };
          const el = queryDeep(document);
          if (el && el.focus) el.focus();
        })()
      `);
    }

    // Clear existing content if requested. Use Select All + Delete via key events
    // so the page observes proper input events.
    if (clear) {
      try {
        // Select all
        await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 /* Ctrl */, windowsVirtualKeyCode: 65,
        });
        await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
        });
        // Delete selection
        await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
        });
        await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
        });
      } catch (e) { /* best effort */ }
    }

    // Type via Input.insertText — atomic, fires beforeinput/input correctly.
    let typed = false;
    try {
      await this.sendCommand(tabId, 'Input.insertText', { text });
      typed = true;
    } catch (e) { /* fall through to JS setter */ }

    if (!typed) {
      // JS fallback using native setter. Properly escape via JSON.
      const selectorJSON = JSON.stringify(selector);
      const textJSON = JSON.stringify(text);
      const result = await this.evaluate(tabId, `
        (() => {
          const sel = ${selectorJSON};
          const txt = ${textJSON};
          const queryDeep = (root) => {
            try { const h = root.querySelector(sel); if (h) return h; } catch (e) { return null; }
            const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n = w.currentNode;
            while (n) { if (n.shadowRoot) { const i = queryDeep(n.shadowRoot); if (i) return i; } n = w.nextNode(); }
            return null;
          };
          const el = queryDeep(document);
          if (!el) return { success: false, error: 'Element not found (fallback)' };
          try { el.focus(); } catch (e) {}

          if (el.isContentEditable) {
            if (${clear}) el.textContent = '';
            el.textContent += txt;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: txt }));
            const r = el.getBoundingClientRect();
            return {
              success: true,
              method: 'js-contenteditable',
              value: el.textContent.slice(0, 100),
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            };
          }

          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          const newVal = (${clear} ? '' : (el.value || '')) + txt;
          if (setter) setter.call(el, newVal); else el.value = newVal;

          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          const r = el.getBoundingClientRect();
          return {
            success: true,
            method: 'js-setter',
            value: (el.value || '').slice(0, 100),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          };
        })()
      `);
      return result?.result?.value || { success: false, error: 'Type failed' };
    }

    return {
      success: true,
      method: 'cdp-insert-text',
      tag: info.tag,
      rect: {
        x: Math.round(info.x - (info.width || 1) / 2),
        y: Math.round(info.y - (info.height || 1) / 2),
        w: Math.round(info.width || 1),
        h: Math.round(info.height || 1),
      },
    };
  }

  /**
   * Scroll page.
   */
  async scrollPage(tabId, direction, amount = 500) {
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
