// Browser-free duplicate-submit guard. This file is mirrored in the Firefox
// tree; keep both copies byte-identical.

export const SUBMIT_CLICK_WINDOW_MS = 45_000;

/**
 * Record a text click and reject a rapid duplicate of a committing control on
 * the same tab and URL. Returns the tool result to emit when blocked,
 * otherwise null. What the caption means is read by a model in any language:
 * `readCaption(text, { read })` resolves to 'commit', 'publish', another
 * reading, or null when it was not read; with `read: false` it only reports a
 * reading already made, and with `read: true` it may ask for one. A caption
 * read as anything but a commit or publication never duplicates anything and
 * needs no tab lookup; an unread caption is recorded, and a rapid second click
 * blocks only once its caption is read as one. A repeat the user approved on
 * WebBrain's card (`approved`) is allowed through but re-recorded, so a
 * further rapid duplicate needs its own answer. The model has no argument
 * that lets a repeat through. `peek` reports what a click would get without
 * recording it, so the agent can ask before the click is sent.
 */
export async function guardRecentSubmitClick(
  recentSubmitClicks,
  tabId,
  args,
  getCurrentUrl,
  now = Date.now,
  detectedTarget = null,
  readCaption = null,
  { approved = false, peek = false } = {},
) {
  if (!args?.text) return null;
  // Only app-observed preflight evidence can exempt a control. A label such
  // as "Add post" adds a thread editor; it does not publish the thread. Popup
  // launchers, links, fields and draft tools ("Add emoji") are repeatable.
  // Other ordinary activations ("Add to cart", "Create") keep the window:
  // their caption, not their structure, is what can make a second click a
  // duplicate.
  if (detectedTarget?.isSubmit === false && (detectedTarget.resolvedNonSubmitTarget === true
      || detectedTarget.resolvedPreparatoryTarget === true
      || detectedTarget.resolvedNavigationTarget === true
      || detectedTarget.resolvedEditableTarget === true)) return null;

  const rawText = String(args.text).trim();
  const reading = async read => {
    try { return typeof readCaption === 'function' ? await readCaption(rawText, { read }) : null; }
    catch { return null; }
  };
  const commits = choice => choice === 'commit' || choice === 'publish';
  const known = await reading(false);
  if (known && !commits(known)) return null;

  let currentUrl = '';
  try {
    currentUrl = await getCurrentUrl() || '';
  } catch { /* preserve empty-URL fallback */ }

  const entries = recentSubmitClicks.get(tabId) || [];
  const key = `${rawText.toLowerCase()}|${currentUrl}`;
  const timestamp = now();
  const fresh = entries.filter(entry => timestamp - entry.ts < SUBMIT_CLICK_WINDOW_MS);
  const match = fresh.find(entry => entry.key === key);

  const rerecord = () => {
    if (peek) return;
    match.ts = timestamp;
    match.url = currentUrl;
    match.text = rawText;
    recentSubmitClicks.set(tabId, fresh);
  };

  if (match && approved) {
    rerecord();
    return null;
  }

  if (match && !commits(known || await reading(true))) {
    // Not a commit, or not readable: a repeat is an ordinary click.
    rerecord();
    return null;
  }

  if (match) {
    return {
      success: false,
      dispatched: false,
      blockedDuplicateSubmit: true,
      error: `Blocked: you already clicked "${rawText}" on this page ${Math.round((timestamp - match.ts) / 1000)}s ago and the URL has not changed since. Stripe-style UIs often reuse the same label for the modal-OPEN button and the SUBMIT button inside the modal — a second click typically creates a duplicate record. Before clicking "${rawText}" again, verify: (a) that all required fields are actually filled by reading the form/page, (b) that this click is intended as a FIRST submit and not a retry. If the previous click did nothing because a field was empty, fill the field first. A repeat this soon needs the user's answer on WebBrain's card; no argument lets it through.`,
      previousClickUrl: match.url,
      previousClickAt: match.ts,
      currentUrl,
      secondsSincePrevious: Math.round((timestamp - match.ts) / 1000),
    };
  }

  if (!peek) {
    fresh.push({ key, ts: timestamp, url: currentUrl, text: rawText });
    recentSubmitClicks.set(tabId, fresh);
  }
  return null;
}
