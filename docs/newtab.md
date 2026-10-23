# New tab page

DIV can show a Mue-derived new tab page with a single DIV box. On Chrome and
Chromium it is opt-in (Firefox: see below): the last step of onboarding has a "Use DIV
as my new tab page" checkbox, ticked by default, next to "Help Improve DIV", and
Settings → General has the same switch (`newTabEnabled` in extension storage). Source:
`newtab/`. Built output: `src/{chrome,firefox}/newtab/` (committed). Build with `npm run build:newtab`.

## Opt-in

An extension cannot switch `chrome_url_overrides.newtab` on and off while it runs: the
manifest declares it for as long as the extension is installed. So the page is always what
the browser opens for a new tab, and its first script (`newtab/src/lib/gate.js`) decides,
before the app, Mue's stylesheet or any data is loaded, whether to show it:

- `newTabEnabled === true`: the page loads as described below.
- anything else (never asked, unticked, an older profile that never saw the onboarding step):
  the tab is sent to the browser's own new tab page. `chrome://newtab` is this very override, so
  that is `chrome://new-tab-page/` on Chrome and other Chromium browsers, and
  `chrome-search://local-ntp/local-ntp.html` on Microsoft Edge (which does not serve the former).
- if anything fails (no extension APIs, unreadable storage, the redirect is refused) the page
  is shown, so the user never gets a blank tab.

What this does **not** change: the manifest still declares the override, so Chrome still shows
its "this extension changed your new tab page" notice, and the Web Store review of the
override applies whether or not a user opted in. The address bar may not hold focus on an
opted-out tab for the instant before the redirect lands.

Checked: Chromium 141 with the real extension loaded (unset / off → `chrome://new-tab-page/`,
on → the DIV page). **Not checked:** Edge's `chrome-search://local-ntp/...` target (taken
from a report in the Chromium Extensions group) and other Chromium browsers (Brave, Opera,
Vivaldi may show a different default page).

### Firefox: always on, changed in Firefox's settings

Firefox cannot hand a tab to its own new tab page: on Firefox 141 `tabs.update` rejects both
`about:home` and `about:newtab` ("Illegal URL"), and navigating there from the page (location,
meta refresh, a link) is denied. So the opt-in cannot work inside the extension: on Firefox the
gate never redirects, the new tab page is always shown, and the side panel and Settings have no
switch for it. Firefox's own settings (Home → New windows and tabs) are where a user switches
back to Firefox's page.

## The box

| Mode | What happens |
|------|--------------|
| Ask | The text is handed to the side panel and **sent** (Ask is read-only). |
| Act | The panel opens in Act and the text is **sent immediately**, like Ask. The box shows a warning that Act starts working right away. If **Plan before Act** is on in DIV, the plan is still shown for approval before anything is done. |
| Search | A URL is opened (http/https only); anything else goes to the browser's default search engine via `chrome.search.query` / `browser.search.search`. Hidden if the API is missing. |

No search engine is hard-coded, and nothing typed into the box is sent to DIV's servers by
the page. The only request the page itself makes to DIV is the bulletin check below.

## Hand-off

1. In the submit handler (no `await` before it, to keep the user gesture) the page
   writes `{id, tabId, text, mode, createdAt}` to extension storage key
   `wbNewtabHandoff:<tabId>` (one key per tab, so different tabs cannot overwrite each
   other; within a tab the box is locked synchronously at submit and stays disabled until the
   panel has claimed the task, so a second submit cannot replace it either) and opens the panel for that tab (Chrome
   `sidePanel.setOptions` + `open({tabId})`; Firefox
   `sidebarAction.open()`). If the
   panel fails to open, the page removes its own record again, so a failed submit can
   never be picked up and sent later when the panel is opened by hand.
2. It then sends `WB_NEWTAB_PANEL_OPENED`. `background.js` accepts it only from the
   extension's own `newtab/index.html` tab, on Chrome adds the tab to the
   DIV group/`panelTabs` as the install page does. Records that are never claimed
   are removed when their tab closes and cleared when the browser starts (one written in the few
   seconds before a crash is left until the start after that; the panel ignores it meanwhile). There is no
   periodic sweep: storage has no compare-and-delete, so deleting a key from an earlier
   read could take a task written in between. A stale record is simply ignored by the
   panel and replaced by the next submission from that tab (the page's own lock outlasts
   the longest age the panel accepts, so a live task is never replaced).
3. `src/ui/newtab-handoff.js` (identical in both extensions) in the side panel claims
   the record for the tab it is showing. It must be ≤ 4000 characters, mode
   `ask`/`act`, addressed to that tab, and ≤ 30 s old (plus however long the panel's
   own startup took, up to two minutes). Claimed records are removed; stale ones are left
   for the page to replace (see above). A task the panel has to hand back (a send declined
   after a tab switch) is queued in `wbNewtabHandoff:retry:<tabId>`, which only the panel
   writes, and is delivered when that tab is shown again.
   Nothing is claimed until the panel has finished restoring its chat (`start()`);
   after that it is tried on `storage.onChanged`, when the panel becomes visible, after
   a tab switch and after the visible-state refresh.
   - **Ask** is filled in and sent. If a run is already active in that tab it is
     queued behind it, like pressing Send. If the panel declines to send (plan review
     pending, a refresh in progress) the text stays in the composer.
   - **Act** is sent the same way, with the panel switched to Act. It is queued behind an active run and, when Plan before Act is on, goes through plan review like any Act turn.
   - Neither mode ever overwrites what is already in the composer (the user's own
     draft, a declined send). The new task is added below it for review; the panel keeps
     the mode that draft was written in, and the combined text is not sent automatically
     in that case.
   - A later hand-off is held back (retried every 150 ms, for up to about 15 s) while an
     earlier Ask's text is still in the composer waiting for its send to commit, so one
     task can never replace the other. The record stays in storage meanwhile; after the
     15 s the polling stops, and the task is picked up as soon as that send settles (or the
     next time the panel is triggered).

The text is user-typed, so it enters the panel exactly like typing in the composer;
it is never treated as page content.

## DIV bulletin

A banner slot under the box lets DIV put a short notice (an outage, an emergency, a
release note) on every new tab without an extension update. It follows the Apocalypse Mode
bulletin (`src/*/src/ui/apocalypse-comm.js`), which reads its own file.

| | New tab | Apocalypse Mode pages |
|---|---|---|
| Published file | `https://webbrain.one/newtab-comm.html` (`web/newtab-comm.html`) | `https://webbrain.one/apocalypse-comm.html` (`web/apocalypse-comm.html`) |
| Preview | `?newtab-comm=placeholder` → `newtab-comm-placeholder.html` | `?apocalypse-comm=placeholder` → `apocalypse-comm-placeholder.html` |
| How often it is read | at most once every 10 minutes per browser (cached in extension storage) | each time a page opens |

- **Off while empty.** Both files ship empty. Whitespace, a doctype and complete HTML comments
  count as empty, so commenting a notice out also switches it off. While the file is empty the
  page renders nothing and reserves no space. To publish, put a small self-contained HTML
  banner (≤ 128 KB, no scripts; the placeholder is a template) in `web/newtab-comm.html` and
  deploy the site; to clear it, empty the file again. The file must stay in `web/` even when
  empty: the site rewrites unknown paths to the landing page.
- **What is sent.** One `GET` of that fixed URL: no cookies (`credentials: 'omit'`), no
  referrer, no query string, no identifiers. webbrain.one sees the request like any page
  fetch (IP address, user agent). The answer is cached in `chrome.storage.local`
  (`wbNewtabBulletin`), coordinated across tabs via a storage lease so opening many tabs
  causes at most one request per 10 minutes. If the file cannot be read, the last bulletin
  stays up for at most 24 hours and the next attempt waits another 10 minutes. Offline or on
  any error the page shows nothing.
- **Checks.** https only, the response (after redirects) must come from `webbrain.one` or
  `www.webbrain.one`, at most 128 KB, a 5 s deadline. The markup is shown in a sandboxed
  `srcdoc` iframe that cannot run scripts (`allow-popups` only), with a Content Security
  Policy (`default-src 'none'; style-src 'unsafe-inline'; img-src data:;`) that prevents
  external subresources, `<base target="_blank">` so its links open on webbrain.one in a
  new tab, and `no-referrer`.
- **Dismiss.** The × hides that bulletin on every new tab (`wbNewtabBulletinDismissed` keeps a
  hash of its markup); a different bulletin shows again.
- It is shown whether or not the box itself is turned on, and only when the page is shown
  at all (the gate above runs first).

## Things to know

- The page reads recent chats from the `webbrain_chat_history` IndexedDB read-only and
  never creates it. Off by default.
- Chrome shows a "change it back" prompt for new-tab overrides and users cannot be
  opted out by the extension; mention the override in the store listing.
- The `search` permission is new for both browsers.
- Photo credits and the Mue notice are shown under Settings → Credits.
- Tests: `test/newtab.mjs` (`npm run test:newtab`).
