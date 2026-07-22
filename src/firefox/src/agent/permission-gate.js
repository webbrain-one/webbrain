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
  NAVIGATE: 'navigate',          // navigate / new_tab / go_back / go_forward to a host
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
  'read_page',
  'get_accessibility_tree',
  'get_interactive_elements',
  'get_shadow_dom',
  'shadow_dom_query',
  'get_frames',
  'extract_data',
  'get_selection',
  'find_text',
  'iframe_read',
  // Chrome transports these through CDP, but their catalogs, schemas, frame
  // URLs, outputs, and errors still originate from the inspected page.
  'list_webmcp_tools',
  'execute_webmcp_tool',
  'fetch_url',
  'research_url',
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
  // done: in Act mode the result carries page-derived verification fields
  // (pageTitle, pageUrl, pageState with dialog titles / live-region text) that
  // are persisted as the final tool message and re-read on the next user turn.
  // The model-authored `summary` is wrapped too, which is harmless.
  'done',
]);

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
  new_tab: Capability.NAVIGATE,
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
 *   - press_keys: Enter can submit/activate → CLICK; Tab/Escape are benign.
 */
export function capabilityFor(name, args) {
  args = args || {};
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
