# Cookie Banners

WebBrain declines cookie-consent banners itself, so an Act run does not spend a
model step on them and does not accept tracking to get past one. It uses
DuckDuckGo's [autoconsent](https://github.com/duckduckgo/autoconsent) rules,
vendored with a documented regular-expression security patch in `src/<browser>/vendor/autoconsent/` (MPL-2.0), plus a few
WebBrain rules for banners those miss (see [WebBrain's own rules](#webbrains-own-rules)).
Banners no rule knows get autoconsent's reject-only heuristic
(see [Heuristic](#heuristic-reject-only)).

## Setting

Settings → Advanced → **Cookie banners** (storage key `cookieBanners`):

| Value | Behavior |
|---|---|
| `agent` (default) | Only in tabs an Act or Dev run is driving. Ask stays read-only: declining writes a consent cookie and the site's consent platform logs the choice. |
| `everywhere` | Every tab, including normal browsing and Ask runs, because the user turned it on. |
| `off` | Never. The help text suggests it for users whose own extension already handles banners. |

`/export --config` includes the setting and `/import` restores it; a snapshot without it
restores `agent`. Another value in a snapshot is refused as invalid.

## How it works

- `src/<browser>/src/agent/cookie-banner-host.js` runs in the background. It
  injects `src/content/autoconsent-bridge.js` into covered tabs on each
  `webNavigation.onCommitted`, and into a page that was already open when a run
  starts. It imports WebBrain's `autoconsent-runtime.js` wrapper and the
  upstream ESM module with that security patch in the extension's isolated world. Those two
  modules are web-accessible resources for dynamic import; no cookie-handler
  content script is registered in the manifest.
- Before every click (including each click of a multi-element rule), the
  wrapper asks the background whether this frame is still covered. Off
  cancels existing handlers; in the default agent mode, Stop and the end of
  an Act/Dev run do too. Cancellation removes pre-hiding and blocks pending
  clicks. A new covered run starts a fresh
  instance on the same document; an older instance stays cancelled.
- The bridge forwards autoconsent's messages as `webbrain-autoconsent` /
  `webbrain-autoconsent-bg`, so autoconsent's generic types (`init`, `eval`,
  `report`) never reach WebBrain's other listeners.
- On `init`, the host replies with the compact rules for that frame, WebBrain's
  own rules for that URL, and a fixed config: opt out only, the heuristic in
  reject-only mode, hide-only rules on, banner pre-hiding for at most 2 s.
- The wrapper creates the `<style>` elements autoconsent hides with
  (`autoconsent-prehide`, `autoconsent-css-rules`) and registers them with the
  page monitor as WebBrain's own decorations, so adding them, filling them and
  removing the pre-hide style 2 s later are not reported as page changes that
  would refuse the agent's next action. A page's own element with the same id
  is not claimed.
- Some rules call the consent platform's own JavaScript. The host runs only
  autoconsent's fixed `evalSnippets`, by name, with
  `scripting.executeScript({ world: 'MAIN' })` in the frame that asked, once per
  request. Unknown snippets, frames the host did not inject and challenge frames
  get `false`.
- Before screenshots and model calls, the agent calls
  `settleCookieBannersForTurn()` (`src/<browser>/src/agent/cookie-banner-turn.js`).
  It waits for a decline in progress (at most 4 s), for 1.5 s when a rule
  matches but no banner shows (a consent tool often stays in the page after it
  was answered), and 1.2 s after autoconsent starts on the page (once its DOM
  is ready) when nothing is detected: long enough for the rules and the first
  heuristic pass.
  It adds one line to the conversation when a banner was declined or hidden
  during the run. The consent platform's name in that line is a rule's name,
  never page text; heuristic and generated rules are not named.
- Banners that neither a rule nor the heuristic recognizes still fall back to
  the prompt guidance in `UNIVERSAL_PREAMBLE`
  (`src/<browser>/src/agent/adapters.js`).

## WebBrain's own rules

`src/<browser>/src/agent/cookie-banner-rules.js` holds rules, in autoconsent's
JSON rule format, for banners the bundled rules do not cover. They are
WebBrain's own code, not copied from autoconsent, and are sent next to the
bundled rules, so autoconsent runs them the same way; a rule with a URL pattern
is tried before the generic ones.

| Rule | Covers |
|---|---|
| `Efilli` | Efilli, a Turkish consent platform. The banner sits in the open shadow root of `<efilli-layout-dynamic>`. On sites that keep the button names of Efilli's English or Turkish template (n11.com, migros.com.tr, turkcell.com.tr, isbank.com.tr, akakce.com, emlakjet.com, teknosa.com, koton.com) the rule clicks every `[data-name="Reject Button"]` or `[data-name="reddet"]`; on renamed layouts (flypgs.com, flo.com.tr) it clicks the elements whose whole text is a Turkish refusal ("Reddet", "Tümünü Reddet", ...). |
| `hepsiburada` | hepsiburada.com, whose Efilli layout renames the buttons: it clicks `#hb-reject-all` ("Reddet"). |
| `mediamarkt.com.tr` | mediamarkt.com.tr's own consent layer (autoconsent's `mediamarkt.de` rule does not match it): it clicks the `pwa-consent-layer-form` button whose text is "Reddet", found with an XPath selector. |
| `heuristic-tr` | Turkish banners no rule knows, in the page itself rather than a shadow root (lcw.com, defacto.com.tr, getir.com, carrefoursa.com): a button or link whose whole text is a Turkish refusal ("Reddet", "Tümünü reddet", "Tüm çerezleri reddet", "Reddediyorum", ...) inside a block of under 3000 characters, at most 8 levels up, that talks about cookies the way banners do ("çerez aydınlatma", "çerez politikası", "çerezler kullanıyoruz", ...). "Çerez" alone also means snacks, so it is not enough. Like the heuristic below, it is not named in the agent's note. Delete it once the vendored heuristic reads Turkish. |

When a bundled rule also recognizes a banner (`heuristic-tr` and OneTrust on
trendyol.com, say), whichever rule sees it first declines it; both click a
reject button.

To add one:

- Make sure a current autoconsent release does not already cover the site.
- Detect the visible reject control, not just the consent tool: tools often
  stay in the page after the visitor answered. A selector array is a chain;
  each later selector is searched inside the shadow root or iframe document of
  what the earlier one found.
- Use DOM steps only. The host refuses `eval` steps that are not autoconsent's
  own snippets, and these rules must not need any.
- Add a fixture to `test/cookie-banner-ui.mjs`; `test/cookie-banner-host.mjs`
  checks the rule's shape and URL matching.
- Delete the rule once autoconsent covers the site.

## Heuristic (reject only)

When no rule matches, autoconsent's heuristic (`heuristicMode: 'reject'`)
looks in the top frame for a popup-like element (fixed, sticky or dialog, also
inside open shadow roots) whose text uses cookie wording, and clicks the button
in it whose text reads as a refusal ("Reject all", "Decline", "Reddet" and so
on).

- `reject` is the only level WebBrain uses: popups without a reject button are
  left alone, and nothing is ever accepted or merely dismissed.
- It never runs in iframes, so never in CAPTCHA frames, and it skips popups
  that read like age gates.
- Its cookie wording covers English, French, German, Dutch, Spanish, Polish,
  Catalan, Basque, Galician, Russian, Italian, Swedish, Japanese and Danish.
  Turkish is not among them yet; until it is, WebBrain's `heuristic-tr` rule
  does the same job for Turkish banners outside shadow roots. Turkish patterns
  have been proposed upstream in
  [duckduckgo/autoconsent#2125](https://github.com/duckduckgo/autoconsent/pull/2125).
- The agent's note does not name a consent platform for these
  ("declined a cookie banner").

## Where it never runs

- CAPTCHA and bot-challenge frames: hCaptcha, reCAPTCHA (`google.*/recaptcha/`,
  `gstatic.com/recaptcha/`, `recaptcha.net`), Cloudflare
  (`challenges.cloudflare.com` and `/cdn-cgi/challenge-platform/`),
  Arkose/FunCaptcha, GeeTest, DataDome, AWS WAF, Friendly Captcha, MTCaptcha,
  Yandex SmartCaptcha, Tencent, NetEase Yidun, HUMAN/PerimeterX and KeyCAPTCHA.
  The CAPTCHA callback bridge once broke hCaptcha and Turnstile sites by running
  in every frame of every site; this list keeps cookie handling out of those
  frames entirely, and their eval requests are refused.
- Subframes, unless a rule names that frame's URL (consent iframes such as
  Sourcepoint's). A few frame rules have no URL pattern and would otherwise run
  in every iframe.
- The browser's own pages, store pages and the PDF viewer, where injection is
  refused.

## Network

None. Both rule sets ship with the extension and autoconsent makes no requests.

## Trying it on a live site

Choose **Decline on every website** (or start an Act run), reload the
extension after changing its files, and open the site in a fresh profile or
after clearing its site data: a site that already has your answer shows no
banner. Many sites show their banner only to visitors from some regions. A
pay-or-consent wall (accept tracking or subscribe) has no decline button:
autoconsent hides some of these walls without consenting and leaves the rest
alone.

## Other consent extensions

Running alongside Consent-O-Matic, uBlock Origin's or AdGuard's cookie lists,
Brave's blocking or similar tools does not break pages: each extension runs in
its own isolated world. Whichever tool reaches a banner first handles it; the
other finds no visible banner and does nothing. Two side effects remain: a
second autoconsent-based tool shares autoconsent's `style#autoconsent-prehide`
element, so a banner can flash for a moment, and if that extension is set to
accept some categories, WebBrain's decline can land first. WebBrain cannot see
which extensions are installed without the `management` permission, so it does
not try; users choose Off instead.

## Updating

Bump `VERSION` and `INTEGRITY` in `scripts/update-autoconsent.mjs` and run it.
It verifies the published package integrity, removes redundant cookie-noun
alternatives from the acknowledgement regex (preventing exponential
backtracking), and records both upstream and patched SHA-256 hashes in
`vendor-manifest.json`; `node scripts/update-autoconsent.mjs --check`
and `test/cookie-banner-host.mjs` verify them. Read upstream's CHANGELOG for
message or rule-format changes before updating.

## License

autoconsent is MPL-2.0, a file-level copyleft. Its files keep their license
(`vendor/autoconsent/LICENSE`, `LICENSES/MPL-2.0.txt`). The JavaScript bundles
carry one documented WebBrain regex patch, remain MPL-2.0, and are published
in full with this repository; the rules and license text are unmodified.
WebBrain's own files, including the bridge, the host and WebBrain's rules, are
under WebBrain's license, GPL-3.0-or-later; MPL-2.0 allows combining its files
with GPL code (section 3.3, "Secondary Licenses"). Further edits to the vendored
files must also stay MPL-2.0 and be published
with the extension.
