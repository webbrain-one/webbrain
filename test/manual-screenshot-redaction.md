# Manual test: screenshot redaction (issue #312)

Redaction needs a live vision model call and a real screenshot pipeline —
`test/run.js` only covers the pure helpers (`selectRedactionRegions`,
`mapRegionsToImage`, `mergeRedactionFrameRegions`). Use the fixture page below
to eyeball the actual pixelation before merging changes to
`agent/screenshot-redaction.js`, `content/redaction-regions.js`, or the
`st.redaction.*` settings UI.

## Setup

1. Serve the fixtures folder instead of opening it via `file://` (avoids the
   "Allow access to file URLs" extension permission entirely):
   ```
   cd test/fixtures && python3 -m http.server 8912
   ```
   then open `http://localhost:8912/screenshot-redaction-manual.html`.
2. Load the unpacked extension (Chrome: `chrome://extensions` → Developer
   mode → Load unpacked → `src/chrome`. Firefox: `about:debugging` → This
   Firefox → Load Temporary Add-on → `src/firefox/manifest.json`).
3. Settings → **Permissions & privacy** → turn **Redact sensitive content from
   screenshots** on.

## Test 1 — Redaction on, take a screenshot

With the fixture page open and active, ask the agent to `/screenshot` (or
just "take a screenshot" / "verify the page"). In the returned image, check
every element against the **REDACT**/**SKIP** tag printed next to it on the
page:

- Password, email, phone, plain text, search, url, number inputs, the
  textarea, the contenteditable div, and the `<select>` → pixelated boxes.
- Checkbox, radio, range, color, submit button → untouched (never collected).
- The two standalone "Page text — detected PII patterns" lines → pixelated.
- The "Page text — heuristic should skip" lines (the bare year, the email
  embedded in a full sentence) → untouched, by design.
- The nested same-origin iframe's password/email/phone fields → pixelated
  and correctly aligned to their on-screen position (confirms
  `mergeRedactionFrameRegions` frame-to-frame coordinate mapping).

## Test 2 — Known, documented gaps (should still leak)

These are expected to **NOT** be redacted — they're limitations called out
in the Settings warning copy and the website FAQ, not regressions:

- The canvas-drawn PII text — DOM heuristics cannot see canvas pixels.
- The password field inside the `srcdoc` iframe — Chrome's
  `match_about_blank` content-script matcher doesn't cover `srcdoc` frames.

If either of these two ever becomes covered by a future change, update the
FAQ/settings copy (`web/build/locales/en.json` `faq.screenshot_redaction`,
and `st.redaction.warning` in the locale files) to stop describing it as a
limitation.

## Test 3 — Toggle off (control)

Turn **Redact sensitive content from screenshots** off, take another
screenshot of the same page, and confirm nothing is pixelated — the password
field, emails, and phone numbers are all fully legible. This is the regression check that the
feature is truly opt-in and doesn't run at all when disabled.

## Test 4 — Fail-open on a fresh navigation

Navigate to the fixture page and *immediately* (within ~1 second, before
`document_idle` content scripts have had time to inject) ask for a
screenshot. The known fail-open behavior means the screenshot may still be
sent unredacted rather than blocked — this is expected per the Settings
warning, not a bug to file.
