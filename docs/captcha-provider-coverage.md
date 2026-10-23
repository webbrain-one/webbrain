# CAPTCHA providers: setup, coverage, fallback, and API contracts

Initial catalog audit: **2026-09-29**. Integration contracts rechecked against first-party documentation on **2026-10-01**. Chrome and Firefox share the provider catalog, request validation, transports, and result handling; their browser execution adapters remain platform-specific.

This integration exposes **seven providers and 198 catalog method variants**. A method variant can be a proxy/proxyless route, an Enterprise option, a recognition model, or a separate response mode. It is not a claim that there are 198 CAPTCHA products.

“Integrated” means DIV can validate the method's input, submit its documented request, poll when needed, and preserve its answer. It does **not** mean every website exposes the required parameters, that a token is accepted, or that authenticated live success rates have been measured. This implementation was checked with provider-contract fixtures and browser tests; no paid live solves were performed.

## Contents

- [Setup and consent](#setup-and-consent)
- [Coverage by provider](#coverage-by-provider)
- [hCaptcha](#hcaptcha)
- [Integration contract audit](#integration-contract-audit--2026-10-01)
- [Fallback and charging](#fallback-and-charging)
- [Automatic widgets and native methods](#automatic-widgets-and-native-methods)
- [Applying answers](#applying-answers)
- [Proxy, cookies, and browser identity](#proxy-cookies-and-browser-identity)
- [Security and data flow](#security-and-data-flow)
- [Troubleshooting](#troubleshooting)
- [Implementation and tests](#implementation-and-tests)
- [Complete method reference](captcha-method-reference.md)

## Setup and consent

Open **Settings → CAPTCHA**. Each provider has its own API key, enabled checkbox, Save/Test/Clear controls, supported-family list, and official documentation link.

Typing an API key checks that provider's enabled box unless the user has manually disabled it while editing. Save persists the checkbox state. A saved key can remain present while its provider is disabled. Testing a balance does not enable solving or save consent. Clearing a key disables that provider.

Open the provider's collapsed **Advanced** section to change its weight. Any number of providers can be enabled. Higher numbers are tried first; equal weights retain the default provider order.

| Provider | Default weight | API key setting | Enabled setting | Balance unit |
| --- | ---: | --- | --- | --- |
| CapSolver | 100 | `capsolverApiKey` | `captchaSolverEnabled` | Provider account balance |
| 2Captcha | 99 | `twoCaptchaApiKey` | `twoCaptchaEnabled` | Provider account balance |
| CapMonster Cloud | 98 | `capmonsterApiKey` | `capmonsterEnabled` | Provider account balance |
| SolveCaptcha (.com) | 97 | `solveCaptchaApiKey` | `solveCaptchaEnabled` | Provider account balance |
| Anti-Captcha | 96 | `antiCaptchaApiKey` | `antiCaptchaEnabled` | Provider account balance |
| NopeCHA | 95 | `nopechaApiKey` | `nopechaEnabled` | Credits |
| NoneCap | 94 | `nonecapApiKey` | `nonecapEnabled` | Credits |

CAPTCHA discovery, solving, and application tools are available only in **Act/Dev with Mid or Full tiers**. Ask never exposes these tools or receives solving instructions. Compact asks for manual completion and permits `done({outcome:"partial"})` for blocked work; Dev itself requires Mid or Full.

Keys and consent settings participate in configuration export/import. A key-only import does not silently enable a service. NoneCap uses `nc_live_` keys; NopeCHA uses opaque subscription keys, not the 32-character hexadecimal format used by several other providers. Pricing and account eligibility are controlled by the providers; [NopeCHA pricing](https://nopecha.com/pricing) is linked from Settings.

## Coverage by provider

All families below have a callable native route. The [complete method reference](captcha-method-reference.md) lists exact method identifiers, fixed wire values, required and optional fields, and primary documentation links.

| Provider | Integrated families |
| --- | --- |
| **[CapSolver](https://docs.capsolver.com/en/guide/getting-started/)** | reCAPTCHA v2/v3 and Enterprise; v3 M1 variants; GeeTest v3/v4; MTCaptcha; AWS WAF; BotDeflector; Turnstile; Cloudflare Challenge; DataDome slider/interstitial; image text; AWS and reCAPTCHA recognition; VisionEngine modules. |
| **[2Captcha](https://2captcha.com/api-docs)** | reCAPTCHA v2/v3 and Enterprise; Turnstile; GeeTest v3/v4; FunCaptcha; AWS WAF; Alibaba; Altcha; CyberSiARA; atbCAPTCHA; Basilisk; Binance; CaptchaFox; Capy; CutCaptcha; DataDome; Friendly Captcha; Hunt; Imperva; KeyCaptcha; Lemin; MTCaptcha; Prosopo; Tencent; TSPD; VK; Yandex SmartCaptcha; Yidun; image text, text questions, audio, grids, coordinates, bounding boxes, drawing, drag/drop, rotation, Temu/VK/Yandex recognition. |
| **[CapMonster Cloud](https://docs.capmonster.cloud/docs/captchas/)** | reCAPTCHA v2/v3 and Enterprise; GeeTest v3/v4; Turnstile; Cloudflare Challenge token and clearance-cookie modes; Cloudflare Waiting Room; DataDome; Tencent/TenDI; AWS WAF; Basilisk/FaucetPay; Binance; Imperva; Prosopo; Yidun; MTCaptcha; Altcha; FunCaptcha; TSPD; Hunt; Alibaba; Friendly Captcha; image text; reCAPTCHA click recognition; ComplexImage audio, coordinates, grids, rotation, and text. |
| **[SolveCaptcha](https://solvecaptcha.com/captcha-solver-api)** | reCAPTCHA v2/v3 and Enterprise; Turnstile; AWS WAF; Tencent; CutCaptcha; Lemin; DataDome; MTCaptcha; Altcha; Friendly Captcha; Prosopo; atbCAPTCHA; GeeTest v3/v4; FunCaptcha; CaptchaFox; image text, text questions, grid/canvas, coordinates, rotation, Temu and VK recognition, VK token solving. |
| **[Anti-Captcha](https://anti-captcha.com/apidoc)** | reCAPTCHA v2/v3 and Enterprise; Turnstile; GeeTest v3/v4; FunCaptcha; AWS WAF; Altcha; Friendly Captcha; Prosopo; image text; image coordinates; AntiGate template tasks. |
| **[NopeCHA](https://nopecha.com/api-reference/)** | hCaptcha, reCAPTCHA v2/v3 (including Enterprise metadata), and Turnstile tokens; AWS audio, FunCaptcha tiles/matching, GeeTest, hCaptcha binary/area/drag-drop, Lemin, reCAPTCHA, and image-text recognition. |
| **[NoneCap](https://nonecap.com/api-reference/)** | hCaptcha and hCaptcha Enterprise tokens; `rqdata`, proxy input, returned response key and solver User-Agent. |

CapMonster's ten ComplexImage models are `bills_audio`, `shein`, `bls`, `baidu`, `betpunch_3x3_rotate`, `oocl_rotate_double_new`, `oocl_rotate_new`, `dli_ensemble`, `mathsum`, and `portugal_text_find_icon`. Their `metadata.Task` values and recognition class are assigned by the adapter. The DLI, MathSum, and BLS methods send `dli`, `MathSum`, and `bls_3x3` respectively; audio sends `PayloadType: "Audio"`. CapSolver VisionEngine accepts the provider's documented module field, including slider, rotation, BotDeflector, Shein, and GIF OCR modes. Modules requiring a second image must receive it.

Public request examples sometimes disagree with their property tables. The catalog uses documented task names and the request-example names for 2Captcha's `TemuImageTask` and `VKCaptchaImageTask`; it preserves `BinanceTaskproxyless` casing. CapSolver GeeTest uses the task-table/SDK spelling `GeeTestTaskProxyLess`. These contracts need a real account/site trial before any measured acceptance claim.

## hCaptcha

**NopeCHA and NoneCap provide this integration's hCaptcha routes.** The original five providers are not advertised as hCaptcha solvers and are skipped for automatic hCaptcha fallback.

Support is based on the linked catalogs and retained integration evidence; an absent catalog entry alone does not prove a historical endpoint is unavailable. In particular:

- The current [2Captcha API catalog](https://2captcha.com/api-docs) omits hCaptcha. Its [sandbox guide](https://2captcha.com/h/how-to-use-sandbox-mode) mentions hCaptcha for manually solving your own submissions; that does not establish production worker availability.
- CapMonster's source repository contains an hCaptcha document marked `draft: true`; the published catalog does not expose it. Draft/withdrawn methods are not enabled by this integration.
- NopeCHA's retained `/v1/token/hcaptcha` and `/v1/recognition/hcaptcha` routes are separate products. Recognition returns puzzle answers, not a completed token. The public reference fetched on 2026-10-01 omits hCaptcha; the token route is retained because the supplied September 30 trace contains a successful provider answer. That trace proves an answer was returned, not current availability or target-site acceptance.
- NoneCap's `hcaptcha_enterprise` type accepts optional `rqdata`; include it whenever the site supplies it. Observed `data-rqdata` marks an automatically detected widget as Enterprise. Caller-supplied User-Agent is not sent because its API documents that input as ignored/deprecated. The returned `resp_key` and `user_agent` are retained.

Automatic detection still validates the hCaptcha UUID site key and observed `rqdata`. An explicit value that conflicts with the selected widget fails before dispatch. Enabling a compatible provider can re-evaluate a previously unsupported gate; a failed paid solve does not authorize another one.

## Integration contract audit — 2026-10-01

The seven adapters were checked against official request, authentication, polling, and response documentation. Regression fixtures cover dispatch and fallback without contacting paid services; local Chromium and Firefox fixtures cover application. This is not a live acceptance benchmark of every catalog method.

| Provider | Contract checked and resulting correction |
| --- | --- |
| [CapSolver](https://docs.capsolver.com/en/guide/captcha/cloudflare_turnstile/) | Standalone Turnstile accepts `action`/`cdata`, not Challenge `chlPageData`. Such requests skip its automatic adapter and retain the complete data for compatible providers. Unknown poll statuses fail promptly; missing balances are errors. The separate native Cloudflare Challenge route remains available. |
| [2Captcha](https://2captcha.com/api-docs/geetest) | GeeTest uses `riskType`, not `risk_type`. Requests and same-challenge comparisons now use the documented spelling. |
| [CapMonster](https://docs.capmonster.cloud/docs/captchas/amazon-task/) | Added automatic AWS SDK and invisible-challenge modes. Native voucher answers remain usable; cookie mode rejects missing/empty cookies. Incomplete Cloudflare Challenge metadata is never downgraded to an ordinary Turnstile request. |
| [SolveCaptcha](https://solvecaptcha.com/captcha-solver-api) | `res.php` accepts the documented Temu/VK `status: ready` / `solution` result as well as legacy numeric `status` / `request`. Structured recognition answers remain intact. The VK request table and example disagree; the adapter continues to follow the established form API/table, without claiming a live VK trial. |
| [Anti-Captcha](https://anti-captcha.com/apidoc/task-types/AmazonTaskProxyless) | The documentation's **Widget** tab defines `wafType: widget`, `websiteKey` (the SDK API key), and `jsapiScript`. This cookie-returning path now participates in AWS SDK fallback. The gokuProps mode remains separate. |
| [NopeCHA](https://nopecha.com/api-reference/) | Rechecked Basic-key authorization, v1 job IDs, polling and incomplete-job responses. Existing transport regressions cover them. The hCaptcha documentation discrepancy is recorded above; no new endpoint was guessed. |
| [NoneCap](https://nonecap.com/api-reference/) | Rechecked Bearer authorization, solve states, token, response key and returned User-Agent. Required identity checks now also apply to stored/native answers, so manual bindings cannot bypass them. |

NoneCap and [CapMonster reCAPTCHA v3](https://docs.capmonster.cloud/docs/captchas/recaptcha-v3-task/) explicitly require the returned User-Agent. Automatic and native application check it before writing fields, cookies or invoking callbacks. A mismatched answer is retained, including after worker restart, and requires manual completion; DIV does not silently change the browser identity or purchase another answer. Matching answers proceed normally. Other providers' optional User-Agent metadata remains available in their structured results and AWS diagnostics.

## Fallback and charging

1. Re-read enabled settings and validate keys.
2. Select compatible providers. Automatic widgets use built-in mappings. Native calls supply one documented task per compatible provider for the same challenge.
3. Validate every supplied native task before making any paid request. Disabled providers, unsupported method IDs, unknown top-level fields, missing required values, duplicate providers, conflicting page/site keys, and mixed CAPTCHA families fail locally.
4. Try providers in descending saved weight order. A provider is submitted at most once in that dispatch.
5. On API error, unusable answer, or timeout, try the next compatible provider.
6. Stop at the first usable answer. Injection or later page rejection does not restart fallback.

**Fallback can incur multiple charges.** A timed-out job may still finish upstream after DIV starts the next provider. This behavior is intentional. “Never retry” prevents repurchasing the same unresolved challenge from an already attempted provider. Provider errors advance the configured sequence within one call. For automatic AWS cookie solving, a fresh read after a reload that still shows AWS blocking can advance to an untried compatible provider; the attempted-provider record survives restart.

Most adapters use a 180-second job deadline and 30-second HTTP requests. The original direct CapSolver route retains its 120-second polling deadline. NopeCHA/NoneCap poll every two seconds; generic JSON providers every five seconds. SolveCaptcha waits 20 seconds initially for reCAPTCHA and five seconds for other tasks. Actual completion time is provider-dependent.

Pending responses keep polling the existing job. NopeCHA accepts both the [v1 `code: 14`](https://nopecha.com/api-reference/) and [legacy `error: 14`](https://developers.nopecha.com/recognition/hcaptcha/) forms, including numeric strings, on successful HTTP responses or HTTP 409. This applies only to result retrieval; a rejected submission is never recreated. CapSolver's native route accepts its documented [`idle` and `processing`](https://docs.capsolver.com/en/guide/api-gettaskresult/) states. Authentication, balance, rate-limit and server failures remain errors.

After manual completion navigates to another page, the next accessibility read confirms the current URL and checks document identity or completely inspects the old widget and challenge before retiring the previous page's CAPTCHA gate. A confirmed replacement document also retires the gate on a same-URL reload, during a page read or before another solve; unchanged or unreadable document identity keeps the paid lock. This also works with partial or interactive-only reads and with gates restored after a restart. A pathname change within the same document retains the failed-solve lock while the original widget remains. Unverified URLs, incomplete frame inspection, query-only changes, and missing dialog text alone do not clear an unresolved widget.

## Automatic widgets and native methods

### Automatic route

A visible dialog stops the run's page actions as a challenge when any of its text names a CAPTCHA product (CAPTCHA, reCAPTCHA, hCaptcha, FunCaptcha), or when a model reads its title as asking the person to prove they are human, in any language (the `page_blocker` question, read once per title, the decision model first). A dialog's title is its accessible name, else its first heading, else its title attribute, else its first line of text when nothing in it is editable. A title nobody could read stops nothing, as a title in a language the former English phrase list lacked never did, and one no model answered is not asked about again for 30 seconds, so page actions do not each wait for it. Vendor challenge frames (reCAPTCHA, hCaptcha, Arkose) arm the gate without any reading.

AWS WAF is also routed automatically from a visible challenge. The runtime observes initial `gokuProps` inputs or SDK/resource inputs for [CapSolver's secondary-verification contract](https://docs.capsolver.com/en/guide/captcha/awsWaf/), including the observed SDK API key and existing AWS token. Initial cookie tasks can use CapSolver, CapMonster, and Anti-Captcha. SDK widget tasks now use CapMonster Option 1 and Anti-Captcha's Widget mode as well as CapSolver secondary verification when an existing token is available (otherwise its documented script-only mode). All use the observed SDK API key and script URL; stale interstitial inputs are excluded. Invisible challenge-only pages also support CapMonster Option 3, with its documented empty `iv` and `context`. Enabling a recognition or voucher-returning service does not make it an applicable cookie fallback. `solve_captcha` applies the returned cookie unless `inject:false` was requested, then requires a reload and fresh inspection. A returned answer or successful cookie write alone is not clearance.

Confirmed clearance permits a later challenge, including another family on the same page. A successful form submission after verified widget clearance can re-arm a newly visible challenge. Mere URL changes, incomplete reads, or an unchanged visible challenge do not unlock another paid attempt. Complete AWS disappearance also permits continuation after manual completion.

The extension captures callbacks passed to `hcaptcha.render()`, `turnstile.render()`, and `grecaptcha.render()` (including Enterprise) at document start in each matching frame. This supports function closures without a global `data-callback` name. The callback is matched to the selected response field and site key, invoked at most once per widget generation, and invalidated by reset/removal. hCaptcha's [`execute(widgetID, { async: true })`](https://docs.hcaptcha.com/configuration/#asynchronous-mode-get-a-promise) continuation receives the same answer; `getResponse()` and, when supplied by the provider, `getRespKey()` agree with that answer. Page acceptance still requires a fresh inspection: invoking the callback does not clear a visible, rejected challenge.

After updating/reloading the extension, refresh an already-open CAPTCHA page before solving. Existing page closures cannot be recovered retroactively. Named callbacks and the existing reCAPTCHA client discovery remain available for older tabs. The bridge records page registrations only; it does not make provider requests or change the site's submission flow by itself.

`solve_captcha` without `providerTasks` retains frame-aware detection for reCAPTCHA, hCaptcha, and standalone Turnstile. Image-to-text takes explicit image bytes. It checks the selected frame, site key, Enterprise flags, action, and available metadata before spending. Ambiguous frames require a discriminator from the returned candidates.

The original five providers have the built-in six-type mappings; NopeCHA and NoneCap have the built-in hCaptcha mapping. Other listed capabilities, including NopeCHA reCAPTCHA/Turnstile/recognition, are callable through the native route. A family appearing in Settings is API coverage, not a promise of automatic DOM detection on every website.

### Native route

Use the read-only `get_captcha_capabilities` tool:

```json
{"family":"geetest"}
```

Then inspect a particular provider/method to retrieve its exact schema:

```json
{"provider":"2captcha","method":"GeeTestTaskProxyless"}
```

Use observed page parameters to prepare fallback tasks. Method IDs are DIV identifiers; suffixes such as `:enterprise` select fixed provider options and are not sent as the upstream task type.

```json
{
  "inject": false,
  "providerTasks": [
    {
      "provider": "capsolver",
      "method": "GeeTestTaskProxyLess",
      "parameters": {
        "websiteURL": "https://example.test/form",
        "captchaId": "OBSERVED_CAPTCHA_ID"
      }
    },
    {
      "provider": "2captcha",
      "method": "GeeTestTaskProxyless",
      "parameters": {
        "websiteURL": "https://example.test/form",
        "version": 4,
        "initParameters": {"captcha_id":"OBSERVED_CAPTCHA_ID"}
      }
    }
  ]
}
```

AWS WAF pages keep their inputs out of the page text: `key`, `iv`, and `context` sit in the `window.gokuProps` global, and the challenge script loads from an `awswaf.com` host. When `get_captcha_capabilities` is called without a provider or method on such a page, it reads those values from the top frame and returns `observedChallenge`. That object includes one ready task per enabled CapSolver, CapMonster Cloud, or Anti-Captcha provider, plus the `aws-waf-token` cookie path for each provider's answer (`cookie`, `cookies.aws-waf-token`, and `token`). Automatic CapMonster tasks set `cookieSolution: true`. Explicit native tasks may instead request the default voucher answer; that valid response is retained without falling through to another paid provider. 2Captcha and SolveCaptcha are left out because they return a `captcha_voucher`/`existing_token` pair that DIV can't turn into the cookie, so a win by either would be charged and unusable. If an input is missing, the result names it and nothing is guessed. After `apply_captcha_solution` sets the cookie, reload the page and read it again. A site can still reject a proxyless token.

Saved weights determine execution order, regardless of array order. Supply a task for each enabled provider that can solve that family and for which the required inputs are available. The tool does not invent another provider's parameters. Page URLs must belong to the active tab or an observed frame. Native methods do not automatically scrape every site's internal configuration.

Provider-specific identifiers (for example `appId`/`app_id` and `miseryKey`/`misery_key`) must agree across fallback entries before any paid request. Recognition fallbacks compare the image/audio, instructions and answer constraints such as click counts and text length. TSPD fallbacks compare the captured page; Cloudflare Challenge fallbacks compare task mode and the exact HTML snapshot. AWS WAF fallbacks compare API, challenge and CAPTCHA script identifiers. reCAPTCHA v2 fallbacks must agree on `data-s` and visible/invisible mode, and reCAPTCHA v3 fallbacks on action and minimum score, when supplied. All reCAPTCHA fallbacks compare explicitly supplied session cookies after normalizing each provider's documented format; a scoped NopeCHA cookie array cannot be equated to a scope-free cookie string.
Text instructions and instruction images are compared separately, so a recognition request can supply both. reCAPTCHA comparisons use the effective version and Enterprise mode, including provider-native flags; an equivalent explicit Enterprise method can participate in the same fallback.
FunCaptcha fallbacks compare the Arkose service host even when one provider takes a subdomain and another takes a full `surl` URL. The native dispatch lock is stored before contacting a paid provider. An unexpired answer is stored for worker recovery; if a solve was dispatched but its answer is unavailable after restart, the gate requires manual completion rather than a second paid call.

Clearing the chat on the same page keeps the native dispatch lock and any unapplied paid answer. The pending verification gate directs the next Act/Dev mid or full run to call `get_captcha_capabilities`, which returns `pendingNativeAnswer` with the original provider, method, and structured solution after checking the current document. Apply it with `apply_captcha_solution`; do not buy another solve. The answer expires after three minutes and is discarded when the page document changes. Compact and Ask modes still require manual completion because the CAPTCHA tools are unavailable there.
Recovered answers receive the same untrusted-content protection as the original solve result. An expired answer requires manual completion and permits reporting a partial outcome, even if document inspection temporarily fails. When discovery confirms that the root document changed, including a reload at the same URL, it releases the old verification gate while retaining that document's paid-dispatch history. That retirement survives a worker restart and cannot clear a new document's challenge gate.

The native adapter rejects undeclared nested fields in schemas with enumerated children, such as CapMonster `metadata`. Provider-documented free-form option objects, including NopeCHA Enterprise `data`, remain available.

`solution` remains structured: tokens, cookie values, GeeTest objects, coordinates, arrays of booleans, text, and provider-specific response fields are not coerced into a single token string. A synchronous ready response is consumed without a redundant polling request.

## Applying answers

`apply_captcha_solution` uses the stored answer from the one native solve. It does not accept a replacement answer or start another paid job. It checks the original page URL, an exact observed frame ID/URL, the document time origin captured before dispatch (including same-URL reloads), and a three-minute application window after completion.

Supported bindings:

- `fields`: bind a solution path to one observed input/textarea selector; structured values require `encoding: "json"`.
- `callback`: pass a solution value or object to an observed named page callback. Application uses the frame host's normal permissions: Type for response fields, Click for image/grid clicks, and JavaScript for callbacks or cookies. Native/global code evaluators and unsafe property paths are rejected. Provider-returned code is never evaluated.
- `cookies`: bind explicit cookie names to returned values. Complete Set-Cookie strings are reduced to the explicitly named cookie value; returned attributes are ignored. Cookies are host-only, scoped to the active top-level page and its browser cookie store. Provider-supplied domains/URLs are not adopted. Both extension manifests declare the `cookies` permission for this behavior.
- `clicks`: apply coordinate arrays, numbered grid cells, or boolean grids to one observed challenge image/grid. Original image dimensions are converted once into CSS coordinates; out-of-bounds, ambiguous, obscured, or invisible targets fail. SolveCaptcha `click:` grid answers (including letter-numbered cells) and `coordinate:` answers are decoded into these arrays. These are synthetic page events; some challenges require trusted input and will reject them.

Example for a site whose observed callback accepts a complete GeeTest object:

```json
{"frameId":0,"frameUrl":"https://example.test/form","callback":{"name":"captchaCompleted","path":""}}
```

Example for a numbered grid answer:

```json
{"frameId":3,"frameUrl":"https://challenge.example.test/grid","clicks":[{"selector":"#challenge-grid","path":"click","mode":"grid","rows":3,"columns":3,"oneBased":true}]}
```

Selectors, callback names, frame IDs, and response paths in examples are placeholders. Read the actual page and returned answer. Binding does not implement every site's slider, drag trajectory, rotation control, puzzle refresh cycle, or proprietary submission protocol. Such answers remain available as data for a site-specific integration or manual completion. Even after successful binding, a fresh page read must confirm that the challenge cleared.

After native application succeeds, a complete fresh inspection confirming the challenge has disappeared clears the gate even when the family has no automatic widget identity. Merely receiving an answer does not clear it.

## Proxy, cookies, and browser identity

A proxyless method means the solver chooses its network route. It does not guarantee that the website accepts a token generated from a different IP.

- **NopeCHA Turnstile requires a proxy object**, with the same exit IP used to submit the token. Omitting it fails locally. Its v1 token routes accept structured proxy/cookie input and use Basic authentication; pending jobs return HTTP 409/code 14.
- **CapMonster Cloudflare Challenge** has separate token and `cf_clearance` modes. Its Waiting Room method uses `cloudflareTaskType: "wait_room"`. Cookie/Waiting Room methods require the documented HTML, proxy, and User-Agent fields.
- **CapSolver Cloudflare and DataDome** require the proxy inputs documented for their native methods.
- **NoneCap** accepts optional string/object proxies. Its returned User-Agent and response key can matter for acceptance.
- Proxied JSON APIs use provider-specific `proxyType`, `proxyAddress`, `proxyPort`, and optional authentication fields. SolveCaptcha uses form-encoded proxy fields.
- Weighted native fallbacks compare supplied proxy scheme, host, port, and credentials across provider-specific formats before any paid request. Identity-bound fallbacks require a proxy on every attempt; supplied User-Agent values must also agree.

DIV does not silently change the browser's proxy or User-Agent, transplant a complete remote session, or infer an IP match. Satisfy those prerequisites separately. Returned cookies can be explicitly bound; returned JavaScript, arbitrary storage dumps, and arbitrary navigation instructions cannot.

## Security and data flow

Personal provider keys stay in extension settings and are injected into the HTTP transport internally; discovery and model-authored task arguments do not expose them. Endpoints are fixed to provider APIs, not chosen by a page or model. Unknown provider/method combinations cannot redirect requests to another service.

Solving transmits the supplied challenge information to each attempted provider: page URL, site key, challenge metadata, image/audio data, and any explicitly supplied proxy/cookie inputs. Only supply the data needed for the chosen method. The extension does not automatically export the tab's cookie jar as part of native solving. A balance test contacts the selected provider.

A local preflight failure reports `dispatched: false`. Once a create request may have been sent, a failure reports dispatch rather than implying that nothing happened. Applying a solution has its own page-change boundary. Page rejection never triggers a second fallback cycle.

Automatic widget solves save the selected widget and a paid-attempt gate before contacting a provider, including when the model calls `solve_captcha` directly from a screenshot before any accessibility read. The saved gate prevents another paid attempt after a provider failure, failed application, or worker restart. With `inject: false`, the provider answer is saved against the observed page/frame document identities and returned with `applicationRequired: true`. Use `apply_captcha_solution` with observed field/callback bindings and `path: "token"`; `get_captcha_capabilities` retrieves the pending answer after restart. The same answer is applied at most once, and expiry or document replacement makes it unusable without authorizing another solve for the old document. If the gate cannot be saved, no request is sent. Injection and callback diagnostics precede the full token in tool results so long tokens do not hide them in shortened trace exports.

The CAPTCHA gate permits `done` with `outcome: "failed"` or `"partial"` in every gate state. Cancelling or reporting blocked work must not require a solve. This exception does not authorize page mutations or bypass verification for successful completion.

**Managed Cloud is separate.** Managed browsers continue using the server-side CapSolver broker and ignore personal keys and weights. Settings hides its CAPTCHA tab there, since there is nothing to configure. Native catalog discovery/submission is excluded for that route. This change does not expand or deploy the server-side broker's allowlist, quotas, or billing.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Saved provider is not tried | Enabled checkbox, key format, weight, compatible family, and whether a native task was supplied for it. |
| hCaptcha says no provider | Enable NopeCHA or NoneCap. A CapSolver/2Captcha/CapMonster/SolveCaptcha/Anti-Captcha key does not enable hCaptcha in this catalog. |
| Required-field error | Read that exact method's schema; obtain fresh page values. It has not spent a solve. |
| Token returned but page stays blocked | Correct target frame/callback, freshness, Enterprise metadata, IP/User-Agent requirements, and site acceptance. Do not buy another solve automatically. |
| NopeCHA reports “Incomplete job” as an error | Check the request stage, HTTP status and numeric code now included in the error. Known pending responses are polled; submission errors and terminal HTTP failures are not retried. |
| AWS WAF page, but no solve was attempted | Call `get_captcha_capabilities` without a provider or method and use `observedChallenge.providerTasks`. Enable CapSolver, CapMonster Cloud, or Anti-Captcha; 2Captcha/SolveCaptcha vouchers can't be applied. |
| Native result has coordinates/cookies/object fields | Use suitable answer bindings or a site-specific handler, not a token textarea by assumption. |
| Balance is credits instead of currency | Expected for NopeCHA and NoneCap; their pricing units differ from dollar-balance providers. |
| More than one provider charged | Expected when earlier jobs failed/timed out and fallback ran. A timeout does not cancel an accepted upstream job. |
| Native methods absent in Cloud | The managed CapSolver broker retains its separate supported surface. |

## Implementation and tests

Both browser trees contain:

- `src/agent/captcha-provider-config.js`: key formats, consent, default weights, automatic and native coverage.
- `src/agent/captcha-catalog.js`: the 198 method contracts and primary documentation links.
- `src/agent/captcha-native-providers.js`: discovery, preflight, fixed-value mapping, native fallback, and structured results.
- `src/agent/captcha-hcaptcha-providers.js`: NopeCHA/NoneCap v1 transports and automatic hCaptcha mapping.
- `src/agent/captcha-solver.js`, `captcha-additional-providers.js`, `two-captcha.js`, `captcha-json-api.js`: automatic routes and shared request/poll lifecycles.
- `src/agent/captcha-solution-application.js`: bound answer application, browser-specific execution, and cookie-store scoping.
- `src/ui/captcha-settings.js` and `src/ui/locales/captcha-copy.mjs`: consent/weight controls, coverage text, balance display, and localized UI copy.

Focused checks:

```sh
node --test test/captcha-providers.mjs test/captcha-weighted-fallback.mjs test/capsolver-cloud-broker.mjs test/captcha-hcaptcha-providers.mjs test/captcha-native-providers.mjs
npm run test:captcha:ui
npm run build:all
node test/run.js
```

Tests cover independent provider request fixtures, synchronous and polled responses, structured answers, weighted fallback, input rejection before spending, hCaptcha metadata, Cloud isolation, enabled-state persistence, Chrome/Firefox routing, and mobile/desktop settings rendering. Mocked API success is not evidence that a live target accepted a token.
