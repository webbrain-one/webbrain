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

const API_BASE = 'https://api.capsolver.com';
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 120_000;
const DEFAULT_APP_ID = 'B7E57F27-0AD3-434D-A5B7-CF9EE7D093EE';

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

// Wrap a CapSolver error response in a friendlier message. See the chrome
// build's captcha-solver.js for the full rationale — short version:
// ERROR_WRONG_CAPTCHA_TYPE and ERROR_INVALID_TASK_DATA ("We don't support
// this service") are the codes CapSolver returns for public TEST/DEMO
// sitekeys (Google's recaptcha demo, hcaptcha.com/demo). Tack on a hint so
// the agent and the user know to try a production site.
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
      body: rest.body,
      ...(rest.module ? { module: rest.module } : {}),
      ...(rest.case != null ? { case: !!rest.case } : {}),
    };
  }
  throw new Error(`solve_captcha: unsupported type "${type}".`);
}

function solutionFor(type, solution) {
  const t = String(type || '').toLowerCase();
  if (t === 'recaptcha_v2' || t === 'recaptchav2' || t === 'recaptcha_v3' || t === 'recaptchav3') {
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

export async function solveCaptcha(apiKey, params) {
  if (!apiKey) throw new Error('No CapSolver API key configured.');
  if (!params?.type) throw new Error('solve_captcha: type is required.');
  const task = buildTask(params);
  const taskId = await createTask(apiKey, task);
  const solution = await pollTaskResult(apiKey, taskId);
  const meta = solutionFor(params.type, solution);
  return { taskId, solution, ...meta };
}

// ─── Page-side helpers (Firefox MV2 executeScript with code string) ──

const DETECT_CODE = `(() => {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch {}
  }
  for (const d of docs) {
    // Provider-specific widgets are checked BEFORE the generic reCAPTCHA
    // fallback so a Turnstile/hCaptcha widget with data-sitekey + data-callback
    // doesn't get misclassified as reCAPTCHA.
    const hcap = d.querySelector('.h-captcha[data-sitekey], div[data-hcaptcha-widget-id]');
    if (hcap) {
      const sitekey = hcap.getAttribute('data-sitekey') || hcap.getAttribute('data-hcaptcha-sitekey');
      if (sitekey) {
        const size = hcap.getAttribute('data-size');
        return { type: 'hcaptcha', websiteKey: sitekey, isInvisible: size === 'invisible' };
      }
    }
    const turn = d.querySelector('.cf-turnstile[data-sitekey], [data-turnstile-sitekey]');
    if (turn) {
      const sitekey = turn.getAttribute('data-sitekey') || turn.getAttribute('data-turnstile-sitekey');
      if (sitekey) return { type: 'turnstile', websiteKey: sitekey };
    }
    const recap = d.querySelector('.g-recaptcha[data-sitekey], div[id^="g-recaptcha"][data-sitekey]');
    if (recap) {
      const sitekey = recap.getAttribute('data-sitekey');
      if (sitekey) {
        const size = recap.getAttribute('data-size');
        const action = recap.getAttribute('data-action') || null;
        return {
          type: action ? 'recaptcha_v3' : 'recaptcha_v2',
          websiteKey: sitekey,
          isInvisible: size === 'invisible',
          ...(action ? { pageAction: action } : {}),
        };
      }
    }
    if (d.querySelector('script[src*="challenges.cloudflare.com/turnstile"]') ||
        d.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
      return { type: 'turnstile_challenge', websiteKey: null, note: 'Cloudflare interstitial detected but no sitekey was exposed in the DOM. Pass websiteKey explicitly if you have it.' };
    }
  }
  // URL-string fallback — see chrome/captcha-solver.js for the full
  // rationale. Scrapes the sitekey out of iframe.src / script.src URLs
  // when the widget did not expose it on a host element in the main DOM
  // (e.g. hcaptcha.com/demo, some SPA mounts).
  const urlCandidates = [];
  for (const el of document.querySelectorAll('iframe[src], script[src]')) {
    try { if (el.src) urlCandidates.push(el.src); } catch (_) {}
  }
  for (const url of urlCandidates) {
    if (/hcaptcha\\.com/i.test(url)) {
      const m = url.match(/[?&#][^?&#]*?sitekey=([a-zA-Z0-9_-]{6,})/);
      if (m) return { type: 'hcaptcha', websiteKey: m[1], detectedVia: 'url' };
    }
    if (/challenges\\.cloudflare\\.com\\/turnstile/i.test(url)) {
      const m = url.match(/[?&#][^?&#]*?sitekey=([a-zA-Z0-9_-]{6,})/);
      if (m) return { type: 'turnstile', websiteKey: m[1], detectedVia: 'url' };
    }
    if (/recaptcha\\/(api2|enterprise)\\/anchor/i.test(url)) {
      const m = url.match(/[?&#]k=([a-zA-Z0-9_-]{6,})/);
      if (m) return { type: 'recaptcha_v2', websiteKey: m[1], detectedVia: 'url' };
    }
  }
  return null;
})()`;

export async function detectCaptcha(tabId) {
  const results = await browser.tabs.executeScript(tabId, { code: DETECT_CODE });
  for (const r of results || []) {
    if (r) return r;
  }
  return null;
}

export async function injectToken(tabId, { fieldName, alsoSet, token }) {
  if (!fieldName || !token) return { success: false, error: 'fieldName and token required' };
  // Inline the params into the code string — Firefox MV2 doesn't have
  // chrome.scripting's args[] mechanism. JSON.stringify guarantees we
  // don't break out of the string literal.
  const code = `(() => {
    const fieldName = ${JSON.stringify(fieldName)};
    const alsoSet = ${JSON.stringify(alsoSet || null)};
    const token = ${JSON.stringify(token)};
    const docs = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch {}
    }
    const setOn = (d, name) => {
      let el = d.querySelector('textarea[name="' + name + '"]')
            || d.querySelector('input[name="' + name + '"]');
      if (!el) {
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
      setOn(d, fieldName); touched++;
      if (alsoSet) setOn(d, alsoSet);
    }
    let calledCallback = false;
    for (const d of docs) {
      const host = d.querySelector('[data-callback]');
      const cbName = host && host.getAttribute('data-callback');
      if (cbName) {
        try {
          const fn = (typeof window !== 'undefined' && typeof window[cbName] === 'function') ? window[cbName] : null;
          if (fn) { fn(token); calledCallback = true; }
        } catch {}
      }
    }
    return { success: true, fieldsTouched: touched, calledCallback };
  })()`;
  const results = await browser.tabs.executeScript(tabId, { code });
  return results?.[0] || { success: false, error: 'injection script returned no result' };
}
