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
  return await res.json();
}

export async function getBalance(apiKey) {
  if (!apiKey) throw new Error('No CapSolver API key configured.');
  const res = await postJson('/getBalance', { clientKey: apiKey });
  if (res.errorId) throw new Error(`CapSolver: ${res.errorDescription || res.errorCode}`);
  return { balance: res.balance, packages: res.packages || [] };
}

async function createTask(apiKey, task) {
  const res = await postJson('/createTask', {
    clientKey: apiKey,
    appId: DEFAULT_APP_ID,
    task,
  });
  if (res.errorId) {
    throw new Error(`CapSolver createTask: ${res.errorDescription || res.errorCode}`);
  }
  if (!res.taskId) throw new Error('CapSolver createTask returned no taskId.');
  return res.taskId;
}

async function pollTaskResult(apiKey, taskId, { timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await postJson('/getTaskResult', { clientKey: apiKey, taskId });
    if (res.errorId) {
      throw new Error(`CapSolver getTaskResult: ${res.errorDescription || res.errorCode}`);
    }
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
    // reCAPTCHA v2/v3 (.g-recaptcha or div[data-sitekey] with grecaptcha)
    const recap = d.querySelector('.g-recaptcha[data-sitekey], div[data-sitekey][data-callback], div[id^="g-recaptcha"]');
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
    // Cloudflare "challenge platform" (the bare interstitial — no sitekey
    // exposed in DOM, just the script tag). Best we can report is presence;
    // solve_captcha will error if no key is provided.
    if (d.querySelector('script[src*="challenges.cloudflare.com/turnstile"]') ||
        d.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
      return { type: 'turnstile_challenge', websiteKey: null, note: 'Cloudflare interstitial detected but no sitekey was exposed in the DOM. Pass websiteKey explicitly if you have it.' };
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
