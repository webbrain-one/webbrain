/**
 * CDP Client for Chrome DevTools Protocol
 * Provides access to shadow DOM, cross-origin iframes, pixel-perfect screenshots,
 * downloads, and uploads via chrome.debugger API.
 */

import { combineImages } from './image-utils.js';

const FULL_PAGE_SCROLL_SETTLE_MS = 100;
const FULL_PAGE_STABLE_PASSES = 2;
const FULL_PAGE_MAX_DISCOVERY_STEPS = 100;
const FULL_PAGE_MAX_CONTENT_GROWTHS = 5;
const FULL_PAGE_MAX_CAPTURE_TILES = 500;

export class CDPClient {
  constructor() {
    this.sessions = new Map(); // tabId -> debugger session
    this.eventHandlers = new Map(); // tabId -> { eventName -> [handlers] }
    this.devDiagnostics = new Map(); // tabId -> bounded console/network buffers
    this.fileChooserGuards = new Map(); // tabId -> temporary protocol interception
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
            this.devDiagnostics.delete(tabId);
            const fileChooserGuard = this.fileChooserGuards.get(tabId);
            if (fileChooserGuard?.timer) clearTimeout(fileChooserGuard.timer);
            this.fileChooserGuards.delete(tabId);
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
    await this._disarmProtocolFileChooserGuard(tabId);

    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        this.sessions.delete(tabId);
        this.eventHandlers.delete(tabId);
        this.devDiagnostics.delete(tabId);
        this.fileChooserGuards.delete(tabId);
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
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
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
      try { await this.sendCommand(tabId, 'Runtime.releaseObject', { objectId }); } catch {}
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
      try { await this.sendCommand(tabId, 'Runtime.releaseObject', { objectId }); } catch {}
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
      await this.releaseObjectGroup(tabId, objectGroup);
      throw error;
    }
  }

  /**
   * Release Runtime objects returned by querySelectorPierce.
   */
  async releaseObjectGroup(tabId, objectGroup) {
    if (!objectGroup) return;
    try {
      await this.sendCommand(tabId, 'Runtime.releaseObjectGroup', { objectGroup });
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
   * @param {number} tabId
   * @param {{knownInfiniteScroll?:boolean,adapterName?:string}} [options]
   * @returns {Promise<{
   *   data:string,
   *   warning:string|null,
   *   captureBounds:{x:number,y:number,width:number,height:number}
   * }>} Capture bounds are CSS pixels in top-page coordinates.
   */
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
        await this.evaluate(tabId, `window.scrollTo(${contentX}, ${targetY})`);
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
          await this.evaluate(tabId, `window.scrollTo(${clipX}, ${clipY})`);
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
      await this.evaluate(tabId, `window.scrollTo(${originalScrollX}, ${originalScrollY})`).catch(() => {});
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
  async setFileInputFiles(tabId, objectId, filePaths) {
    await this.sendCommand(tabId, 'DOM.setFileInputFiles', {
      objectId,
      files: filePaths,
    });
    return { success: true };
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
      state.blocked = {
        blocked: true,
        selector: null,
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
        const gateHasAccessLanguage = (text) => /(?:(?:subscribe|subscription).{0,48}(?:continue|read|access|article|options|required|unlock)|subscriber[- ]only|unlimited access|unlock (?:this|the) article|start (?:your )?(?:free )?trial|create (?:a )?(?:free )?account|register to (?:continue|read)|sign up to (?:continue|read)|(?:log|sign) in to (?:continue|read)|continue reading (?:with|by)|to continue reading|already have an account)/.test(String(text || '').replace(/\\s+/g, ' ').trim().toLowerCase());
        const gateHasInlineBlockingLanguage = (text) => /(?:to continue reading|continue reading (?:with|by)|subscriber[- ]only|(?:subscribe|subscription required|register|sign up|log in|sign in|create (?:a )?(?:free )?account).{0,64}(?:continue reading|read (?:this |the )?(?:full )?(?:article|story)|unlock (?:this|the) (?:article|story)|access (?:this|the) (?:article|story)))/.test(String(text || '').replace(/\\s+/g, ' ').trim().toLowerCase());
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
        const boundedGateLabel = (el, rawLabel) => {
          const options = [];
          let boundaryElement = null;
          for (const value of [el.getAttribute('aria-label'), el.getAttribute('title')]) {
            const normalized = String(value || '').replace(/\\s+/g, ' ').trim();
            if (gateHasAccessLanguage(normalized)) options.push(normalized);
          }
          let descendants = [];
          try { descendants = el.querySelectorAll('h1, h2, h3, p, button, a, label, [role="heading"]'); } catch (e) {}
          for (const node of Array.from(descendants).slice(0, 80)) {
            if (!gateElementIsRendered(node)) continue;
            const normalized = String(node.innerText || '').replace(/\\s+/g, ' ').trim();
            if (normalized.length <= 600 && gateHasAccessLanguage(normalized)) {
              boundaryElement ||= node;
              options.push(normalized);
            }
          }
          options.sort((a, b) => a.length - b.length);
          if (options[0]) return { label: options[0].slice(0, 240), boundaryElement };
          const accessStart = rawLabel.search(/\\b(?:subscribe|subscription|subscriber|unlock|register|sign up|log in|sign in|create an? account|continue reading)\\b/i);
          return {
            label: rawLabel.slice(Math.max(0, accessStart), Math.max(0, accessStart) + 240),
            boundaryElement,
          };
        };
        const gateType = (text) => {
          const value = String(text || '').toLowerCase();
          if (/\\bsubscribe\\b|\\bsubscription\\b|subscriber[- ]only|unlimited access|unlock (?:this|the) article|start (?:your )?(?:free )?trial/.test(value)) return 'subscription';
          if (/create (?:a )?(?:free )?account|register to (?:continue|read)|sign up to (?:continue|read)/.test(value)) return 'registration';
          if (/(?:log|sign) in to (?:continue|read)|already have an account|create (?:a )?(?:free )?account or log in/.test(value)) return 'login';
          return 'unknown';
        };
        const detectPageGate = () => {
          const seen = new Set();
          const candidates = [];
          const articleContext = pageHasArticleContext();
          for (const selector of PAGE_GATE_SELECTORS) {
            let matches = [];
            try { matches = document.querySelectorAll(selector); } catch (e) { continue; }
            for (const el of matches) {
              if (seen.has(el) || !gateElementIsRendered(el)) continue;
              seen.add(el);
              const rawLabel = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
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
              if (surface === 'dialog') {
                if (!articleContext || !gateHasAccessLanguage(rawLabel)) continue;
              } else {
                if (!inArticle || !gateHasInlineBlockingLanguage(rawLabel)) continue;
              }
              const gateText = boundedGateLabel(el, rawLabel);
              const label = gateText.label;
              const namedGate = /paywall|gateway|regiwall|subscription|registration/i.test([el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('data-testid') || ''].join(' '));
              const score = (surface === 'dialog' ? 100 : 0) + (inArticle ? 40 : 0) + (coveringOverlay ? 30 : 0) + (namedGate ? 15 : 0) - Math.min(label.length, 2000) / 2000;
              candidates.push({ element: surface === 'inline' ? (gateText.boundaryElement || el) : el, type: gateType(rawLabel), surface, label: label.slice(0, 240), score });
            }
          }
          candidates.sort((a, b) => b.score - a.score);
          return candidates[0] || null;
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
          text,
          textSource,
          isArticlePage,
          includeChrome,
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
        const tag = String(found.tagName || '').toUpperCase();
        const type = String(found.getAttribute?.('type') || '').trim().toLowerCase();
        const isSubmitControl = tag === 'INPUT'
          ? type === 'submit' || type === 'image'
          : tag === 'BUTTON'
            ? type === 'submit' || (!type && !!(found.form || found.closest?.('form')))
            : false;
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
          tag,
          type,
          isSubmitControl,
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
    const info = await this.resolveSelector(tabId, selector);
    if (!info) return { success: false, dispatched: false, error: 'Element not found' };
    if (info.error) return { success: false, dispatched: false, error: info.error };

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
        dispatched: false,
        tag: 'SELECT',
        text: opts?.current || info.text,
        error: `CANNOT CLICK a <select> dropdown — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused (current: "${opts?.current || ''}"). Use type_text({text: "option name"}) to change the value.` + (opts?.options ? ' Available: ' + opts.options.join(', ') : ''),
      };
    }

    // Step 1: real mouse events at center coordinates.
    let dispatchAttempted = false;
    if (info.inViewport && info.hitOk) {
      try {
        await this.armFileInputClickGuard(tabId);
        const rect = {
          x: Math.round(info.x - (info.width || 1) / 2),
          y: Math.round(info.y - (info.height || 1) / 2),
          w: Math.round(info.width || 1),
          h: Math.round(info.height || 1),
        };
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: info.x, y: info.y, button: 'none', buttons: 0,
        });
        dispatchAttempted = true;
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1,
        });
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1,
        });
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
        // fall through to fallback
      }
    }

    // Step 2: fallback. For closed shadow roots we have a nodeId — use DOM.focus
    // and Runtime.callFunctionOn to invoke .click() on the resolved object.
    if (info.nodeId) {
      try {
        await this.armFileInputClickGuard(tabId);
        await this.sendCommand(tabId, 'DOM.focus', { nodeId: info.nodeId }).catch(() => {});
        const { object } = await this.sendCommand(tabId, 'DOM.resolveNode', { nodeId: info.nodeId });
        if (object?.objectId) {
          await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function() { this.click(); }',
            awaitPromise: false,
          });
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
      } catch (e) { /* fall through */ }
    }

    // Step 3: JS fallback for open shadow roots.
    const selectorJSON = JSON.stringify(selector);
    await this.armFileInputClickGuard(tabId);
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
        const tag = String(el.tagName || '').toUpperCase();
        const type = String(el.getAttribute?.('type') || '').trim().toLowerCase();
        const isSubmitControl = tag === 'INPUT'
          ? type === 'submit' || type === 'image'
          : tag === 'BUTTON'
            ? type === 'submit' || (!type && !!(el.form || el.closest?.('form')))
            : false;
        try { el.focus(); } catch (e) {}
        el.click();
        const r = el.getBoundingClientRect();
        return {
          success: true,
          method: 'js-click',
          tag,
          type,
          isSubmitControl,
          text: (el.innerText || '').slice(0, 80),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      })()
    `);
    const blockedFileInput = await this.consumeFileInputClickGuard(tabId);
    if (blockedFileInput?.blocked) {
      return this.fileInputClickBlockedResult(
        blockedFileInput,
        'Do not click file-upload controls before uploading.',
      );
    }
    const fallbackResult = fb?.result?.value || { success: false, error: 'Click failed' };
    if (fallbackResult.success === false && fallbackResult.dispatched == null) {
      fallbackResult.dispatched = dispatchAttempted;
    }
    return fallbackResult;
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
    const info = await this.resolveSelector(tabId, selector);
    if (!info) return { success: false, dispatched: false, noDispatch: true, error: 'Element not found' };
    if (info.error) return { success: false, dispatched: false, noDispatch: true, error: info.error };

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
      if (!sInfo?.success) {
        return {
          ...(sInfo || { success: false, error: 'Select interaction failed' }),
          dispatched: false,
          noDispatch: true,
        };
      }

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
    let dispatched = false;

    // Focus path A: real mouse click (most reliable, fires trusted events).
    if (info.inViewport && info.hitOk) {
      try {
        await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: info.x, y: info.y, button: 'none', buttons: 0,
        });
        dispatched = true;
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
        dispatched = true;
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
      dispatched = true;
      await this.sendCommand(tabId, 'Input.insertText', { text });
      typed = true;
    } catch (e) { /* fall through to JS setter */ }

    if (!typed) {
      // JS fallback using native setter. Properly escape via JSON.
      const selectorJSON = JSON.stringify(selector);
      const textJSON = JSON.stringify(text);
      dispatched = true;
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
      const fallbackResult = result?.result?.value || { success: false, error: 'Type failed' };
      if (fallbackResult.success === false && fallbackResult.dispatched == null) {
        fallbackResult.dispatched = dispatched;
      }
      return fallbackResult;
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
