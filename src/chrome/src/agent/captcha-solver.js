// CapSolver REST client + page-side detect/inject helpers.
//
// We do not bundle the CapSolver browser extension. Instead we talk directly
// to https://api.capsolver.com:
//   POST /createTask     → { taskId } | { errorId, errorCode, errorDescription }
//   POST /getTaskResult  → { status: "ready"|"processing", solution? }
//   POST /getBalance     → { balance, packages }
//
// Coverage today: reCAPTCHA v2 (checkbox/invisible), reCAPTCHA v3, hCaptcha,
// Cloudflare Turnstile, plain image-to-text. Other types CapSolver supports
// (FunCaptcha, AWS WAF, GeeTest, datadome) are not auto-detected here yet —
// the agent can still drive them by passing an explicit `type` to
// solve_captcha and the right `taskTypeOverride`.

const API_BASE = 'https://api.capsolver.com';
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 120_000;
const DEFAULT_APP_ID = 'B7E57F27-0AD3-434D-A5B7-CF9EE7D093EE'; // CapSolver public affiliate id; used only to identify the integration.

// ─── REST ──────────────────────────────────────────────────────────────

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CapSolver ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try { return await res.json(); } catch {
    throw new Error(`CapSolver ${path} returned invalid JSON.`);
  }
}

// Wrap a CapSolver error response in a friendlier message.
//
// CapSolver returns several different error codes when it refuses a sitekey
// it considers a public TEST/DEMO key (Google's recaptcha demo, the
// hcaptcha.com demo, etc.). Two we've actually hit in the wild:
//
//   ERROR_WRONG_CAPTCHA_TYPE  ("wrong captcha type")
//   ERROR_INVALID_TASK_DATA   ("We don't support this service.")
//
// Both translate, in practice, to "this is a public test sitekey, real
// captcha solvers won't farm it because no genuine token would come back".
// The vendor-side description on its own is opaque, so we tack on a one-
// liner pointing the model (and the user, via the trace) at the real
// remedy: try on a production site.
function capsolverError(prefix, body) {
  const desc = body.errorDescription || body.errorCode || 'unknown error';
  const code = String(body.errorCode || '');
  const looksLikeDemoRejection =
    code === 'ERROR_WRONG_CAPTCHA_TYPE' ||
    code === 'ERROR_INVALID_TASK_DATA' ||
    /don['’]?t support|not support|unsupported/i.test(desc);
  if (looksLikeDemoRejection) {
    return new Error(
      `${prefix}: ${desc}. This usually means CapSolver refused the sitekey — most often because it is a public TEST/DEMO key (Google's recaptcha demo, hcaptcha.com/demo, etc.) that no captcha-solving service will farm. Try the same flow on a real production site.`
    );
  }
  return new Error(`${prefix}: ${desc}`);
}

export async function getBalance(apiKey) {
  if (!apiKey) throw new Error('No CapSolver API key configured.');
  const res = await postJson('/getBalance', { clientKey: apiKey });
  if (!res || typeof res !== 'object') throw new Error('CapSolver getBalance returned unexpected response.');
  if (res.errorId) throw capsolverError('CapSolver', res);
  return { balance: res.balance ?? 0, packages: res.packages || [] };
}

async function createTask(apiKey, task) {
  const res = await postJson('/createTask', {
    clientKey: apiKey,
    appId: DEFAULT_APP_ID,
    task,
  });
  if (!res || typeof res !== 'object') throw new Error('CapSolver createTask returned unexpected response.');
  if (res.errorId) throw capsolverError('CapSolver createTask', res);
  if (!res.taskId) throw new Error('CapSolver createTask returned no taskId.');
  return res.taskId;
}

async function pollTaskResult(apiKey, taskId, { timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const effectiveTimeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : POLL_TIMEOUT_MS;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    const res = await postJson('/getTaskResult', { clientKey: apiKey, taskId });
    if (!res || typeof res !== 'object') throw new Error('CapSolver getTaskResult returned unexpected response.');
    if (res.errorId) throw capsolverError('CapSolver getTaskResult', res);
    if (res.status === 'ready') return res.solution || {};
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
// hCaptcha / Turnstile setup actually needs.

function buildTask({ type, websiteURL, websiteKey, ...rest }) {
  const t = String(type || '').toLowerCase();
  if (t === 'recaptcha_v2' || t === 'recaptchav2') {
    return {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.isInvisible != null ? { isInvisible: !!rest.isInvisible } : {}),
      ...(rest.userAgent ? { userAgent: rest.userAgent } : {}),
    };
  }
  if (t === 'recaptcha_v3' || t === 'recaptchav3') {
    return {
      type: 'ReCaptchaV3TaskProxyLess',
      websiteURL,
      websiteKey,
      pageAction: rest.pageAction || rest.action || 'verify',
      ...(rest.minScore ? { minScore: rest.minScore } : {}),
    };
  }
  if (t === 'hcaptcha') {
    return {
      type: 'HCaptchaTaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.isInvisible != null ? { isInvisible: !!rest.isInvisible } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
      ...(rest.userAgent ? { userAgent: rest.userAgent } : {}),
    };
  }
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.metadata ? { metadata: rest.metadata } : {}),
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

// Pick the right token-field name + injection strategy for each captcha
// type. The DOM convention is well-documented for the ones we auto-handle.
function solutionFor(type, solution) {
  const t = String(type || '').toLowerCase();
  if (t === 'recaptcha_v2' || t === 'recaptchav2' || t === 'recaptcha_v3' || t === 'recaptchav3') {
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

export async function solveCaptcha(apiKey, params) {
  if (!apiKey) throw new Error('No CapSolver API key configured.');
  if (!params?.type) throw new Error('solve_captcha: type is required.');
  const task = buildTask(params);
  const taskId = await createTask(apiKey, task);
  const solution = await pollTaskResult(apiKey, taskId);
  const meta = solutionFor(params.type, solution);
  return { taskId, solution, ...meta };
}

// ─── Page-side detection ───────────────────────────────────────────────
//
// Runs in the page world via chrome.scripting.executeScript. Looks for the
// well-known DOM markers each provider drops in. Returns null when nothing
// is found so the caller can decide whether to error or fall back to
// asking the user.
//
// We intentionally inspect light DOM only — every major captcha widget
// renders its container element (the `data-sitekey` host) in the host
// page's light DOM, even if its UI lives inside a same-origin iframe.

function detectCaptchaInPage() {
  // Helper: visit same-origin iframes too, since reCAPTCHA on many sites
  // is rendered inside a same-origin wrapper. Cross-origin frames are
  // skipped (their .contentDocument throws on access).
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const d = f.contentDocument;
      if (d) docs.push(d);
    } catch { /* cross-origin */ }
  }

  for (const d of docs) {
    // Order matters: check provider-specific widgets BEFORE the generic
    // reCAPTCHA fallback. Cloudflare Turnstile and hCaptcha widgets can
    // carry `data-sitekey` + `data-callback` too, and an earlier version
    // of this function caught them with `div[data-sitekey][data-callback]`
    // and misclassified them as reCAPTCHA → CapSolver got the wrong task
    // type and failed.

    // hCaptcha (.h-captcha[data-sitekey])
    const hcap = d.querySelector('.h-captcha[data-sitekey], div[data-hcaptcha-widget-id]');
    if (hcap) {
      const sitekey = hcap.getAttribute('data-sitekey') || hcap.getAttribute('data-hcaptcha-sitekey');
      if (sitekey) {
        const size = hcap.getAttribute('data-size');
        return {
          type: 'hcaptcha',
          websiteKey: sitekey,
          isInvisible: size === 'invisible',
        };
      }
    }
    // Cloudflare Turnstile (.cf-turnstile[data-sitekey])
    const turn = d.querySelector('.cf-turnstile[data-sitekey], [data-turnstile-sitekey]');
    if (turn) {
      const sitekey = turn.getAttribute('data-sitekey') || turn.getAttribute('data-turnstile-sitekey');
      if (sitekey) {
        return { type: 'turnstile', websiteKey: sitekey };
      }
    }
    // reCAPTCHA v2/v3. Match only on reCAPTCHA-specific markers — the
    // `.g-recaptcha` class or `id="g-recaptcha-..."` — so we don't
    // accidentally grab any `data-sitekey` element from another widget.
    const recap = d.querySelector('.g-recaptcha[data-sitekey], div[id^="g-recaptcha"][data-sitekey]');
    if (recap) {
      const sitekey = recap.getAttribute('data-sitekey');
      if (sitekey) {
        const size = recap.getAttribute('data-size');
        const isInvisible = size === 'invisible';
        // v3 widgets typically carry data-action; v2 doesn't.
        const action = recap.getAttribute('data-action') || null;
        return {
          type: action ? 'recaptcha_v3' : 'recaptcha_v2',
          websiteKey: sitekey,
          isInvisible,
          ...(action ? { pageAction: action } : {}),
        };
      }
    }
    // Cloudflare "challenge platform" (the bare interstitial — no sitekey
    // exposed in DOM, just the script tag). Best we can report is presence;
    // solve_captcha will error if no key is provided.
    if (d.querySelector('script[src*="challenges.cloudflare.com/turnstile"]') ||
        d.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
      return { type: 'turnstile_challenge', websiteKey: null, note: 'Cloudflare interstitial detected but no sitekey was exposed in the DOM. Pass websiteKey explicitly if you have it.' };
    }
  }

  // ── URL-string fallback ─────────────────────────────────────────────
  // The DOM-element checks above cover the vast majority of production
  // integrations (`<div class="h-captcha" data-sitekey="...">` etc.).
  // Some pages — notably the official hcaptcha.com/demo and a handful of
  // SPA integrations that mount the widget via JS — never put the sitekey
  // on a host element in the main DOM. The sitekey IS still leaking
  // through iframe `src=` and script `src=` URLs, though, because the
  // widget script fetches its iframe with a `?sitekey=` (hCaptcha,
  // Turnstile) or `?k=` (reCAPTCHA) query parameter. iframe.src and
  // script.src are readable across origins from the parent page, so we
  // can scrape them even when the widget renders cross-origin.
  const urlCandidates = [];
  for (const el of document.querySelectorAll('iframe[src], script[src]')) {
    try { if (el.src) urlCandidates.push(el.src); } catch {}
  }
  for (const url of urlCandidates) {
    // hCaptcha
    if (/hcaptcha\.com/i.test(url)) {
      const m = url.match(/[?&#][^?&#]*?sitekey=([a-zA-Z0-9_-]{6,})/);
      if (m) {
        return { type: 'hcaptcha', websiteKey: m[1], detectedVia: 'url' };
      }
    }
    // Cloudflare Turnstile
    if (/challenges\.cloudflare\.com\/turnstile/i.test(url)) {
      const m = url.match(/[?&#][^?&#]*?sitekey=([a-zA-Z0-9_-]{6,})/);
      if (m) {
        return { type: 'turnstile', websiteKey: m[1], detectedVia: 'url' };
      }
    }
    // reCAPTCHA v2 — the anchor iframe carries the sitekey in `k=` and
    // visible (checkbox) widgets are the only kind that produce this URL
    // pattern (v3 is invisible and would have surfaced via the DOM scan
    // above if a host element existed).
    if (/recaptcha\/(api2|enterprise)\/anchor/i.test(url)) {
      const m = url.match(/[?&#]k=([a-zA-Z0-9_-]{6,})/);
      if (m) {
        return { type: 'recaptcha_v2', websiteKey: m[1], detectedVia: 'url' };
      }
    }
  }
  return null;
}

export async function detectCaptcha(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: detectCaptchaInPage,
  });
  for (const r of results || []) {
    if (r?.result) return r.result;
  }
  return null;
}

// ─── Token injection ───────────────────────────────────────────────────

function injectTokenIntoPage({ fieldName, alsoSet, token, callbackHint }) {
  if (!fieldName || !token) return { success: false, error: 'no field/token' };
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch {}
  }
  const setOn = (d, name) => {
    let el = d.querySelector(`textarea[name="${name}"]`)
          || d.querySelector(`input[name="${name}"]`);
    if (!el) {
      // Some sites only render the response textarea after the user
      // engages the widget. Create one if missing so the submit handler
      // can pick it up.
      el = d.createElement('textarea');
      el.name = name;
      el.style.display = 'none';
      (d.body || d.documentElement).appendChild(el);
    }
    el.value = token;
    el.textContent = token;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el;
  };
  let touched = 0;
  for (const d of docs) {
    setOn(d, fieldName);
    touched++;
    if (alsoSet) setOn(d, alsoSet);
  }
  // Best-effort: trigger callback registered by the widget (reCAPTCHA
  // v2/v3 sites usually wire `data-callback="onCaptcha"` on the host
  // element; some hCaptcha sites do the same with `data-callback`).
  let calledCallback = false;
  for (const d of docs) {
    const host = d.querySelector('[data-callback]');
    const cbName = host?.getAttribute('data-callback');
    if (cbName) {
      try {
        const fn = (typeof window !== 'undefined' && typeof window[cbName] === 'function') ? window[cbName] : null;
        if (fn) { fn(token); calledCallback = true; }
      } catch { /* ignore */ }
    }
  }
  return { success: true, fieldsTouched: touched, calledCallback, callbackHint: callbackHint || null };
}

export async function injectToken(tabId, { fieldName, alsoSet, token, callbackHint }) {
  if (!fieldName || !token) return { success: false, error: 'fieldName and token required' };
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    args: [{ fieldName, alsoSet, token, callbackHint }],
    func: injectTokenIntoPage,
  });
  return results?.[0]?.result || { success: false, error: 'injection script returned no result' };
}
