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
  [Capability.NETWORK]: 'send a write request to',
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
]);

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
 *   - fetch_url/research_url: only when carrying a write method.
 *   - set_field: TYPE normally, but CLICK when submit:true (pressing Enter
 *     submits the form — a TYPE grant must not authorize a submit).
 *   - press_keys: Enter can submit/activate → CLICK; Tab/Escape are benign.
 */
export function capabilityFor(name, args) {
  args = args || {};
  if (name === 'fetch_url' || name === 'research_url') {
    const method = String(args.method || 'GET').toUpperCase();
    return MUTATION_METHODS.has(method) ? Capability.NETWORK : null;
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
 * Which host does this capability act on? Navigate/network target the
 * destination URL; click/type/execute/download/record target the current page.
 *
 * The destination is resolved against the current page URL (new URL(raw, base))
 * — exactly what the navigate handler does — so a relative ("/x"), protocol-
 * relative ("//attacker.example/x") or absolute URL all resolve to the host
 * the browser will actually load. Without this, "//attacker.example" parsed to
 * empty and fell back to the current host, letting a current-site grant
 * authorize a cross-origin navigation / exfiltration.
 */
export function hostForCapability(capability, args, currentUrlOrHost, toolName) {
  args = args || {};
  // iframe_click / iframe_type run in ALL frames and act on the first matching
  // selector in a (possibly cross-origin) frame named by `urlFilter` — e.g. a
  // Stripe/PayPal iframe embedded on merchant.com. Charge the permission to the
  // FRAME host. If urlFilter is missing/garbage we CANNOT identify the frame —
  // return '' so the caller FAILS CLOSED rather than charging the action to the
  // current page's grant (which would let merchant.com authorize a click inside
  // the payment provider).
  if (toolName === 'iframe_click' || toolName === 'iframe_type') {
    return normalizeHost(args.urlFilter);
  }
  // Navigate / network / download all target a URL → charge the DESTINATION
  // host (resolved against the current page), falling back to the current host
  // only when the tool carries no url (e.g. download_resource_from_page, which
  // downloads from the page itself).
  if (capability === Capability.NAVIGATE || capability === Capability.NETWORK || capability === Capability.DOWNLOAD) {
    const raw = args && args.url;
    if (typeof raw === 'string' && raw) {
      try {
        const base = (typeof currentUrlOrHost === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(currentUrlOrHost))
          ? currentUrlOrHost : undefined;
        return new URL(raw, base).hostname.toLowerCase().replace(/^www\./, '');
      } catch { /* not resolvable against base → try bare parse */ }
      const h = normalizeHost(raw);
      if (h) return h;
    }
    return normalizeHost(currentUrlOrHost);
  }
  return normalizeHost(currentUrlOrHost);
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
