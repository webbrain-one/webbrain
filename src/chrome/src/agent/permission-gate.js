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
 * Read-only capabilities (read_page, get_accessibility_tree, screenshot, …)
 * are intentionally NOT gated; only state-changing / high-reach actions are.
 */

export const Capability = {
  NAVIGATE: 'navigate',          // navigate / new_tab to a host
  CLICK: 'click',                // click / click_ax / iframe_click / drag_drop / Enter / submit
  TYPE: 'type',                  // type_text / type_ax / iframe_type / set_field (no submit)
  EXECUTE_JS: 'execute_js',      // execute_js
  NETWORK: 'network_write',      // fetch_url / research_url with a write method
  DOWNLOAD: 'download',          // download_* tools
  UPLOAD: 'upload',              // upload_file (selects a local file)
  RECORD: 'record',              // record_tab (captures the tab + microphone)
};

// Human-readable verb for the permission prompt: "WebBrain wants to <label> <host>".
export const CAPABILITY_LABEL = {
  [Capability.NAVIGATE]: 'navigate to',
  [Capability.CLICK]: 'click / submit on',
  [Capability.TYPE]: 'type into',
  [Capability.EXECUTE_JS]: 'run JavaScript on',
  [Capability.NETWORK]: 'make a network request to',
  [Capability.DOWNLOAD]: 'download files from',
  [Capability.UPLOAD]: 'upload a file to',
  [Capability.RECORD]: 'record the tab (and microphone) on',
};

/**
 * Tool names whose RESULTS carry page-/document-derived bytes (attacker-
 * controllable) and must be wrapped in <untrusted_page_content> before they
 * reach the model (see agent.js _wrapUntrusted). Co-located with the
 * capability map so the exhaustiveness test can verify every model-exposed
 * tool is classified as gated, untrusted-read, or explicitly known-safe.
 */
export const UNTRUSTED_CONTENT_TOOLS = new Set([
  'read_page',
  'get_accessibility_tree',
  'get_interactive_elements',
  'get_shadow_dom',
  'shadow_dom_query',
  'get_frames',
  'extract_data',
  'get_selection',
  'iframe_read',
  'fetch_url',
  'research_url',
  'read_pdf',
  'read_downloaded_file',
  'execute_js',
  'scroll',
  'wait_for_element',
  'verify_form',
  'download_social_media',
  // screenshot / full_page_screenshot: when a vision model is configured these
  // return `description` = a transcription of the page (OCR/visual text). The
  // image itself is stripped to _attachImage (and framed there) before this
  // wrap, so only the page-derived text fields get wrapped here.
  'screenshot',
  'full_page_screenshot',
  // done: in Act mode the result carries page-derived verification fields
  // (pageTitle, pageUrl, pageState with dialog titles / live-region text) that
  // are persisted as the final tool message and re-read on the next user turn.
  // The model-authored `summary` is wrapped too, which is harmless.
  'done',
]);

// Tool name -> capability. EVERY side-effecting tool must be here (or handled
// in capabilityFor below). Tools absent from this map are read-only and never
// gated — adding a new state-changing tool without listing it would silently
// bypass the gate, so keep this exhaustive.
const TOOL_CAPABILITY = {
  navigate: Capability.NAVIGATE,
  new_tab: Capability.NAVIGATE,
  click: Capability.CLICK,
  click_ax: Capability.CLICK,
  iframe_click: Capability.CLICK,
  drag_drop: Capability.CLICK,
  type_text: Capability.TYPE,
  type_ax: Capability.TYPE,
  iframe_type: Capability.TYPE,
  execute_js: Capability.EXECUTE_JS,
  upload_file: Capability.UPLOAD,
  record_tab: Capability.RECORD,
  download_file: Capability.DOWNLOAD,
  download_files: Capability.DOWNLOAD,
  download_resource_from_page: Capability.DOWNLOAD,
  download_social_media: Capability.DOWNLOAD,
};

/**
 * Map a tool call to its gated capability, or null if the tool is read-only /
 * not gated. Some tools are gated conditionally on their arguments:
 *   - fetch_url/research_url: ALL methods — a GET can exfiltrate data in its
 *     query string to an attacker host, and research_url opens a background
 *     tab. Gated per destination host (egress is consequential).
 *   - screenshot/full_page_screenshot: read-only, EXCEPT save:true writes a
 *     file via chrome.downloads → DOWNLOAD.
 *   - set_field: TYPE normally, but CLICK when submit:true (pressing Enter
 *     submits the form — a TYPE grant must not authorize a submit).
 *   - press_keys: Enter can submit/activate → CLICK; Tab/Escape are benign.
 */
export function capabilityFor(name, args) {
  args = args || {};
  if (name === 'fetch_url' || name === 'research_url') {
    return Capability.NETWORK;
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
  // iframe_click / iframe_type act in a (possibly cross-origin) frame named by
  // `urlFilter`. Charge the FRAME host; if urlFilter is missing we can't
  // identify the frame → '' so the caller fails closed.
  if (toolName === 'iframe_click' || toolName === 'iframe_type') {
    return normalizeHost(args.urlFilter);
  }
  if (capability === Capability.NAVIGATE || capability === Capability.NETWORK || capability === Capability.DOWNLOAD) {
    if (typeof args.url === 'string' && args.url) {
      const h = resolveHostAgainst(args.url, currentUrlOrHost);
      if (h) return h;
    }
    return normalizeHost(currentUrlOrHost);
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

  /** Drop transient (once) grants/denies at the start of a new user turn. */
  beginTurn() {
    this.permissions = this.permissions.filter(p => p.duration === 'always');
  }

  /** { allowed, needsPrompt, grant? } for a (host, capability). */
  check(host, capability) {
    if (this._skipAll()) return { allowed: true, needsPrompt: false };
    const h = normalizeHost(host);
    const g = this.permissions.find(p => p.capability === capability && p.host === h);
    if (g) return { allowed: g.action === 'allow', needsPrompt: false, grant: g };
    return { allowed: false, needsPrompt: true };
  }

  /** Record a decision. 'always' grants are persisted. */
  async record(host, capability, action, duration) {
    const h = normalizeHost(host);
    this.permissions = this.permissions.filter(p => !(p.capability === capability && p.host === h));
    this.permissions.push({ capability, host: h, action, duration, ts: Date.now() });
    if (duration === 'always' && this._save) {
      try { await this._save(this.permissions.filter(p => p.duration === 'always')); } catch { /* best-effort */ }
    }
  }

  /** All persisted (always) grants — for a settings/management UI. */
  listAlwaysGrants() {
    return this.permissions.filter(p => p.duration === 'always');
  }
}
