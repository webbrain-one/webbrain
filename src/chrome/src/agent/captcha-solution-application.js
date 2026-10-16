import { isEmptyCaptchaCallback } from './captcha-callback-binding.js';

// These contracts explicitly require the returned browser identity. Other
// providers can return a diagnostic UA without requiring an exact match.
// https://nonecap.com/api-reference/
// https://docs.capmonster.cloud/docs/captchas/recaptcha-v3-task/
export function requiresCaptchaUserAgent(provider, family) {
  return provider === 'nonecap' || (provider === 'capmonster' && /^recaptcha_v3(?:_enterprise)?$/.test(family));
}

// Apply only values from a completed solve. Provider responses are untrusted
// data: never evaluate returned JavaScript or navigate to a returned URL.
function valueAt(solution, path = '') {
  if (!path) return solution;
  return path.split('.').reduce((value, key) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe solution path.');
    if (value == null || !Object.hasOwn(value, key)) throw new Error(`Missing solution value: ${path}`);
    return value[key];
  }, solution);
}

export function prepareCaptchaApplication(solution, application) {
  if (!application || typeof application !== 'object') throw new Error('application is required.');
  const encode = binding => {
    const value = valueAt(solution, binding.path);
    if (binding.encoding === 'json') return JSON.stringify(value);
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Structured values require encoding: json or a callback binding.');
    return String(value);
  };
  const fields = (application.fields || []).map(binding => ({ selector: binding.selector, value: encode(binding) }));
  const cookies = (application.cookies || []).map(binding => {
    let value = encode(binding);
    // Some APIs return a Set-Cookie string. Extract only the explicitly bound
    // cookie's value; never adopt the provider's domain, path, or attributes.
    if (/[\r\n]/.test(value)) throw new Error('Invalid CAPTCHA cookie binding.');
    if (value.startsWith(`${binding.name}=`)) value = value.slice(binding.name.length + 1).split(';', 1)[0];
    return { name: binding.name, value };
  });
  if (fields.length > 20 || cookies.length > 20) throw new Error('Too many CAPTCHA bindings.');
  if (fields.some(b => typeof b.selector !== 'string' || !b.selector)) throw new Error('Every response field needs an observed selector.');
  if (cookies.some(b => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(b.name) || /[\r\n;]/.test(b.value))) throw new Error('Invalid CAPTCHA cookie binding.');
  let callback = null;
  if (application.callback && !isEmptyCaptchaCallback(application.callback)) {
    const { name, path = '' } = application.callback;
    if (typeof name !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name) || name.split('.').some(k => ['__proto__','prototype','constructor','eval','Function','location'].includes(k))) throw new Error('Use an observed named CAPTCHA callback. Omit callback when applying only cookies, fields, or clicks. Correct the binding and reuse the stored answer; do not request another solve.');
    callback = { name, value: valueAt(solution, path) };
  }
  const clicks = (application.clicks || []).map(binding => {
    const answer = valueAt(solution, binding.path);
    if (!Array.isArray(answer)) throw new Error('Recognition clicks require an array answer.');
    if (!['coordinates', 'grid', 'boolean_grid'].includes(binding.mode)) throw new Error('Unknown recognition click mode.');
    if (typeof binding.selector !== 'string' || !binding.selector) throw new Error('Recognition clicks require the observed challenge image/grid selector.');
    let points;
    if (binding.mode === 'coordinates') {
      if (!(binding.sourceWidth > 0 && binding.sourceHeight > 0)) throw new Error('Coordinate answers require source image width and height.');
      points = answer.map(point => ({ x: (Array.isArray(point) ? point[0] : point[binding.xKey || 'x']) / binding.sourceWidth, y: (Array.isArray(point) ? point[1] : point[binding.yKey || 'y']) / binding.sourceHeight }));
    } else {
      const { rows, columns } = binding;
      if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows * columns > 100) throw new Error('Grid dimensions must match the observed CAPTCHA.');
      if (binding.mode === 'boolean_grid' && (answer.length !== rows * columns || answer.some(v => typeof v !== 'boolean'))) throw new Error('Boolean recognition answer must match the grid.');
      const indexes = binding.mode === 'boolean_grid' ? answer.flatMap((v, i) => v ? [i] : []) : answer.map(v => Number(v) - (binding.oneBased === false ? 0 : 1));
      if (indexes.some(i => !Number.isInteger(i) || i < 0 || i >= rows * columns)) throw new Error('Recognition grid index is outside the challenge.');
      points = indexes.map(i => ({ x: ((i % columns) + .5) / columns, y: (Math.floor(i / columns) + .5) / rows }));
    }
    if (points.length > 100 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= 1 || p.y >= 1)) throw new Error('Recognition coordinates are outside the challenge image.');
    return { selector: binding.selector, points };
  });
  if (clicks.length > 10) throw new Error('Too many recognition targets.');
  if (!fields.length && !cookies.length && !callback && !clicks.length) throw new Error('Specify response fields, cookies, or an observed callback.');
  return { fields, cookies, callback, ...(clicks.length ? { clicks } : {}) };
}

// Capture document identities before the paid request. The same URL may reload
// while a solver is running; URL equality alone does not bind an answer safely.
export async function captureCaptchaDocuments(tabId, frames, api = globalThis.browser || globalThis.chrome) {
  const read = () => ({ url: location.href, timeOrigin: performance.timeOrigin });
  if (typeof api.scripting?.executeScript === 'function') {
    const results = await api.scripting.executeScript({ target: { tabId, allFrames: true }, injectImmediately: true, func: read });
    return results.filter(r => Number.isFinite(r.result?.timeOrigin)).map(r => ({ frameId: r.frameId, ...r.result }));
  }
  const identities = await Promise.all(frames.map(async frame => {
    try {
      const result = (await api.tabs.executeScript(tabId, { frameId: frame.frameId, runAt: 'document_start', code: `(${read.toString()})()` }))?.[0];
      return Number.isFinite(result?.timeOrigin) ? { frameId: frame.frameId, ...result } : null;
    } catch { return null; }
  }));
  return identities.filter(Boolean);
}

// A same-URL reload of either the root or selected challenge frame invalidates
// its paid answer. Null means inspection was inconclusive, not a confirmed
// reload; transient API errors must not discard a usable answer.
export async function captchaAnswerDocumentStatus(tabId, record, application, api = globalThis.browser || globalThis.chrome) {
  const tab = await api.tabs.get(tabId);
  if (tab?.url !== record.pageUrl) return 'root_changed';
  const expectedRoot = record.documents?.find(d => d.frameId === 0 && d.url === record.pageUrl);
  if (!expectedRoot) return null;
  const expectedFrame = record.documents?.find(d => d.frameId === application?.frameId && d.url === application?.frameUrl);
  const selectedFrame = expectedFrame && expectedFrame.frameId !== 0 ? expectedFrame : null;
  const frames = typeof api.webNavigation?.getAllFrames === 'function'
    ? await api.webNavigation.getAllFrames({ tabId }) : null;
  const selectedFrameMissing = selectedFrame && frames
    && !frames.some(f => f.frameId === selectedFrame.frameId && f.url === selectedFrame.url);
  const documents = await captureCaptchaDocuments(tabId, [expectedRoot, ...(selectedFrame ? [selectedFrame] : [])], api);
  const root = documents.find(d => d.frameId === 0);
  if (!root) return null;
  if (root.url !== expectedRoot.url || root.timeOrigin !== expectedRoot.timeOrigin) return 'root_changed';
  if (selectedFrame) {
    if (selectedFrameMissing) return 'frame_changed';
    const currentFrame = documents.find(d => d.frameId === selectedFrame.frameId);
    if (!currentFrame) return null;
    if (currentFrame.url !== selectedFrame.url || currentFrame.timeOrigin !== selectedFrame.timeOrigin) return 'frame_changed';
  }
  return 'current';
}

// Self-contained for MAIN-world execution in one explicitly selected frame.
export function applyCaptchaValuesInPage(expectedUrl, fields, callback, clicks = [], expectedTimeOrigin, validateOnly = false, requiredUserAgent = null) {
  if (location.href !== expectedUrl || performance.timeOrigin !== expectedTimeOrigin) return { success: false, error: 'CAPTCHA frame navigated before application.' };
  if (requiredUserAgent && navigator.userAgent !== requiredUserAgent) return {
    success: false, manualCompletionRequired: true, solverUserAgent: requiredUserAgent,
    error: 'The provider requires its returned User-Agent, which differs from this browser. The paid answer was retained and no values were applied. Complete the challenge manually; do not request another solve.',
  };
  const targets = [];
  for (const { selector, value } of fields) {
    let matches;
    try { matches = document.querySelectorAll(selector); } catch { return { success: false, error: 'Invalid response field selector.' }; }
    if (matches.length !== 1 || !/^(INPUT|TEXTAREA)$/.test(matches[0].tagName)) return { success: false, error: 'Response field must identify one input or textarea.' };
    const el = matches[0];
    if (el.tagName === 'INPUT' && ['password','file','submit','button','image'].includes(el.type)) return { success: false, error: 'Not a CAPTCHA response field.' };
    targets.push({ el, value });
  }
  const clickTargets = [];
  for (const binding of clicks) {
    let matches;
    try { matches = document.querySelectorAll(binding.selector); } catch { return { success: false, error: 'Invalid challenge image selector.' }; }
    if (matches.length !== 1) return { success: false, error: 'Recognition selector must identify one challenge image/grid.' };
    const el = matches[0], rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return { success: false, error: 'Recognition target is not visible.' };
    // Provider image pixels were normalized once before dispatch. Convert to
    // CSS viewport points here using the current, uniquely selected image.
    const points = binding.points.map(point => ({ x: rect.left + point.x * rect.width, y: rect.top + point.y * rect.height }));
    for (const point of points) {
      const target = document.elementFromPoint(point.x, point.y);
      if (!target || (target !== el && !el.contains(target))) return { success: false, error: 'Recognition target is obscured or outside the viewport.' };
      clickTargets.push({ target, point });
    }
  }
  const pageWindow = window.wrappedJSObject || window;
  let owner = pageWindow, fn;
  if (callback) {
    const parts = callback.name.split('.');
    for (const part of parts.slice(0, -1)) owner = owner?.[part];
    fn = owner?.[parts.at(-1)];
    if (typeof fn !== 'function' || /\[native code\]/.test(Function.prototype.toString.call(fn))) return { success: false, error: 'Observed CAPTCHA callback is unavailable.' };
  }
  if (validateOnly) return { success: true, validated: true };
  for (const { el, value } of targets) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  for (const { target, point } of clickTargets) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button: 0, buttons: type.endsWith('down') ? 1 : 0 }));
    }
  }
  if (callback) fn.call(owner, typeof cloneInto === 'function' && callback.value && typeof callback.value === 'object' ? cloneInto(callback.value, pageWindow) : callback.value);
  return { success: true, fieldsUpdated: targets.length, clicksApplied: clickTargets.length, calledCallback: !!callback };

}

export async function applyNativeCaptchaSolution(tabId, record, application, api = globalThis.browser || globalThis.chrome) {
  if (!record || record.applied || record.applying) throw new Error('No unapplied CAPTCHA solution is available. Do not request another solve.');
  const tab = await api.tabs.get(tabId);
  if (tab.url !== record.pageUrl) throw new Error('The page changed after the CAPTCHA solve.');
  if (Date.now() - record.createdAt > 180_000) throw new Error('The stored CAPTCHA solution has expired.');
  const { fields, cookies, callback, clicks = [] } = prepareCaptchaApplication(record.solution, application);
  if (!Number.isInteger(application.frameId) || !application.frameUrl) throw new Error('An observed frameId and exact frameUrl are required.');
  const frames = typeof api.webNavigation?.getAllFrames === 'function' ? await api.webNavigation.getAllFrames({ tabId }) : [{ frameId: 0, url: tab.url }];
  if (!frames.some(f => f.frameId === application.frameId && f.url === application.frameUrl)) throw new Error('The CAPTCHA frame no longer matches.');
  const documentIdentity = record.documents?.find(d => d.frameId === application.frameId && d.url === application.frameUrl);
  if (!documentIdentity) throw new Error('This CAPTCHA frame was not observed before solving.');
  if (cookies.length && (!api.cookies?.set || application.frameId !== 0)) throw new Error('Cookie solutions require top-level frame 0 and the cookies permission.');
  // Cookies are host-only and scoped to the active page. Returned Domain,
  // URLs, SameSite overrides, scripts, and storage dumps are never applied.
  const execute = async validateOnly => {
    const requiredUserAgent = requiresCaptchaUserAgent(record.provider, record.family) ? record.solution?.userAgent : null;
    const args = [application.frameUrl, fields, callback, clicks, documentIdentity.timeOrigin, validateOnly, requiredUserAgent];
    if (typeof api.scripting?.executeScript === 'function') {
      const results = await api.scripting.executeScript({ target: { tabId, frameIds: [application.frameId] }, world: 'MAIN', func: applyCaptchaValuesInPage, args });
      return results?.find(r => r.frameId === application.frameId)?.result;
    }
    // Firefox MV2 executes a fixed helper. JSON values remain data.
    const results = await api.tabs.executeScript(tabId, { frameId: application.frameId, matchAboutBlank: true,
      code: `(${applyCaptchaValuesInPage.toString()})(...${JSON.stringify(args)})` });
    return results?.[0];
  };
  const preflight = await execute(true);
  if (!preflight?.success) return preflight || { success: false, error: 'No result from the selected CAPTCHA frame.' };
  if (record.applied || record.applying) throw new Error('No unapplied CAPTCHA solution is available. Do not request another solve.');
  record.applying = true;
  try {
    const stores = cookies.length ? await api.cookies.getAllCookieStores() : [];
    const storeId = stores.find(store => store.tabIds.includes(tabId))?.id;
    if (cookies.length && !storeId) throw new Error('Could not identify this tab’s cookie store.');
    // Install cookies before callbacks or response-field events can submit.
    for (const cookie of cookies) {
      const current = await api.tabs.get(tabId);
      if (current.url !== record.pageUrl) throw new Error('Page changed before CAPTCHA cookie application.');
      const saved = await api.cookies.set({ url: record.pageUrl, name: cookie.name, value: cookie.value, path: '/', secure: record.pageUrl.startsWith('https:'), storeId });
      if (!saved) throw new Error('CAPTCHA cookie could not be set.');
      record.applied = true;
    }
    let applied;
    try {
      applied = await execute(false);
    } catch (error) {
      // The page may have changed after a field event or callback. Its state is
      // indeterminate, so never replay the paid answer in that case.
      record.applied = true;
      throw error;
    }
    if (!applied) {
      record.applied = true;
      return { success: false, error: 'No application result from the selected frame.' };
    }
    // The page helper returns failures only from validation before mutation.
    // Keep a field/callback/click answer available when that second check fails.
    if (!applied.success) return applied;
    record.applied = true;
    return { ...applied, cookiesUpdated: cookies.length, note: 'Solution applied; verify fresh page state. Do not request another paid solve for this challenge.' };
  } finally {
    record.applying = false;
  }
}
