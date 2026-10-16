// CapSolver REST client + page-side detect/inject helpers.
//
// We do not bundle the CapSolver browser extension. Instead we talk directly
// to https://api.capsolver.com:
//   POST /createTask     → { taskId } | { errorId, errorCode, errorDescription }
//   POST /getTaskResult  → { status: "ready"|"processing", solution? }
//   POST /getBalance     → { balance, packages }
//
// Automatic widget mappings live here. The complete provider-native catalog
// and structured-answer dispatch live in captcha-native-providers.js.
// Detection remains conservative when site parameters cannot be verified.

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
const DEFAULT_APP_ID = 'B7E57F27-0AD3-434D-A5B7-CF9EE7D093EE'; // CapSolver public affiliate id; used only to identify the integration.
const CLOUD_BROKER_URL = 'http://127.0.0.1:17373/capsolver/solve';

// ─── REST ──────────────────────────────────────────────────────────────

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

// Preserve the provider's explanation. A generic unsupported-service error
// does not establish that a site key is a demo key or suggest a safe retry.
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

// ─── Task builders ─────────────────────────────────────────────────────
//
// Each builder takes the params the agent / detector gathered from the page
// and returns the task object CapSolver's createTask endpoint expects. We
// default to the "proxyless" task types so the user doesn't need to BYO
// proxy — that's the simplest path and what virtually every reCAPTCHA /
// Turnstile setup actually needs.
//
// `enterprisePayload` is deliberately absent from the solve_captcha schema
// because the frame detector extracts the
// site-specific Enterprise `s` token from the widget host or anchor URL and
// passes it through internally.

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

// Pick the right token-field name + injection strategy for each captcha
// type. The DOM convention is well-documented for the ones we auto-handle.
function solutionFor(type, solution) {
  const t = String(type || '').toLowerCase();
  // Covers every reCAPTCHA spelling — v2/v3, snake or camel, Enterprise or
  // not. They all return the token under the same solution key and inject
  // into the same field.
  if (t.startsWith('recaptcha')) {
    return { token: solution.gRecaptchaResponse, fieldName: 'g-recaptcha-response' };
  }
  if (t === 'hcaptcha') {
    // Both names exist in the wild — old hCaptcha forms use h-captcha-response,
    // some sites still listen on g-recaptcha-response for hCaptcha drop-ins.
    return { token: solution.gRecaptchaResponse, fieldName: 'h-captcha-response', alsoSet: 'g-recaptcha-response' };
  }
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return { token: solution.token, fieldName: 'cf-turnstile-response' };
  }
  if (t === 'image_to_text' || t === 'image') {
    return { token: solution.text, fieldName: null }; // caller types it in
  }
  return { token: null, fieldName: null };
}

// ─── solveCaptcha — the public entry point ────────────────────────────

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

// ─── Page-side detection ───────────────────────────────────────────────
//
// Runs the self-contained detector in every frame, then ranks the returned
// candidates centrally. Keeping each candidate bound to the frame that
// exposed it lets the caller use the correct websiteURL and injection target.

export async function detectCaptcha(tabId, constraints = {}) {
  const frameTreePromise = typeof chrome.webNavigation?.getAllFrames === 'function'
    ? chrome.webNavigation.getAllFrames({ tabId })
    : Promise.resolve([]);
  const [scriptAttempt, frameTreeAttempt] = await Promise.allSettled([
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      func: detectCaptchaCandidatesInPage,
      args: [null, captchaChallengeMatcherOptions(constraints?.challengeReadings)],
    }),
    frameTreePromise,
  ]);
  const navigationFrames = frameTreeAttempt.status === 'fulfilled' && Array.isArray(frameTreeAttempt.value)
    ? frameTreeAttempt.value
    : [];
  if (scriptAttempt.status === 'rejected') {
    const cause = scriptAttempt.reason;
    const error = new Error(
      cause instanceof Error
        ? cause.message
        : String(cause || 'CAPTCHA frame inspection failed.'),
    );
    if (cause instanceof Error) error.cause = cause;
    error.captchaDiagnostics = buildCaptchaDiagnostics({ navigationFrames });
    throw error;
  }
  const results = scriptAttempt.value;
  const candidates = [];
  const frameContexts = [];
  for (const entry of results || []) {
    const payload = entry?.result;
    const pageCandidates = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.candidates) ? payload.candidates : []);
    for (const candidate of pageCandidates) {
      candidates.push({
        ...candidate,
        frameId: Number.isInteger(entry.frameId) ? entry.frameId : null,
      });
    }
    if (!Array.isArray(payload) && payload?.frameContext) {
      frameContexts.push({
        ...payload.frameContext,
        frameId: Number.isInteger(entry.frameId) ? entry.frameId : null,
      });
    }
  }
  const visibleCandidates = applyCaptchaFrameVisibility(candidates, frameContexts, navigationFrames);
  const root = frameContexts.find(frame => frame.frameId === 0);
  return {
    ...selectCaptchaCandidate(visibleCandidates, constraints),
    rootDocument: root && Number.isFinite(root.documentTimeOrigin) && root.documentTimeOrigin > 0
      ? { url: root.frameUrl, timeOrigin: root.documentTimeOrigin } : null,
    inspectionComplete: frameTreeAttempt.status === 'fulfilled' && !!root
      && navigationFrames.some(frame => frame.frameId === 0)
      && navigationFrames.every(frame => frameContexts.some(context => context.frameId === frame.frameId)),
    diagnostics: buildCaptchaDiagnostics({
      candidates: visibleCandidates,
      frameContexts,
      navigationFrames,
    }),
  };
}

export async function readCaptchaFrameUserAgent(tabId, frameId) {
  if (!Number.isInteger(frameId)) return null;
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: () => navigator.userAgent,
  });
  const value = results?.find(entry => entry?.frameId === frameId)?.result;
  return typeof value === 'string' && value.trim() ? value : null;
}

// ─── Token injection ───────────────────────────────────────────────────

// document_start captures callbacks for widgets rendered during page load.
// Also ensure the bridge exists for older tabs and inherited-origin fallbacks.
const CAPTCHA_CALLBACK_BRIDGE_FILE = 'src/content/captcha-callback-bridge.js';
// Wait once for late renders or callback registration. After a successful
// field application, the retry only discovers and invokes callbacks.
const CAPTCHA_BRIDGE_SETTLE_RETRY_MS = 1500;

export async function ensureCaptchaCallbackBridge(tabId, target = null) {
  try {
    const targetSpec = Number.isInteger(target?.frameId)
      ? { tabId, frameIds: [target.frameId] }
      : { tabId, allFrames: true };
    await chrome.scripting.executeScript({
      target: targetSpec,
      world: 'MAIN',
      files: [CAPTCHA_CALLBACK_BRIDGE_FILE],
    });
    return true;
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
  const targetSpec = Number.isInteger(target?.frameId)
    ? { tabId, frameIds: [target.frameId] }
    : (target?.frameUrl ? { tabId, allFrames: true } : { tabId });
  // Best-effort fallback for documents without the early content script.
  await ensureCaptchaCallbackBridge(tabId, target);
  const runOnce = async (callbackOnly = false) => {
    const results = await chrome.scripting.executeScript({
      target: targetSpec,
      world: 'MAIN',
      args: [{ ...pagePayload, callbackOnly }],
      func: injectCaptchaTokenInPage,
    });
    const outputs = (results || []).map(entry => ({
      ...(entry?.result || {}),
      frameId: Number.isInteger(entry?.frameId) ? entry.frameId : null,
    }));
    const successes = outputs.filter(output => output.success === true);
    if (successes.length === 1) return successes[0];
    if (successes.length > 1) {
      return {
        success: false,
        ambiguousTarget: true,
        error: 'Token injection matched more than one frame; pass an exact frameUrl.',
        matchedFrames: successes.map(output => ({ frameId: output.frameId, frameUrl: output.frameUrl })),
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
