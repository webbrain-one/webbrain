// CapSolver REST client + page-side detect/inject helpers (Firefox MV2).
//
// Mirror of the Chrome MV3 version, with two differences:
//   1. `browser.*` namespace.
//   2. Page-side helpers use `browser.tabs.executeScript(tabId, {code})`
//      instead of `chrome.scripting.executeScript({func, args})`.
//
// We do not bundle the CapSolver extension. All work goes through:
//   POST /createTask     → { taskId } | { errorId, errorCode, errorDescription }
//   POST /getTaskResult  → { status: "ready"|"processing", solution? }
//   POST /getBalance     → { balance, packages }

import {
  applyCaptchaFrameVisibility,
  captchaWebsiteUrl,
  captchaTypesMatch,
  detectCaptchaCandidatesInPage,
  injectCaptchaTokenInPage,
  normalizeCaptchaType,
  selectCaptchaCandidate,
} from './captcha-frame-runtime.js';
import { buildCaptchaDiagnostics, captchaChallengeMatcherOptions } from './captcha-gate.js';
import { buildAdditionalCaptchaTask, solveWithAdditionalProvider } from './captcha-additional-providers.js';
import { solveWithHcaptchaProvider } from './captcha-hcaptcha-providers.js';
import { solveWithTwoCaptcha } from './two-captcha.js';
import { captchaProviderSupportsType } from './captcha-provider-config.js';

export { captchaTypesMatch, captchaWebsiteUrl, normalizeCaptchaType, selectCaptchaCandidate };

const API_BASE = 'https://api.capsolver.com';
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 120_000;
const DEFAULT_APP_ID = 'B7E57F27-0AD3-434D-A5B7-CF9EE7D093EE';
const CLOUD_BROKER_URL = 'http://127.0.0.1:17373/capsolver/solve';

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CapSolver ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try { return await res.json(); } catch {
    throw new Error(`CapSolver ${path} returned invalid JSON.`);
  }
}

// Preserve provider errors without guessing why a service refused a task.
function capsolverError(prefix, body) {
  return new Error(`${prefix}: ${body.errorDescription || body.errorCode || 'unknown error'}`);
}

export async function getBalance(apiKey) {
  if (!apiKey) throw new Error('No CapSolver API key configured.');
  const res = await postJson('/getBalance', { clientKey: apiKey });
  if (!res || typeof res !== 'object') throw new Error('CapSolver getBalance returned unexpected response.');
  if (res.errorId) throw capsolverError('CapSolver', res);
  if (res.balance == null || res.balance === '' || !Number.isFinite(Number(res.balance))) throw new Error('CapSolver getBalance: missing balance');
  return { balance: Number(res.balance), packages: res.packages || [] };
}

async function createTask(apiKey, task) {
  const res = await postJson('/createTask', {
    clientKey: apiKey,
    appId: DEFAULT_APP_ID,
    task,
  });
  if (!res || typeof res !== 'object') throw new Error('CapSolver createTask returned unexpected response.');
  if (res.errorId) throw capsolverError('CapSolver createTask', res);
  if (res.status !== 'ready' && !res.taskId) throw new Error('CapSolver createTask returned no taskId.');
  return res;
}

async function pollTaskResult(apiKey, taskId, { timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const effectiveTimeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : POLL_TIMEOUT_MS;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    const res = await postJson('/getTaskResult', { clientKey: apiKey, taskId });
    if (!res || typeof res !== 'object') throw new Error('CapSolver getTaskResult returned unexpected response.');
    if (res.errorId) throw capsolverError('CapSolver getTaskResult', res);
    if (res.status === 'ready') return res.solution || {};
    if (!['idle', 'processing'].includes(res.status)) throw new Error('CapSolver getTaskResult returned an unexpected status.');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`CapSolver: timed out after ${Math.round(timeoutMs / 1000)}s waiting for solution.`);
}

// We default to the "proxyless" task types so the user doesn't need to BYO
// proxy. `enterprisePayload` is deliberately absent from the solve_captcha
// schema: the frame detector extracts the site-specific Enterprise `s` token
// from the widget host or anchor URL and passes it through internally.

// Type aliases the model or the detector may hand us. Kept as sets rather
// than inline `||` chains so buildTask and captchaParamError below can't
// drift apart on which spellings count as v3.
const RECAPTCHA_V2_TYPES = new Set(['recaptcha_v2', 'recaptchav2', 'recaptcha_v2_enterprise', 'recaptcha_enterprise']);
const RECAPTCHA_V3_TYPES = new Set(['recaptcha_v3', 'recaptchav3', 'recaptcha_v3_enterprise']);

// Validate the params CapSolver would reject before we spend a request on
// them. Exported so agent.js can run it *before* it flags the tool call as
// dispatched — a missing pageAction is a local argument error, not an
// external side effect. Returns an error string, or null when the params
// are usable.
export function captchaParamError(params) {
  const t = String(params?.type || '').toLowerCase();
  if (!t) return 'solve_captcha: type is required.';
  if (RECAPTCHA_V3_TYPES.has(t) && !(params.pageAction || params.action)) {
    return `solve_captcha: ${params.type} requires a \`pageAction\` (e.g. "login", "submit"). reCAPTCHA v3 scores the action name, so WebBrain requires the observed action before requesting a token — pass \`pageAction\` explicitly.`;
  }
  if (RECAPTCHA_V3_TYPES.has(t) && params.minScore != null && ![0.3, 0.7, 0.9].includes(params.minScore)) {
    return 'solve_captcha: minScore must be 0.3, 0.7, or 0.9 for compatible provider fallback.';
  }
  return null;
}

export function buildTask({ type, websiteURL, websiteKey, ...rest }) {
  const t = String(type || '').toLowerCase();
  const isEnterprise = !!rest.isEnterprise || t.includes('enterprise');
  if (RECAPTCHA_V2_TYPES.has(t)) {
    return {
      type: isEnterprise ? 'ReCaptchaV2EnterpriseTaskProxyLess' : 'ReCaptchaV2TaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.isInvisible != null ? { isInvisible: !!rest.isInvisible } : {}),
      ...(rest.pageAction ? { pageAction: rest.pageAction } : {}),
      ...(rest.recaptchaDataSValue ? { recaptchaDataSValue: rest.recaptchaDataSValue } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
      ...(rest.userAgent ? { userAgent: rest.userAgent } : {}),
    };
  }
  if (RECAPTCHA_V3_TYPES.has(t)) {
    const pageAction = rest.pageAction || rest.action;
    return {
      type: isEnterprise ? 'ReCaptchaV3EnterpriseTaskProxyLess' : 'ReCaptchaV3TaskProxyLess',
      websiteURL,
      websiteKey,
      pageAction,
      ...(rest.minScore ? { minScore: rest.minScore } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
    };
  }
  if (t === 'hcaptcha') throw new Error('hCaptcha requires manual completion; CapSolver does not have a verified hCaptcha integration.');
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.metadata ? { metadata: rest.metadata } : {}),
      ...(rest.userAgent ? { userAgent: rest.userAgent } : {}),
    };
  }
  if (t === 'image_to_text' || t === 'image') {
    return {
      type: 'ImageToTextTask',
      body: rest.body, // base64 png/jpg, no data: prefix
      ...(rest.module ? { module: rest.module } : {}),
      ...(rest.case != null ? { case: !!rest.case } : {}),
    };
  }
  throw new Error(`solve_captcha: unsupported type "${type}".`);
}

function capsolverTaskError(task) {
  return task?.type === 'AntiTurnstileTaskProxyLess' && task.metadata?.chlPageData
    ? 'CapSolver automatic Turnstile does not support Cloudflare Challenge pageData; use a compatible provider or the documented native Cloudflare Challenge task.' : null;
}

// Distinguish an entirely local schema rejection from a paid dispatch. The
// agent calls this before persisting its attempted-solve lock.
export function captchaAutomaticDispatchError(providers, params) {
  const task = params.type === 'hcaptcha' ? null : buildTask(params);
  const failures = [];
  for (const provider of providers.filter(p => captchaProviderSupportsType(p.id, params.type))) {
    try {
      if (provider.id === 'capsolver' && capsolverTaskError(task)) throw new Error(capsolverTaskError(task));
      if (provider.id === 'capmonster') buildAdditionalCaptchaTask(provider.id, task);
      return null;
    } catch (error) { failures.push(`${provider.id}: ${error.message}`); }
  }
  return failures.join(' | ') || `No enabled provider supports ${params.type}.`;
}

function solutionFor(type, solution) {
  const t = String(type || '').toLowerCase();
  // Covers every reCAPTCHA spelling — v2/v3, snake or camel, Enterprise or
  // not. They all return the token under the same solution key.
  if (t.startsWith('recaptcha')) {
    return { token: solution.gRecaptchaResponse, fieldName: 'g-recaptcha-response' };
  }
  if (t === 'hcaptcha') {
    return { token: solution.gRecaptchaResponse, fieldName: 'h-captcha-response', alsoSet: 'g-recaptcha-response' };
  }
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return { token: solution.token, fieldName: 'cf-turnstile-response' };
  }
  if (t === 'image_to_text' || t === 'image') {
    return { token: solution.text, fieldName: null };
  }
  return { token: null, fieldName: null };
}

async function solveWithCloudBroker(task) {
  const response = await fetch(CLOUD_BROKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebBrain-CapSolver-Broker': '1' },
    body: JSON.stringify({ task }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Cloud CapSolver broker failed.');
  if (!result.taskId || !result.solution || typeof result.solution !== 'object') {
    throw new Error('Cloud CapSolver broker returned an invalid result.');
  }
  return result;
}

export async function solveCaptcha(apiKey, params, { useCloudBroker = false } = {}) {
  if (!apiKey && !useCloudBroker) throw new Error('No CapSolver API key configured.');
  const paramError = captchaParamError(params);
  if (paramError) throw new Error(paramError);
  const task = buildTask(params);
  // CapSolver's standalone Turnstile schema has action/cdata, but no
  // chlPageData. Its Cloudflare Challenge API is a different, proxied task.
  // Let a compatible provider receive the complete Challenge parameters.
  if (capsolverTaskError(task)) throw new Error(capsolverTaskError(task));
  // minScore belongs to the shared fallback input. CapSolver's current v3
  // schema has no such parameter; requesting a score does not guarantee one.
  delete task.minScore;
  // Shared fallback inputs that CapSolver's current schemas do not define.
  delete task.case;
  delete task.userAgent;
  const { taskId, solution } = useCloudBroker
    ? await solveWithCloudBroker(task)
    : await (async () => {
      const created = await createTask(apiKey, task);
      // ImageToTextTask returns its answer in createTask; it must not be polled.
      if (created.status === 'ready') return { taskId: created.taskId, solution: created.solution || {} };
      return { taskId: created.taskId, solution: await pollTaskResult(apiKey, created.taskId) };
    })();
  const meta = solutionFor(params.type, solution);
  return { taskId, solution, ...meta };
}

// One tool dispatch, at most one task per enabled provider. Fallback happens
// before token injection; a page/injection failure must not spend another solve.
// A timeout can leave a paid task running upstream; fallback may charge both accounts.
export async function solveCaptchaWithProviders(providers, params) {
  if (!providers.length) throw new Error('No CAPTCHA solver is enabled with a valid API key.');
  const paramError = captchaParamError(params);
  if (paramError) throw new Error(paramError);
  const eligibleProviders = providers.filter(provider => captchaProviderSupportsType(provider.id, params.type));
  if (!eligibleProviders.length) throw new Error(`No enabled provider supports ${params.type}. Ask the user to complete it manually.`);
  const dispatchError = captchaAutomaticDispatchError(eligibleProviders, params);
  if (dispatchError) throw new Error(dispatchError);
  const task = params.type === 'hcaptcha' ? null : buildTask(params);
  const failures = [];
  for (const provider of eligibleProviders) {
    try {
      const result = provider.id === 'capsolver'
        ? await solveCaptcha(provider.apiKey, params, { useCloudBroker: provider.useCloudBroker === true })
        : await (async () => {
          const result = ['nopecha', 'nonecap'].includes(provider.id)
            ? await solveWithHcaptchaProvider(provider.id, provider.apiKey, params)
            : provider.id === '2captcha'
            ? await solveWithTwoCaptcha(provider.apiKey, task)
            : await solveWithAdditionalProvider(provider.id, provider.apiKey, task);
          return { ...result, ...solutionFor(params.type, result.solution) };
        })();
      if (typeof result.token !== 'string' || !result.token.trim()) {
        throw new Error('No usable solution returned.');
      }
      return { ...result, provider: provider.id };
    } catch (error) {
      // Some providers echo inputs in errors. Never return a saved account key.
      const message = String(error.message);
      failures.push(`${provider.id}: ${provider.apiKey ? message.split(provider.apiKey).join('[redacted]') : message}`);
    }
  }
  throw new Error(failures.join(' | '));
}

// ─── Page-side helpers (Firefox MV2 executeScript with code string) ──

export async function detectCaptcha(tabId, constraints = {}) {
  let frames;
  let navigationInspectionComplete = false;
  try {
    frames = await browser.webNavigation.getAllFrames({ tabId });
    navigationInspectionComplete = Array.isArray(frames) && frames.some(frame => frame.frameId === 0);
  } catch (_) {
    frames = [{ frameId: 0, url: '' }];
  }
  if (!Array.isArray(frames) || !frames.length) frames = [{ frameId: 0, parentFrameId: -1, url: '' }];
  const matcherOptions = JSON.stringify(captchaChallengeMatcherOptions(constraints?.challengeReadings));
  const code = `(() => {
    const detect = ${detectCaptchaCandidatesInPage.toString()};
    const matcherOptions = ${matcherOptions};
    const direct = detect(null, matcherOptions);
    const inheritedCandidates = [];
    const seenDocuments = new Set();
    const rootDocument = typeof document !== 'undefined' ? document : null;
    const rootWindow = typeof window !== 'undefined' ? window : globalThis;
    const isInheritedOriginFrame = (element, childUrl) => {
      try {
        return element.hasAttribute?.('srcdoc')
          || /^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(childUrl)
          || (!String(element.src || '') && childUrl === 'about:blank');
      } catch (_) {
        return false;
      }
    };
    const visit = (
      currentDocument,
      currentWindow,
      currentResult,
      path,
      ancestorsVisible,
      ancestorsDialogAssociated,
      depth,
    ) => {
      if (!currentDocument || depth > 12 || seenDocuments.has(currentDocument)) return;
      seenDocuments.add(currentDocument);
      const elements = Array.from(currentDocument.querySelectorAll('iframe'));
      const childFrames = Array.isArray(currentResult?.frameContext?.childFrames)
        ? currentResult.frameContext.childFrames
        : [];
      elements.forEach((element, index) => {
        let childDocument;
        let childWindow;
        let childUrl = '';
        try {
          childDocument = element.contentDocument;
          childWindow = element.contentWindow;
          childUrl = String(childWindow?.location?.href || '');
        } catch (_) {
          return;
        }
        if (!childDocument || !childWindow || !isInheritedOriginFrame(element, childUrl)) return;
        const childResult = detect(
          { document: childDocument, window: childWindow },
          matcherOptions,
        );
        const childContext = childResult?.frameContext || {};
        const childVisible = ancestorsVisible && childFrames[index]?.visible === true;
        const childDialogAssociated = ancestorsDialogAssociated
          || childFrames[index]?.dialogAssociated === true;
        const nextPath = [...path, {
          index,
          frameUrl: childContext.frameUrl || childUrl,
          frameName: childContext.frameName || '',
        }];
        for (const candidate of childResult?.candidates || []) {
          inheritedCandidates.push({
            ...candidate,
            framePath: nextPath,
            frameVisibleWithinAnchor: childVisible,
            dialogAssociated: candidate.dialogAssociated === true || childDialogAssociated,
          });
        }
        visit(
          childDocument,
          childWindow,
          childResult,
          nextPath,
          childVisible,
          childDialogAssociated,
          depth + 1,
        );
      });
    };
    visit(rootDocument, rootWindow, direct, [], true, false, 0);
    return { direct, inheritedCandidates };
  })()`;
  const batches = await Promise.all(frames.map(async frame => {
    try {
      const results = await browser.tabs.executeScript(tabId, {
        code,
        frameId: frame.frameId,
        matchAboutBlank: true,
        runAt: 'document_start',
      });
      const response = results?.[0];
      const payload = response?.direct || response;
      const pageCandidates = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.candidates) ? payload.candidates : []);
      const inheritedCandidates = Array.isArray(response?.inheritedCandidates)
        ? response.inheritedCandidates
        : [];
      return {
        directCandidates: pageCandidates.map(candidate => ({
          ...candidate,
          frameId: Number.isInteger(frame.frameId) ? frame.frameId : null,
          frameUrl: candidate.frameUrl || frame.url || '',
        })),
        inheritedCandidates: inheritedCandidates.map(candidate => ({
          ...candidate,
          frameId: Number.isInteger(frame.frameId) ? frame.frameId : null,
          frameUrl: candidate.frameUrl || '',
        })),
        frameContext: !Array.isArray(payload) && payload?.frameContext ? {
          ...payload.frameContext,
          frameId: Number.isInteger(frame.frameId) ? frame.frameId : null,
        } : null,
      };
    } catch (_) {
      return { directCandidates: [], inheritedCandidates: [], frameContext: null };
    }
  }));
  const directCandidates = batches.flatMap(batch => batch.directCandidates);
  const directSignatures = new Set(directCandidates.map(candidate =>
    `${candidate.type || ''}\n${candidate.websiteKey || ''}\n${candidate.frameUrl || ''}`
  ));
  const inheritedCandidates = batches
    .flatMap(batch => batch.inheritedCandidates)
    .filter(candidate => !directSignatures.has(
      `${candidate.type || ''}\n${candidate.websiteKey || ''}\n${candidate.frameUrl || ''}`
    ));
  const candidates = [...directCandidates, ...inheritedCandidates];
  const frameContexts = batches.map(batch => batch.frameContext).filter(Boolean);
  const visibleCandidates = applyCaptchaFrameVisibility(candidates, frameContexts, frames);
  const root = frameContexts.find(frame => frame.frameId === 0);
  return {
    ...selectCaptchaCandidate(visibleCandidates, constraints),
    rootDocument: root && Number.isFinite(root.documentTimeOrigin) && root.documentTimeOrigin > 0
      ? { url: root.frameUrl, timeOrigin: root.documentTimeOrigin } : null,
    inspectionComplete: navigationInspectionComplete && !!root
      && frames.every(frame => frameContexts.some(context => context.frameId === frame.frameId)),
    diagnostics: buildCaptchaDiagnostics({
      candidates: visibleCandidates,
      frameContexts,
      navigationFrames: frames,
    }),
  };
}

export async function readCaptchaFrameUserAgent(tabId, frameId) {
  if (!Number.isInteger(frameId)) return null;
  const results = await browser.tabs.executeScript(tabId, {
    frameId, matchAboutBlank: true, code: 'navigator.userAgent',
  });
  const value = results?.[0];
  return typeof value === 'string' && value.trim() ? value : null;
}

// document_start captures callbacks for widgets rendered during page load.
// Also ensure the bridge exists for older tabs and inherited-origin fallbacks.
const CAPTCHA_CALLBACK_BRIDGE_FILE = 'src/content/captcha-callback-bridge.js';
// Wait once for late renders or callback registration. After a successful
// field application, the retry only discovers and invokes callbacks.
const CAPTCHA_BRIDGE_SETTLE_RETRY_MS = 1500;
// scripting.executeScript resolves `files` relative to the calling
// document on Firefox MV2 (not the extension root), so the file path
// below is root-absolute. Chrome resolves relative to the root.
const CAPTCHA_CALLBACK_BRIDGE_SCRIPT_FILE = '/src/content/captcha-callback-bridge.js';

// Self-contained for MAIN-world scripting and the MV2 tag fallback. The
// injectable frameId can identify an ancestor of a srcdoc/about:blank widget.
async function installCaptchaCallbackBridgeInPage(target, src) {
  let frameDocument = document;
  let frameWindow = window;
  try {
    for (const segment of Array.isArray(target?.framePath) ? target.framePath : []) {
      const element = Array.from(frameDocument.querySelectorAll('iframe'))[segment.index];
      const nextDocument = element?.contentDocument;
      const nextWindow = element?.contentWindow;
      if (!nextDocument || !nextWindow
          || (segment.frameUrl && String(nextWindow.location.href) !== segment.frameUrl)
          || (segment.frameName && String(nextWindow.name || element.name || '') !== segment.frameName)) return false;
      frameDocument = nextDocument;
      frameWindow = nextWindow;
    }
    if (target?.frameUrl && String(frameWindow.location.href) !== target.frameUrl) return false;
    if (Number.isFinite(target?.documentTimeOrigin)
        && frameWindow.performance.timeOrigin !== target.documentTimeOrigin) return false;
    const pageWindow = frameWindow.wrappedJSObject || frameWindow;
    if (pageWindow.__webbrainCaptchaCallbacks) return true;
    // Await the script before provider dispatch or token application; merely
    // appending it leaves a race with render() in the descendant document.
    return await new Promise(resolve => {
      const script = frameDocument.createElement('script');
      const finish = success => { clearTimeout(timer); script.remove(); resolve(success); };
      const timer = setTimeout(() => finish(false), 2000);
      script.onload = () => finish(!!pageWindow.__webbrainCaptchaCallbacks);
      script.onerror = () => finish(false);
      script.src = src;
      (frameDocument.head || frameDocument.documentElement).appendChild(script);
    });
  } catch (_) {
    return false;
  }
}

export async function ensureCaptchaCallbackBridge(tabId, target = null, api = globalThis.browser || globalThis.chrome) {
  const frameIds = Number.isInteger(target?.frameId) ? [target.frameId] : null;
  const hasFramePath = Array.isArray(target?.framePath) && target.framePath.length > 0;
  try {
    if (typeof api.scripting?.executeScript === 'function') {
      const results = await api.scripting.executeScript({
        target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
        world: 'MAIN',
        ...(hasFramePath ? {
          func: installCaptchaCallbackBridgeInPage,
          args: [target, api.runtime.getURL(CAPTCHA_CALLBACK_BRIDGE_FILE)],
        } : { files: [CAPTCHA_CALLBACK_BRIDGE_SCRIPT_FILE] }),
      });
      if (hasFramePath) return results?.some(entry => entry.result === true) === true;
      return true;
    }
  } catch (_) { /* fall through to tag injection */ }
  try {
    // Runtimes without the scripting API: run the bridge through a page
    // <script> tag so it still executes in MAIN world. Page CSP may block
    // it; fail-open.
    const src = api.runtime.getURL(CAPTCHA_CALLBACK_BRIDGE_FILE);
    const code = `(${installCaptchaCallbackBridgeInPage.toString()})(${JSON.stringify(target)}, ${JSON.stringify(src)})`;
    let results;
    if (frameIds) {
      results = await api.tabs.executeScript(tabId, { frameId: frameIds[0], matchAboutBlank: true, code });
    } else {
      results = await api.tabs.executeScript(tabId, { allFrames: true, matchAboutBlank: true, code });
    }
    return results?.some(result => result === true) === true;
  } catch (_) {
    return false;
  }
}

export async function injectToken(tabId, {
  fieldName,
  alsoSet,
  token,
  respKey,
  callbackHint,
  target = null,
}) {
  if (!fieldName || !token) return { success: false, error: 'fieldName and token required' };
  if (!Number.isInteger(target?.frameId) || !target?.frameUrl || !target?.websiteKey) {
    return {
      success: false,
      fieldUpdated: false,
      targetRequired: true,
      error: 'Token was not injected because no detected CAPTCHA frame identity, URL, and site key were selected.',
    };
  }
  const pagePayload = {
    fieldName,
    alsoSet,
    token,
    respKey,
    callbackHint,
    target: target || {},
  };
  // Best-effort fallback for documents without the early content script.
  await ensureCaptchaCallbackBridge(tabId, target);
  const injectionCode = callbackOnly => `(() => {
    const inject = ${injectCaptchaTokenInPage.toString()};
    const payload = ${JSON.stringify({ ...pagePayload, callbackOnly })};
    let frameDocument = typeof document !== 'undefined' ? document : null;
    let frameWindow = typeof window !== 'undefined' ? window : globalThis;
    for (const segment of Array.isArray(payload?.target?.framePath) ? payload.target.framePath : []) {
      const elements = frameDocument ? Array.from(frameDocument.querySelectorAll('iframe')) : [];
      const element = elements[segment.index];
      if (!element) {
        return {
          success: false,
          fieldUpdated: false,
          staleTarget: true,
          error: 'The selected inherited-origin CAPTCHA frame path is no longer present.',
        };
      }
      try {
        const nextDocument = element.contentDocument;
        const nextWindow = element.contentWindow;
        const nextUrl = String(nextWindow?.location?.href || '');
        const nextName = String(nextWindow?.name || element.name || '');
        if (!nextDocument || !nextWindow
            || (segment.frameUrl && nextUrl !== segment.frameUrl)
            || (segment.frameName && nextName !== segment.frameName)) {
          return {
            success: false,
            fieldUpdated: false,
            staleTarget: true,
            error: 'The selected inherited-origin CAPTCHA frame changed before token injection.',
            frameUrl: nextUrl,
          };
        }
        frameDocument = nextDocument;
        frameWindow = nextWindow;
      } catch (_) {
        return {
          success: false,
          fieldUpdated: false,
          staleTarget: true,
          error: 'The selected inherited-origin CAPTCHA frame is no longer accessible.',
        };
      }
    }
    return inject(payload, { document: frameDocument, window: frameWindow });
  })()`;
  const runOnce = async (callbackOnly = false) => {
    const code = injectionCode(callbackOnly);
    const details = Number.isInteger(target?.frameId)
      ? { code, frameId: target.frameId, matchAboutBlank: true }
      : { code, ...(target?.frameUrl ? { allFrames: true } : {}) };
    const results = await browser.tabs.executeScript(tabId, details);
    const outputs = (results || []).filter(Boolean);
    const successes = outputs.filter(output => output.success === true);
    if (successes.length === 1) {
      return {
        ...successes[0],
        frameId: Number.isInteger(target?.frameId) ? target.frameId : null,
      };
    }
    if (successes.length > 1) {
      return {
        success: false,
        ambiguousTarget: true,
        error: 'Token injection matched more than one frame; pass an exact frameUrl.',
        matchedFrames: successes.map(output => ({ frameUrl: output.frameUrl })),
      };
    }
    return outputs.find(output => !output.skipped)
      || { success: false, error: 'injection script returned no matching frame result' };
  };
  const first = await runOnce();
  // A clean miss means the widget may be rendering right now: no callback
  // was invoked and either no callbacks were found or the widget's field /
  // site key was absent while the frame identity itself matched
  // (staleTarget without skipped). Frame-identity staleness (skipped),
  // ambiguity, and target errors cannot resolve by waiting.
  const cleanMiss = !first?.calledCallback
    && (first?.callbackCandidates === 0 || first?.staleTarget === true)
    && !first?.skipped && !first?.ambiguousTarget && !first?.targetRequired;
  if (cleanMiss) {
    await new Promise(resolve => setTimeout(resolve, CAPTCHA_BRIDGE_SETTLE_RETRY_MS));
    if (!first.success) return { ...(await runOnce()), bridgeSettleRetried: true };
    // Field events may have completed the challenge and removed its widget or
    // navigated the frame. Preserve that application even if discovery fails.
    try {
      const retry = await runOnce(true);
      if (retry.success) {
        return { ...retry, fieldUpdated: first.fieldUpdated,
          fieldsUpdated: first.fieldsUpdated, fieldsTouched: first.fieldsTouched,
          bridgeSettleRetried: true };
      }
    } catch (_) { /* The successful application may have navigated the page. */ }
    return { ...first, bridgeSettleRetried: true };
  }
  return first;
}
