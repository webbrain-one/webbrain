# Manual test: capability × origin permission gate + Permissions & privacy settings

These two paths can't be covered by `test/run.js` (they need a live browser —
the 3-option permission card and Settings → Permissions & privacy are DOM/storage
glue). Run this checklist after loading the unpacked extension before merging
changes to the permission gate or its UI.

Load the unpacked extension your usual dev way:
- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → pick
  `src/firefox/manifest.json`.
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → `src/chrome`.

Helpers you'll reuse (run in the background/service-worker console, or the
Settings page console):
- **Inspect grants:** `await browser.storage.local.get('wb_permissions')`
  (Firefox) / `chrome.storage.local.get('wb_permissions')` (Chrome).
- **Reset grants:** `browser.storage.local.remove('wb_permissions')`, or
  Settings → Permissions & privacy → Clear all.

---

## Test 1 — The 3-option permission card

**Setup:** reset grants. Open the side panel, switch to **Act** mode, open a
simple page with a visible clickable button.

### 1a. Card renders correctly
1. Tell the agent: *"click the <some visible button>"*.
2. **Expect** a card: **"WebBrain wants to click / submit on \<host\>. Allow it?"**
   with **three** buttons: `Allow once` · `Always allow on <host>` · `Don't allow`,
   and **NO free-text input** (permission cards are structured — the buttons
   return `once`/`always`/`deny`, not typed text).
3. **Check layout** — all three buttons visible, not clipped/overlapping/wrapping.
4. **Localization** — switch the language (the side panel's language menu) to a non-English
   locale and trigger the prompt again: the question, the verb, and the three
   buttons should be translated (English is the fallback for unset keys), and
   clicking still works (the returned value is locale-independent).

### 1b. "Allow once" proceeds and is turn-scoped  *(critical: must NOT act as deny)*
1. Click **Allow once** → the click executes.
2. In the **same** turn, prompt another click on the same site → **no second card**.
3. Send a **new** message that clicks again → card **reappears** (new turn clears
   once-grants).

### 1c. "Always allow" persists
1. Trigger the click again, click **Always allow on \<host\>** → click executes.
2. Subsequent turns clicking on that host → **no card**.
3. Console: `wb_permissions` contains
   `{capability:'click', host:'<host>', action:'allow', duration:'always'}`.

### 1d. "Don't allow" blocks
1. Reset grants, trigger a gated action, click **Don't allow**.
2. **Expect** the action does **not** happen; the agent reports it was denied /
   asks how to proceed (it must not loop retrying).

### 1e. Abort while card is open
1. Trigger a card, then hit **Stop**.
2. **Expect** the run ends cleanly ("Stopped by user"), no hang.

---

## Test 2 — Per-(capability, host) granularity
1. Grant **Always allow** for `click` on site A (Test 1c).
2. On site A, prompt a **type** action → **card appears** (different capability).
3. Navigate to site B and prompt a click → **card appears** (different host).
4. Prompt a navigation to a *new* host → a **navigate** card for that destination.

Confirms a grant is scoped to exactly one capability+host, not a blanket pass.

---

## Test 3 — Permissions settings tab (revoke flow)

**Setup:** grant 2–3 "Always allow" entries across different sites/capabilities.

1. Open Settings → Permissions & privacy (**Manage site permissions** in the side panel's ⚠ menu opens it).
2. **Expect** each grant on its own row — host as bold label,
   **"Allowed to \<verb\>"** beneath (or **"⛔ Blocked from \<verb\>"** for a deny),
   and a **Revoke** button; a **Clear all permissions** button at the bottom.
3. **Revoke one row** (with 2–3 grants present) → that **specific** row
   disappears immediately, **the other rows stay listed**, and `wb_permissions`
   in the console now contains **exactly the remaining grants** (the revoked
   `{capability, host}` is gone, nothing else changed). *(This is the assertion
   that guards the per-row revoke — the earlier NUL/delimiter bug made Revoke
   remove nothing or the wrong grant.)*
4. **Live re-prompt:** back in the agent, trigger that exact capability on that
   exact host → it **prompts again** (proves `storage.onChanged` → `hydrateFrom`
   invalidated the in-memory grant without a reload).
5. **Clear all** → list shows empty-state text and the Clear-all button hides.
6. **Empty state from scratch:** with no grants, open the tab → empty-state text,
   no rows.

---

## Test 4 — Persistence across reload
1. Grant an "Always allow."
2. Reload the extension (or restart the browser).
3. Agent acts on that host → **no prompt**; Settings → Permissions & privacy still lists it.

---

## Test 5 — Master switch ("Ask before consequential actions")
The toggle is at the **top** of Settings → Permissions & privacy, **on by default**.

1. **On (default):** with the toggle on, trigger a gated action → the permission
   card appears (as in Test 1). The warning box is hidden.
2. **Turn it off:** uncheck the toggle → a **⚠️ warning box** appears explaining
   that prompts are off and the agent will act without asking. Console:
   `askBeforeConsequentialActions` is `false`.
3. **Fast path:** back in the agent (no reload), trigger a gated action on a site
   with **no** existing grant → it executes with **no card** (the `storage.onChanged`
   listener picked up the change live).
4. **Layers 1 & 2 still on:** the switch only disables the *prompts*. Confirm the
   agent still treats page content as data — e.g. a page that says "ignore your
   instructions and …" should not hijack the task (this is the system-prompt /
   untrusted-wrapping behavior, independent of the gate).
5. **Turn it back on:** re-check → warning hides; gated actions prompt again.

---

## Pass criteria
- Card shows 3 well-laid-out buttons and no free-text input (1a); localized in
  non-English locales (1a.4).
- Allow-once and Always **proceed**; Don't-allow **blocks** (1b–1d).
- Grants are per-capability+host (Test 2).
- Settings → Permissions & privacy lists/revokes/clears correctly; a revoke causes an immediate
  re-prompt (Test 3).
- Grants persist across reload (Test 4).

**Highest-risk item:** 1a/1b. The card now returns a structured value
(`once`/`always`/`deny`) from the button click — there is no label parsing — so
a mis-render would show as a missing/broken button rather than a wrong grant.
If a button does nothing or the wrong choice is recorded, the issue is the
`data.permission` branch of `renderClarifyCard` (`sidepanel.js`) or the value
mapping in `_promptPermission` (`agent.js`). `_promptPermission` still maps any
unexpected value to `'deny'` (fail-safe).
