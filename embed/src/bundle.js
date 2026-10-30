import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, EXTENSION_PATHS, getEmbedToolsForMode } from './webbrain.js';

const WIDGET_RUNTIME_PATH = path.resolve(PROJECT_ROOT, 'src/widget-runtime.js');

/**
 * Strips top-level ES module `export ` keywords from pure upstream helper files
 * (`calculator.js`, `activity-brain.js`, `markdown-render.js`, ...) so they can run inside
 * a classic `<script src="/embed.js">` tag without requiring bundler dependencies.
 * Anything else module-only (an `import`, `export default`, `import.meta`) is left in
 * place and fails the classic-script parse in scripts/build.mjs.
 */
function stripEsModuleExports(source) {
  return String(source)
    .replace(/^export\s+(function|const|let|var|class)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}

/**
 * Reads an upstream helper module and wraps it so it returns `names`. Fails the
 * build when the module no longer declares one of them, instead of shipping a
 * bundle that throws a ReferenceError on every customer site.
 */
function helperModule(file, names) {
  const source = stripEsModuleExports(fs.readFileSync(file, 'utf8'));
  for (const name of names) {
    if (!new RegExp(`^(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name}\\b`, 'm').test(source)) {
      throw new Error(`embed bundle: ${path.relative(PROJECT_ROOT, file)} no longer declares ${name}`);
    }
  }
  return `(function() {
${source}
      return { ${names.join(', ')} };
    })()`;
}

/**
 * Builds the self-contained `<script src="/embed.js">` bundle from the WebBrain
 * extension's own content scripts and helpers (src/chrome) plus
 * `embed/src/widget-runtime.js`.
 */
export function buildEmbedBundle() {
  const accessibilityTreeJs = fs.readFileSync(EXTENSION_PATHS.accessibilityTree, 'utf8');
  const visualIndicatorJs = fs.readFileSync(EXTENSION_PATHS.visualIndicator, 'utf8');
  const contentScriptJs = fs.readFileSync(EXTENSION_PATHS.contentScript, 'utf8');
  const calculatorJs = helperModule(EXTENSION_PATHS.calculator, ['calculateExpression']);
  const activityBrainJs = helperModule(EXTENSION_PATHS.activityBrain, ['mountActivityBrain']);
  const markdownRenderJs = helperModule(EXTENSION_PATHS.markdownRender, [
    'highlightCode',
    'escapeCodeHtml',
    'renderMarkdownBlockquotes',
    'renderMarkdownHeadings',
    'renderMarkdownTables',
    'createMarkdownPlaceholders',
  ]);
  const readPageWindowJs = helperModule(EXTENSION_PATHS.readPageWindow, ['applyReadPageWindow', 'fitReadPageWindowResult']);
  const credentialFieldsJs = helperModule(EXTENSION_PATHS.credentialFields, ['SENSITIVE_NAME_RE', 'REDACTED_CREDENTIAL']);
  const widgetRuntimeJs = fs.readFileSync(WIDGET_RUNTIME_PATH, 'utf8');
  // The widget refuses any tool call outside these lists, which are the tools.json lists.
  const toolNames = JSON.stringify({
    ask: getEmbedToolsForMode('ask').map((tool) => tool.function.name),
    act: getEmbedToolsForMode('act').map((tool) => tool.function.name),
  });

  return `/**
 * WebBrain for Websites — Embeddable AI Agent Bundle
 * Source: https://github.com/webbrain-one/webbrain/tree/main/embed
 * License: GPL-3.0-or-later
 */
(function() {
  if (window.__wbEmbedRuntime) return;

  const messageListeners = [];
  const stopCallbacks = [];
  const storageListeners = [];
  const localStorageData = { agentIndicatorStyle: 'classic' };
  let widgetHostEl = null;

  const inPageChrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          if (typeof fn === 'function') messageListeners.push(fn);
        },
        removeListener(fn) {
          const idx = messageListeners.indexOf(fn);
          if (idx >= 0) messageListeners.splice(idx, 1);
        }
      },
      sendMessage(msg, callback) {
        if (msg && msg.type === 'WB_STOP_AGENT') {
          for (const cb of stopCallbacks) {
            try { cb(); } catch {}
          }
        }
        if (typeof callback === 'function') {
          try { callback({ ok: true, state: { active: false } }); } catch {}
        }
        return Promise.resolve({ ok: true });
      }
    },
    storage: {
      local: {
        get(keys, cb) {
          let res = {};
          if (typeof keys === 'string') {
            res[keys] = localStorageData[keys];
          } else if (Array.isArray(keys)) {
            for (const k of keys) res[k] = localStorageData[k];
          } else if (keys && typeof keys === 'object') {
            res = { ...keys, ...localStorageData };
          } else {
            res = { ...localStorageData };
          }
          if (typeof cb === 'function') cb(res);
          return Promise.resolve(res);
        },
        set(items, cb) {
          if (items && typeof items === 'object') {
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
              changes[k] = { oldValue: localStorageData[k], newValue: v };
              localStorageData[k] = v;
            }
            for (const fn of storageListeners) {
              try { fn(changes, 'local'); } catch {}
            }
          }
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener(fn) {
          if (typeof fn === 'function') storageListeners.push(fn);
        },
        removeListener(fn) {
          const idx = storageListeners.indexOf(fn);
          if (idx >= 0) storageListeners.splice(idx, 1);
        }
      }
    }
  };

  function dispatchMessageToListeners(msg, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };
      const timeoutId = setTimeout(() => done({
        success: false,
        outcomeUnknown: true,
        error: 'Content action timed out. It may still have taken effect: check the page before repeating it.',
      }), timeoutMs);
      const sendResponse = (res) => {
        clearTimeout(timeoutId);
        done(res);
      };

      for (const listener of messageListeners) {
        try {
          const asyncKeepAlive = listener(msg, { id: 'webbrain-for-websites' }, sendResponse);
          if (settled) return;
          if (asyncKeepAlive === true) {
            return;
          }
        } catch (err) {
          clearTimeout(timeoutId);
          done({ success: false, error: err && err.message || String(err) });
          return;
        }
      }
      clearTimeout(timeoutId);
      done({ ok: true });
    });
  }

  // Build upstream helper namespace directly from WebBrain extension modules (isolated per file)
  const upstreamHelpers = {
    ...${calculatorJs},
    ...${activityBrainJs},
    ...${markdownRenderJs},
    ...${readPageWindowJs},
    ...${credentialFieldsJs},
  };

  // Waits get their own timeout plus a margin; everything else answers well within 8s.
  const WAIT_ACTIONS = new Set(['wait_for_element', 'wait_for_stable']);
  function contentActionTimeoutMs(action, params) {
    if (!WAIT_ACTIONS.has(action)) return 8000;
    const requested = Number(params && params.timeout) || 5000;
    return Math.min(25000, Math.max(8000, requested + 2000));
  }

  // The widget host is hidden from the AX tree and from hit-testing while the
  // content scripts read or act on the page. Calls can overlap (two runs, or a
  // click that starts a new run), so the host is restored when the last one ends.
  // Waits only poll the DOM, so they leave the host usable: the visitor can
  // still press Stop during them.
  let hostHiddenDepth = 0;
  let hostSavedAriaHidden = null;
  let hostSavedInert = false;

  function hideWidgetHost() {
    if (hostHiddenDepth++ > 0 || !widgetHostEl) return;
    hostSavedAriaHidden = widgetHostEl.getAttribute('aria-hidden');
    hostSavedInert = widgetHostEl.inert;
    widgetHostEl.setAttribute('aria-hidden', 'true');
    widgetHostEl.inert = true;
  }

  function restoreWidgetHost() {
    if (--hostHiddenDepth > 0 || !widgetHostEl) return;
    if (hostSavedAriaHidden === null) widgetHostEl.removeAttribute('aria-hidden');
    else widgetHostEl.setAttribute('aria-hidden', hostSavedAriaHidden);
    widgetHostEl.inert = hostSavedInert;
  }

  window.__wbEmbedRuntime = {
    chrome: inPageChrome,
    upstream: upstreamHelpers,
    toolNames: ${toolNames},
    setWidgetHost(el) {
      widgetHostEl = el;
    },
    onStopRequested(fn) {
      if (typeof fn === 'function') stopCallbacks.push(fn);
    },
    async dispatchContentAction(action, params = {}) {
      const hideHost = !WAIT_ACTIONS.has(action);
      const timeoutMs = contentActionTimeoutMs(action, params);
      if (hideHost) hideWidgetHost();
      try {
        return await dispatchMessageToListeners({
          target: 'content',
          action,
          params,
          // content.js stops before dispatching once the widget has given up waiting.
          actionDeadlineAt: Date.now() + timeoutMs - 250,
        }, timeoutMs);
      } finally {
        if (hideHost) restoreWidgetHost();
      }
    },
    dispatchIndicator(type, extra = {}) {
      return dispatchMessageToListeners({ type, ...extra });
    }
  };

  // Inject unmodified WebBrain extension content scripts with isolated chrome shim
  (function(chrome, browser) {
    ${accessibilityTreeJs}
    ${visualIndicatorJs}
    ${contentScriptJs}
  })(window.__wbEmbedRuntime.chrome, window.__wbEmbedRuntime.chrome);

  // Inject WebBrain for Websites UI & Agent Runtime
  ${widgetRuntimeJs}
})();
`;
}
