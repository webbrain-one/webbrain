/**
 * Deterministic capability × origin permission gate for the WebBrain agent.
 *
 * KEEP THIS FILE PURE JS — no chrome.* / browser.* / DOM imports — so
 * test/run.js can load it under Node (same convention as markdown-link.js).
 *
 * Design (modeled on the capability/permission system in Claude for Chrome):
 * the gate does NOT inspect button text or the user's prompt wording, and it
 * uses NO language model. Every consequential tool call is mapped to a fixed
 * CAPABILITY type, and the decision is purely:
 *
 *     (capability, host)  ->  allow | deny | prompt
 *
 * The user grants a (capability, host) pairing ONCE (this turn) or ALWAYS
 * (persisted). This is language-agnostic (a "Gönder" button is a CLICK on
 * bank.com.tr, gated identically to "Send"), needs no synonym lists, and is
 * un-injectable: a page cannot talk the gate out of a decision because the
 * gate never reads page content — the human is the trust anchor.
 *
 * Read-only capabilities (read_page, get_accessibility_tree, get_selection, …)
 * are intentionally NOT gated; only state-changing / high-reach actions are.
 */

export const Capability = {
  NAVIGATE: 'navigate',          // navigate / promote_iframe / go_back / go_forward to a host
  CLICK: 'click',                // click / click_ax / iframe_click / drag_drop / Enter / submit
  TYPE: 'type',                  // type_text / type_ax / iframe_type / set_field (no submit)
  EXECUTE_JS: 'execute_js',      // execute_js
  NETWORK: 'network_write',      // fetch_url / research_url with a write method
  DOWNLOAD: 'download',          // download_* tools
  UPLOAD: 'upload',              // upload_file (attach a file to a page input)
  WINDOW: 'window',              // resize_window (changes browser window bounds)
  SCHEDULE: 'schedule',          // schedule_resume / schedule_task persistent future work
};

// Human-readable verb for the permission prompt: "WebBrain wants to <label> <host>".
export const CAPABILITY_LABEL = {
  [Capability.NAVIGATE]: 'navigate to',
  [Capability.CLICK]: 'click / submit on',
  [Capability.TYPE]: 'type into',
  [Capability.EXECUTE_JS]: 'run JavaScript on',
  [Capability.NETWORK]: 'make a network request to',
  [Capability.DOWNLOAD]: 'download files from',
  [Capability.UPLOAD]: 'upload a file on',
  [Capability.WINDOW]: 'resize the browser window for',
  [Capability.SCHEDULE]: 'schedule future work for',
};

/**
 * Tool names whose RESULTS carry page-/document-derived bytes (attacker-
 * controllable) and must be wrapped in <untrusted_page_content> before they
 * reach the model (see agent.js _wrapUntrusted). Co-located with the
 * capability map so the exhaustiveness test can verify every model-exposed
 * tool is classified as gated, untrusted-read, or explicitly known-safe.
 */
export const UNTRUSTED_CONTENT_TOOLS = new Set([
  'chat_observe',
  'chat_send',
  'read_page',
  'get_accessibility_tree',
  // Skill-gated cross-tab reads return bounded, attacker-controlled email
  // previews/message text. They never expose the tab catalog itself.
  'read_email_verification_message',
  'get_interactive_elements',
  // The count and probe ranges come from Gmail's rendered pagination UI.
  'gmail_count_results',
  // Hidden Compact-upload discovery returns page-authored file-input labels.
  'get_file_input_targets',
  'get_shadow_dom',
  'shadow_dom_query',
  'get_frames',
  'extract_data',
  'get_selection',
  'find_text',
  'iframe_read',
  'promote_iframe',
  // Chrome transports these through CDP, but their catalogs, schemas, frame
  // URLs, outputs, and errors still originate from the inspected page.
  'list_webmcp_tools',
  'execute_webmcp_tool',
  'fetch_url',
  'research_url',
  // fal.ai returns provider-authored URLs and error text.
  'generate_image',
  // ChatGPT's answer and cited links are third-party page content.
  'delegate_research',
  'read_pdf',
  'read_page_source',
  'read_downloaded_file',
  'inspect_element_styles',
  'progress_update',
  'progress_read',
  // click/click_ax/type_text can return page-derived labels, target context,
  // option text, aria-labels, and form-state hints. Treat them as data.
  'click',
  'click_ax',
  'set_checked',
  'type_text',
  'execute_js',
  'scroll',
  'wait_for_element',
  'verify_form',
  // download family: results echo URLs (download_resource_from_page returns the
  // page-controlled src/href as sourceUrl / in its cross-origin error) and
  // attacker-settable Content-Disposition filenames.
  'download_social_media',
  'download_resource_from_page',
  'download_files',
  'download_file',
  'upload_file',
  // hover returns the element's accessible name (aria-label/title/innerText).
  'hover',
  // list_downloads returns each download's url + filename; the filename can
  // come from an attacker-set Content-Disposition header.
  'list_downloads',
  // Legacy screenshot handlers: when a vision model is configured these
  // return `description` = a transcription of the page (OCR/visual text). The
  // image itself is stripped to _attachImage (and framed there) before this
  // wrap, so only the page-derived text fields get wrapped here.
  'screenshot',
  'full_page_screenshot',
  'inspect_viewport',
  // done: in Act mode the result carries page-derived verification fields
  // (pageTitle, pageUrl, pageState with dialog titles / live-region text) that
  // are persisted as the final tool message and re-read on the next user turn.
  // The model-authored `summary` is wrapped too, which is harmless.
  'done',
]);

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Keep this small public-suffix approximation local to the pure gate. The
// permission key itself still uses the exact host; only the conservative
// same-site search classifier needs registrable-domain comparison.
const MULTI_LABEL_SITE_SUFFIXES = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in', 'co.il', 'co.th',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'com.hk',
  'com.tw', 'com.ar', 'com.co', 'com.pe', 'com.ph', 'com.my', 'com.vn',
  'gov.uk', 'gov.au', 'gov.in', 'gov.cn', 'ac.uk', 'ac.jp', 'ac.in', 'ac.kr',
  'org.uk', 'org.au', 'org.nz', 'net.au', 'net.uk',
  'github.io', 'gitlab.io', 'netlify.app', 'netlify.com', 'vercel.app',
  'pages.dev', 'workers.dev', 'herokuapp.com', 'firebaseapp.com', 'web.app',
  'glitch.me', 'cloudfront.net', 'azurewebsites.net', 'r2.dev', 'github.dev',
  // Multi-tenant hosting suffixes: without these, alice.blogspot.com and
  // victim.blogspot.com would compare equal and share a grouped approval.
  'blogspot.com', 'wordpress.com', 'wixsite.com', 'squarespace.com',
  'medium.com', 'notion.site', 'notion.so', 'webflow.io', 'shopify.com',
  'myshopify.com', 'tumblr.com', 'weebly.com', 'ghost.io', 'gitbook.io',
  'substack.com', 'storenvy.com', 'bigcartel.com', 'shopifycloud.com',
  'azureedge.net', 'amazonaws.com', 'elasticbeanstalk.com', 'appspot.com',
]);

// Three-label shared suffixes (e.g. alice.blogspot.co.uk, bucket.s3.amazonaws.com).
// When the last three labels match, the registrable domain needs four labels
// to stay tenant-specific.
const THREE_LABEL_SITE_SUFFIXES = new Set([
  'blogspot.co.uk', 'blogspot.de', 'blogspot.fr', 'blogspot.jp',
  'wordpress.co.uk', 's3.amazonaws.com',
  's3-website-us-east-1.amazonaws.com', 's3-website-eu-west-1.amazonaws.com',
]);

export const SubmitRisk = {
  LOW_RISK_SEARCH: 'low_risk_search',
  FRESH_CONFIRMATION: 'fresh_confirmation',
};

const SENSITIVE_SUBMIT_FIELD_RE = /(?:password|passwd|pwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|verification[-_\s]?code|recovery[-_\s]?code|backup[-_\s]?code|private[-_\s]?key|seed[-_\s]?phrase|passphrase|pin[-_\s]?code|card(?:[-_\s]?(?:number|no|num|holder|expiry|expiration))?|credit[-_\s]?card|cc[-_\s]?(?:number|num|exp)|cvv|cvc|security[-_\s]?code|exp(?:iry|iration)?[-_\s]?(?:date|month|year)?)/i;
const SEARCH_FIELD_RE = /(?:^|[\s_\-.])(?:q|query|search|keyword|keywords|term|terms|search[-_\s]?query)(?:$|[\s_\-.])/i;
const SEARCH_PATH_RE = /(?:^|[\s/_-])(?:search|scholar|find|results?)(?:$|[\s/?#_-])/i;
const SIDE_EFFECT_ACTION_RE = /(?:logout|log[-_]?out|sign[-_]?out|delete|remove|destroy|cancel|unsubscribe|disable|close[-_]?account|terminate|pay|checkout|purchase|order|payment|transfer|withdraw|publish|post|send|message|create|update|save|confirm|approve|register|login|sign[-_]?in|password|account)/i;

function submitFieldDescriptor(field = {}) {
  return [
    field.type,
    field.name,
    field.id,
    field.autocomplete,
    field.ariaLabel,
    field.placeholder,
    field.label,
  ].map(value => String(value || '').trim()).filter(Boolean).join(' ');
}

function shortHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function registrableHost(input) {
  const host = normalizeHost(input);
  if (!host) return '';
  if (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const parts = host.split('.');
  if (parts.length < 2) return host;
  // Longest match first: a three-label shared suffix (e.g. blogspot.co.uk)
  // needs four labels to stay tenant-specific.
  if (parts.length >= 4) {
    const suffix3 = parts.slice(-3).join('.');
    if (THREE_LABEL_SITE_SUFFIXES.has(suffix3)) return parts.slice(-4).join('.');
  }
  const suffix = parts.slice(-2).join('.');
  return parts.length >= 3 && MULTI_LABEL_SITE_SUFFIXES.has(suffix)
    ? parts.slice(-3).join('.')
    : suffix;
}

/**
 * Normalized search-action identity (origin + pathname, no query/hash).
 * Binds a grouped candidate to the approved search endpoint so a different
 * form on the same registrable host does not auto-inherit the approval.
 * Query terms live in changedFields (the intent key), not here.
 */
export function normalizeSearchActionBase(input) {
  if (!input) return '';
  try {
    const parsed = new URL(String(input));
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    const host = normalizeHost(parsed.hostname);
    if (!host) return '';
    const pathname = parsed.pathname || '/';
    return `${parsed.protocol.toLowerCase()}//${host}${pathname}`;
  } catch {
    return '';
  }
}

function submitActionUrl(submitInfo = {}, currentUrlOrHost = '') {
  const rawAction = submitInfo.actionUrl || submitInfo.action || submitInfo.url || currentUrlOrHost;
  const base = submitInfo.url || currentUrlOrHost;
  try {
    const parsed = new URL(rawAction, base);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function freshSubmitRisk(reason) {
  return { risk: SubmitRisk.FRESH_CONFIRMATION, lowRisk: false, reason };
}

/**
 * Classify the resolved form, not the task wording or arbitrary page prose.
 * This is deliberately conservative: only a same-registrable-site GET search
 * with no credential/payment fields and no side-effect marker is grouped.
 */
export function classifySubmitRisk(submitInfo = {}, currentUrlOrHost = '') {
  if (submitInfo?.isSubmit !== true) return freshSubmitRisk('not a resolved form submission');
  const method = String(submitInfo.method || 'GET').trim().toUpperCase();
  if (method !== 'GET') return freshSubmitRisk(`HTTP ${method || 'GET'} form method`);

  const actionUrl = submitActionUrl(submitInfo, currentUrlOrHost);
  const pageUrl = submitInfo.url || currentUrlOrHost;
  let pageParsed = null;
  try { pageParsed = new URL(pageUrl); } catch {}
  if (!actionUrl || !pageParsed || !/^https?:$/i.test(pageParsed.protocol)) {
    return freshSubmitRisk('unresolved HTTP form action');
  }
  const actionHost = normalizeHost(actionUrl.hostname);
  const pageHost = normalizeHost(pageUrl);
  if (!actionHost || !pageHost || registrableHost(actionHost) !== registrableHost(pageHost)) {
    return freshSubmitRisk('cross-site form action');
  }

  const fields = Array.isArray(submitInfo.fields) ? submitInfo.fields.slice(0, 20) : [];
  if (!fields.length) return freshSubmitRisk('form has no resolved search fields');
  // Hidden controls are excluded from visible fields by the probe, but their
  // names/ids can still carry secrets (csrf_token, access_token, api_key).
  // The probe reports them as metadata-only hiddenFields (no values), so a
  // hidden token field still disqualifies the form from grouping.
  const hiddenFields = Array.isArray(submitInfo.hiddenFields) ? submitInfo.hiddenFields.slice(0, 20) : [];
  if (fields.some(field => SENSITIVE_SUBMIT_FIELD_RE.test(submitFieldDescriptor(field)))) {
    return freshSubmitRisk('form contains a credential or payment field');
  }
  if (hiddenFields.some(field => SENSITIVE_SUBMIT_FIELD_RE.test(submitFieldDescriptor(field)))) {
    return freshSubmitRisk('form contains a hidden credential or token field');
  }

  const pathname = actionUrl.pathname || '/';
  const actionParameters = [...actionUrl.searchParams.keys()].join(' ');
  if (SIDE_EFFECT_ACTION_RE.test(`${pathname} ${actionParameters}`)) {
    return freshSubmitRisk('form action may have side effects');
  }
  const fieldMetadata = fields.map(submitFieldDescriptor).join(' ');
  const searchLike = SEARCH_PATH_RE.test(pathname) || SEARCH_FIELD_RE.test(fieldMetadata) || SEARCH_FIELD_RE.test(actionParameters);
  if (!searchLike) return freshSubmitRisk('form is not a resolved search');

  return {
    risk: SubmitRisk.LOW_RISK_SEARCH,
    lowRisk: true,
    reason: 'same-site GET search with non-sensitive fields',
    host: actionHost,
    method,
    action: actionUrl.href,
  };
}

/**
 * A navigation can be the first action in a search flow, before the target
 * form exists. This is only a provisional candidate: the type path must still
 * re-run classifySubmitRisk against the resolved form before it can use the
 * grouped grant for data entry or submission.
 */
export function classifySearchNavigation(targetUrl, currentUrlOrHost = '') {
  let target = null;
  let current = null;
  try { target = new URL(targetUrl); } catch {}
  try { current = new URL(currentUrlOrHost); } catch {}
  if (!target || !/^https?:$/i.test(target.protocol)) return freshSubmitRisk('unresolved search navigation');
  const targetHost = normalizeHost(target.hostname);
  const currentHost = current && /^https?:$/i.test(current.protocol)
    ? normalizeHost(current.hostname)
    : '';
  if (currentHost && registrableHost(targetHost) !== registrableHost(currentHost)) {
    return freshSubmitRisk('cross-site search navigation');
  }
  const pathname = target.pathname || '/';
  const parameters = [...target.searchParams.keys()].join(' ');
  if (SIDE_EFFECT_ACTION_RE.test(`${pathname} ${parameters}`)) {
    return freshSubmitRisk('navigation target may have side effects');
  }
  if (!SEARCH_PATH_RE.test(pathname) && !SEARCH_FIELD_RE.test(parameters)) {
    return freshSubmitRisk('navigation target is not a resolved search');
  }
  return {
    risk: SubmitRisk.LOW_RISK_SEARCH,
    lowRisk: true,
    reason: 'same-site GET search navigation candidate',
    host: targetHost,
    method: 'GET',
    action: target.href,
  };
}

/**
 * Stable, task-scoped identity for retry deduplication. Values are hashed and
 * never returned, so a retry key cannot become a secret-bearing telemetry field.
 */
export function submitActionKey(submitInfo = {}, currentUrlOrHost = '') {
  const actionUrl = submitActionUrl(submitInfo, currentUrlOrHost);
  const host = normalizeHost(actionUrl?.hostname || submitInfo.host || currentUrlOrHost);
  const method = String(submitInfo.method || 'GET').trim().toUpperCase();
  const fields = Array.isArray(submitInfo.fields) ? submitInfo.fields : [];
  const hiddenFields = Array.isArray(submitInfo.hiddenFields) ? submitInfo.hiddenFields : [];
  const sensitive = [...fields, ...hiddenFields]
    .filter(field => SENSITIVE_SUBMIT_FIELD_RE.test(submitFieldDescriptor(field)))
    .map(field => submitFieldDescriptor(field));
  const changed = (Array.isArray(submitInfo.changedFields) ? submitInfo.changedFields : fields.filter(field => field?.changed))
    .map(field => [submitFieldDescriptor(field), field?.value || ''].join('='));
  return [
    host,
    actionUrl?.href || String(submitInfo.actionUrl || submitInfo.action || ''),
    method,
    `s:${shortHash(sensitive.join('|'))}`,
    `c:${shortHash(changed.join('|'))}`,
  ].join('|');
}

/**
 * True only for a fetch_url/research_url call carrying a write HTTP method —
 * the egress the `/allow-api` override was meant to pre-authorize. A GET is NOT
 * a mutation here (it can still exfiltrate via the query string), so the
 * /allow-api bypass must not cover it; cross-site GET egress still needs a host
 * grant.
 */
export function isNetworkMutation(name, args) {
  if (name !== 'fetch_url' && name !== 'research_url') return false;
  const method = String((args && args.method) || 'GET').toUpperCase();
  return MUTATION_METHODS.has(method);
}

// Tool name -> capability. EVERY side-effecting tool must be here (or handled
// in capabilityFor below). Tools absent from this map are read-only and never
// gated — adding a new state-changing tool without listing it would silently
// bypass the gate, so keep this exhaustive.
const TOOL_CAPABILITY = {
  navigate: Capability.NAVIGATE,
  // This read helper temporarily walks Gmail /pN routes before restoring the
  // exact starting URL, so it needs the same site-scoped navigation grant.
  gmail_count_results: Capability.NAVIGATE,
  promote_iframe: Capability.NAVIGATE,
  go_back: Capability.NAVIGATE,
  go_forward: Capability.NAVIGATE,
  click: Capability.CLICK,
  click_ax: Capability.CLICK,
  set_checked: Capability.CLICK,
  iframe_click: Capability.CLICK,
  drag_drop: Capability.CLICK,
  type_text: Capability.TYPE,
  type_ax: Capability.TYPE,
  iframe_type: Capability.TYPE,
  execute_js: Capability.EXECUTE_JS,
  resize_window: Capability.WINDOW,
  download_file: Capability.DOWNLOAD,
  download_files: Capability.DOWNLOAD,
  download_resource_from_page: Capability.DOWNLOAD,
  download_social_media: Capability.DOWNLOAD,
  upload_file: Capability.UPLOAD,
  chrome_web_store_upload: Capability.UPLOAD,
  chrome_web_store_publish: Capability.NETWORK,
  schedule_resume: Capability.SCHEDULE,
  schedule_task: Capability.SCHEDULE,
  // generate_image spends the user's fal.ai credits via a paid network call.
  generate_image: Capability.NETWORK,
};

/**
 * Map a tool call to its gated capability, or null if the tool is read-only /
 * not gated. Some tools are gated conditionally on their arguments:
 *   - fetch_url/research_url: ALL methods — a GET can exfiltrate data in its
 *     query string to an attacker host, and research_url opens a background
 *     tab. Gated per destination host (egress is consequential).
 *   - legacy screenshot handlers: read-only, EXCEPT save:true writes a file
 *     via downloads → DOWNLOAD. These are not model-exposed tools.
 *   - set_field: TYPE normally, but CLICK when submit:true (pressing Enter
 *     submits the form — a TYPE grant must not authorize a submit).
 *   - press_keys: Enter and page shortcuts such as ; can mutate → CLICK;
 *     Tab/Escape are benign.
 */
export function capabilityFor(name, args) {
  args = args || {};
  if (name === 'read_email_verification_message') {
    // inspect is read-only. open_message clicks a mailbox row in a disposable
    // tab and can still mark that message read on the provider's server.
    return args.action === 'open_message' ? Capability.CLICK : null;
  }
  if (name === 'execute_webmcp_tool') {
    // readOnly is only a page-authored annotation in the current WebMCP
    // protocol. Never let that hint bypass a human capability grant.
    return Capability.CLICK;
  }
  if (name === 'fetch_url' || name === 'research_url') {
    return Capability.NETWORK;
  }
  if (name === 'read_pdf') {
    // read_pdf({url}) does fetch(url, {credentials:'include'}) — an outbound,
    // COOKIE-BEARING GET to an arbitrary host, same exfil class as fetch_url
    // (worse: it sends auth cookies). Gate per destination host when an
    // explicit url is given. With no url it reads the ACTIVE TAB's own PDF (the
    // page the user is already on), not an arbitrary request → ungated.
    return args.url ? Capability.NETWORK : null;
  }
  if (name === 'read_page_source') {
    // Same policy as read_pdf: no-url reads the active tab; explicit url is
    // arbitrary network egress and must be permission-checked.
    return args.url ? Capability.NETWORK : null;
  }
  if (name === 'screenshot' || name === 'full_page_screenshot') {
    return args.save ? Capability.DOWNLOAD : null;
  }
  if (name === 'set_field') {
    return args.submit ? Capability.CLICK : Capability.TYPE;
  }
  if (name === 'press_keys') {
    const keys = JSON.stringify(args.key ?? args.keys ?? '').toLowerCase();
    const benign = /\b(tab|escape|esc)\b/.test(keys);
    const risky = /\b(enter|return)\b/.test(keys);
    // Enter (or an unrecognized key) → treat as a submit/activation; pure
    // Tab/Escape navigation is benign.
    return (benign && !risky) ? null : Capability.CLICK;
  }
  return TOOL_CAPABILITY[name] || null;
}

/**
 * The FULL set of capabilities a tool call requires — usually one
 * (= capabilityFor), but some calls do two consequential things at once.
 * set_field({submit:true}) both TYPES into a field AND submits it, so it needs
 * BOTH a TYPE grant (a CLICK grant must not authorize arbitrary typing) AND a
 * CLICK grant (a TYPE grant must not authorize a submit). The gate checks every
 * capability in the returned array.
 */
export function capabilitiesFor(name, args) {
  args = args || {};
  if (name === 'chat_send') return [Capability.TYPE, Capability.CLICK];
  if (name === 'delegate_research') {
    // agent.js substitutes explicit one-use research authorization for these
    // generic prompts only after validating the token.
    return [Capability.NAVIGATE, Capability.TYPE, Capability.CLICK];
  }
  if (name === 'set_field' && args.submit) {
    return [Capability.TYPE, Capability.CLICK];
  }
  const c = capabilityFor(name, args);
  return c ? [c] : [];
}

/** Normalize a URL or bare host to a comparable registrable-ish host. */
export function normalizeHost(input) {
  if (typeof input !== 'string' || !input) return '';
  let s = input.trim();
  if (s.startsWith('//')) s = 'https:' + s; // protocol-relative → resolvable URL
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      return new URL(s).hostname.toLowerCase().replace(/^www\./, '');
    }
  } catch { /* fall through to bare-host parsing */ }
  let h = s.toLowerCase().replace(/^www\./, '').split('/')[0];
  // strip a :port (but leave IPv6 bracket forms alone)
  if (!h.startsWith('[')) {
    const c = h.indexOf(':');
    if (c > -1 && c === h.lastIndexOf(':')) h = h.slice(0, c);
  }
  return h;
}

/**
 * Does a frame's URL belong to the host named by `urlFilter`? Used to align
 * iframe tool execution with the gate: the gate parses urlFilter to a host, so
 * frame selection must match by HOST too — not a substring of the full URL.
 * A substring match (location.href.includes("stripe.com")) would also match a
 * hostile frame like https://evil.example/?next=stripe.com and run the action
 * in the wrong origin. Matches the exact host or a subdomain of it.
 */
export function frameHostMatches(frameUrl, urlFilter) {
  if (!urlFilter) return true;
  const want = normalizeHost(urlFilter);
  if (!want) return true;
  const host = normalizeHost(frameUrl);
  return host === want || host.endsWith('.' + want);
}

/** Resolve a URL (relative / protocol-relative / absolute) to a host against a
 *  base page URL — exactly what the browser handler does (new URL(raw, base)). */
function resolveHostAgainst(url, base) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const b = (typeof base === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(base)) ? base : undefined;
    return new URL(url, b).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return normalizeHost(url);
  }
}

/**
 * Which host does this capability act on? Navigate/network/download target the
 * destination URL (resolved against the current page); click/type/execute/
 * record target the current page. Returns '' for an iframe action whose frame
 * can't be identified, so the caller fails closed. For the MULTI-host case
 * (download_files with a urls[] array) use requiredHosts() instead.
 */
export function hostForCapability(capability, args, currentUrlOrHost, toolName) {
  args = args || {};
  if (toolName === 'read_email_verification_message' && capability === Capability.CLICK) {
    // agent.js supplies this from its opaque inspected-mailbox session only to
    // the permission check; it never comes from model arguments.
    return normalizeHost(args._otpMailboxUrl);
  }
  if (toolName === 'delegate_research') return 'chatgpt.com';
  if (toolName === 'generate_image') return 'queue.fal.run';
  if (toolName === 'execute_webmcp_tool') {
    // A tool can belong to a cross-origin frame. Charge mutations to that
    // frame's resolved URL instead of borrowing the top-level page grant.
    return normalizeHost(args._webMcpTargetUrl);
  }
  if (capability === Capability.UPLOAD && toolName === 'chrome_web_store_upload') {
    return normalizeHost(args._trustedPermissionUrl);
  }
  // iframe_click / iframe_type act in a (possibly cross-origin) frame named by
  // `urlFilter`. Charge the FRAME host; if urlFilter is missing we can't
  // identify the frame → '' so the caller fails closed.
  if (toolName === 'iframe_click' || toolName === 'iframe_type' || toolName === 'promote_iframe') {
    return normalizeHost(args.urlFilter);
  }
  if (capability === Capability.NAVIGATE || capability === Capability.NETWORK || capability === Capability.DOWNLOAD) {
    if (typeof args.url === 'string' && args.url) {
      const h = resolveHostAgainst(args.url, currentUrlOrHost);
      if (h) return h;
    }
    return normalizeHost(currentUrlOrHost);
  }
  if (capability === Capability.SCHEDULE && toolName === 'schedule_task' && args?.target?.type === 'url') {
    const h = resolveHostAgainst(args.target.url, currentUrlOrHost);
    if (h) return h;
  }
  return normalizeHost(currentUrlOrHost);
}

/**
 * The full set of hosts that must be granted before a tool call runs. Usually
 * a single host (= hostForCapability), but download_files takes a `urls[]`
 * array that can span MULTIPLE hosts — each must be permission-checked, or a
 * grant for one site would authorize downloads from arbitrary others. Returns
 * [] when the target can't be identified (iframe with no urlFilter) so the
 * caller fails closed.
 */
export function requiredHosts(capability, args, currentUrlOrHost, toolName) {
  args = args || {};
  if (capability === Capability.DOWNLOAD && Array.isArray(args.urls) && args.urls.length) {
    const hosts = [];
    const seen = new Set();
    for (const u of args.urls) {
      const h = resolveHostAgainst(u, currentUrlOrHost);
      const key = h || normalizeHost(currentUrlOrHost); // url-less entry → page host
      if (key && !seen.has(key)) { seen.add(key); hosts.push(key); }
    }
    return hosts;
  }
  const h = hostForCapability(capability, args, currentUrlOrHost, toolName);
  return h ? [h] : [];
}

/**
 * Stores and evaluates (capability, host) grants. Pure logic — storage is
 * injected via async load/save hooks so this stays Node-testable. `skipAll`
 * is an optional escape hatch (e.g. an explicit autopilot setting).
 *
 * Grant shape: { capability, host, action: 'allow'|'deny', duration: 'once'|'always', ts }
 *   - 'always' grants are persisted (via save) and survive turns/sessions.
 *   - 'once' grants/denies live only until the next beginTurn().
 */
export class PermissionManager {
  constructor(opts = {}) {
    this._load = typeof opts.load === 'function' ? opts.load : null;
    this._save = typeof opts.save === 'function' ? opts.save : null;
    this._skipAll = typeof opts.skipAll === 'function' ? opts.skipAll : (() => false);
    this.permissions = [];
    this.intentGrants = [];
    this.intentCandidates = [];
    this._hydrated = false;
  }

  async hydrate() {
    if (this._hydrated) return;
    this._hydrated = true;
    if (!this._load) return;
    try {
      const stored = await this._load();
      if (Array.isArray(stored)) {
        for (const g of stored) {
          if (g && g.capability && g.host) {
            this.permissions.push({ ...g, duration: 'always' });
          }
        }
      }
    } catch { /* storage unavailable → start empty */ }
  }

  /**
   * Replace the persisted (always) grants from a fresh storage snapshot,
   * preserving in-memory once-grants. Lets a storage change — e.g. a user
   * revoking a grant in Settings — take effect immediately, without waiting
   * for the agent/service-worker to be recreated.
   */
  hydrateFrom(grants) {
    const once = this.permissions.filter(p => p.duration !== 'always');
    const always = Array.isArray(grants)
      ? grants.filter(g => g && g.capability && g.host).map(g => ({ ...g, duration: 'always' }))
      : [];
    this.permissions = [...once, ...always];
    this._hydrated = true;
  }

  /**
   * Drop a tab's transient (once) grants/denies at the start of a new user
   * turn. ONLY this tab's — the agent runs tabs concurrently (one shared
   * PermissionManager), so a new turn in one tab must not wipe a still-running
   * tab's one-time grant. "always" grants are global and untouched.
   */
  beginTurn(tabId) {
    this.permissions = this.permissions.filter(p => p.duration === 'always' || p.tabId !== tabId);
    this.intentGrants = this.intentGrants.filter(grant => grant.tabId !== tabId);
    this.intentCandidates = this.intentCandidates.filter(candidate => candidate.tabId !== tabId);
  }

  /**
   * Check a task-scoped grouped approval. Unlike an "always" grant this is
   * never persisted or shared with another tab, and the key binds the approval
   * to the resolved form plus its changed fields.
   */
  checkIntent(key, tabId, capability = null) {
    const grant = this.intentGrants.find(item =>
      item.key === String(key || '')
      && item.tabId === tabId
      && (!capability || item.capabilities.includes(capability))
    );
    if (!grant) return { allowed: false, needsPrompt: true };
    return { allowed: grant.action === 'allow', needsPrompt: false, grant };
  }

  recordIntent(key, capabilities, action, tabId) {
    const normalizedKey = String(key || '');
    if (!normalizedKey) return;
    this.intentGrants = this.intentGrants.filter(item => !(item.key === normalizedKey && item.tabId === tabId));
    this.intentGrants.push({
      key: normalizedKey,
      capabilities: [...new Set(Array.isArray(capabilities) ? capabilities : [])],
      action: action === 'allow' ? 'allow' : 'deny',
      tabId,
      ts: Date.now(),
    });
  }

  hasIntentCandidate(tabId) {
    return this.intentCandidates.some(candidate => candidate.tabId === tabId);
  }

  /**
   * Check a provisional navigation candidate. The candidate is bound to the
   * approved search endpoint (origin + pathname via normalizeSearchActionBase)
   * in addition to the registrable host, so approving one search form does not
   * auto-approve a different form or a different search URL on the same site.
   * Pass expectedAction (the new navigation target or form action) to enforce
   * the binding; omitting it preserves the legacy host-only check.
   */
  checkIntentCandidate(host, tabId, capability = null, expectedAction = '') {
    const targetSite = registrableHost(host);
    const expectedBase = normalizeSearchActionBase(expectedAction);
    const candidate = this.intentCandidates.find(item =>
      item.tabId === tabId
      && registrableHost(item.host) === targetSite
      && (!capability || item.capabilities.includes(capability))
    );
    if (!candidate) return { allowed: false, needsPrompt: true };
    if (expectedBase && candidate.actionBase && candidate.actionBase !== expectedBase) {
      return { allowed: false, needsPrompt: true };
    }
    return { allowed: candidate.action === 'allow', needsPrompt: false, candidate };
  }

  recordIntentCandidate(host, capabilities, action, tabId, actionUrl = '') {
    const normalizedHost = normalizeHost(host);
    if (!normalizedHost) return;
    this.intentCandidates = this.intentCandidates.filter(candidate => candidate.tabId !== tabId);
    this.intentCandidates.push({
      host: normalizedHost,
      capabilities: [...new Set(Array.isArray(capabilities) ? capabilities : [])],
      action: action === 'allow' ? 'allow' : 'deny',
      actionBase: normalizeSearchActionBase(actionUrl || host),
      actionUrl: String(actionUrl || '').slice(0, 300),
      tabId,
      ts: Date.now(),
    });
  }

  /**
   * Consume a single-use allow candidate after it promotes to a full intent
   * grant. Without this, one approval would auto-promote every subsequent
   * same-site search for the rest of the turn, contradicting the "only this
   * unchanged search" consent copy. Deny candidates persist so retries fail
   * closed without re-prompting.
   */
  consumeIntentCandidate(tabId) {
    const remaining = this.intentCandidates.filter(candidate =>
      !(candidate.tabId === tabId && candidate.action === 'allow')
    );
    this.intentCandidates = remaining;
  }

  clearIntentCandidates(tabId) {
    this.intentCandidates = this.intentCandidates.filter(candidate => candidate.tabId !== tabId);
  }

  /**
   * { allowed, needsPrompt, grant? } for a (host, capability) in a given tab.
   * "always" grants are global; "once" grants only count for the tab that made
   * them, so one tab's Allow-once can't silently authorize another tab.
   */
  check(host, capability, tabId) {
    if (this._skipAll()) return { allowed: true, needsPrompt: false };
    const h = normalizeHost(host);
    const g = this.permissions.find(p =>
      p.capability === capability && p.host === h &&
      (p.duration === 'always' || p.tabId === tabId));
    if (g) return { allowed: g.action === 'allow', needsPrompt: false, grant: g };
    return { allowed: false, needsPrompt: true };
  }

  /**
   * Record a decision. 'always' grants are global + persisted; 'once' grants
   * are scoped to `tabId` (transient, in-memory).
   */
  async record(host, capability, action, duration, tabId) {
    const h = normalizeHost(host);
    if (duration === 'always') {
      // Global: supersede any prior grant for (capability, host) in any tab.
      this.permissions = this.permissions.filter(p => !(p.capability === capability && p.host === h));
      this.permissions.push({ capability, host: h, action, duration: 'always', ts: Date.now() });
      if (this._save) {
        try { await this._save(this.permissions.filter(p => p.duration === 'always')); } catch { /* best-effort */ }
      }
    } else {
      // Once: scoped to this tab; supersede a prior once-grant for the same key.
      this.permissions = this.permissions.filter(p =>
        !(p.duration !== 'always' && p.capability === capability && p.host === h && p.tabId === tabId));
      this.permissions.push({ capability, host: h, action, duration: 'once', tabId, ts: Date.now() });
    }
  }

  /** All persisted (always) grants — for a settings/management UI. */
  listAlwaysGrants() {
    return this.permissions.filter(p => p.duration === 'always');
  }
}
