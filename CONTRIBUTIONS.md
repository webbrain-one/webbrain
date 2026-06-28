# Contributing to WebBrain

Thanks for thinking about contributing. WebBrain is MIT-licensed, runs entirely
in your browser, and is built by a small group — your help makes a real
difference.

The contribution we want **most** right now is **site-specific adapters**, and
in particular for **large regional sites** that the rest of the open-source
world tends to ignore. If you only read one section of this doc, read the next
one.

---

## What we need most: regional site adapters

WebBrain's agent loop is generic — `click`, `type_text`, `scroll`,
`get_accessibility_tree`, etc. — but real sites have weird-shaped UIs that
even a frontier model struggles to navigate without prior knowledge. The
"site adapter" mechanism injects 5-15 lines of hand-written guidance into the
agent's first message when it lands on a known site, telling it things like:
*"the body editor is a CodeMirror, not a textarea"* or *"the file upload
input is `input#releases-upload`, not the generic `input[type='file']`"*.

We have decent coverage for English-first global sites: GitHub, GitLab,
Stack Overflow, Hacker News, Gmail, Google Docs/Calendar, Slack, Notion,
Stripe, etc. (See [`src/chrome/src/agent/adapters.js`](src/chrome/src/agent/adapters.js).)

What we don't have, and what causes user-facing failures every day, is
**adapters for the sites people in non-US markets actually use**. Examples
of the kind of thing we'd love a PR for:

| Region | High-priority sites |
|--------|---------------------|
| **Türkiye** | sahibinden.com, hepsiburada.com, trendyol.com, n11.com, yemeksepeti.com, getir.com, gittigidiyor.com |
| **LATAM** | mercadolibre.com.ar / .com.mx / .com.br, olx.com.br, despegar.com, rappi.com |
| **Brasil** | mercadolivre.com.br, americanas.com, magazineluiza.com.br, ifood.com.br |
| **Russia / CIS** | wildberries.ru, ozon.ru, yandex.market, avito.ru, vk.com |
| **India** | flipkart.com, snapdeal.com, swiggy.in, zomato.com, irctc.co.in, paytm.com |
| **SE Asia** | shopee.com, lazada.com, tokopedia.com, traveloka.com, gojek.com, grab.com |
| **East Asia** | rakuten.co.jp, mercari.com, yahoo.co.jp, naver.com, coupang.com |
| **MENA / Gulf** | noon.com, souq.com, hepsiburada (also TR), careem.com, talabat.com |
| **Africa** | jumia.com, takealot.com, kilimall.com |
| **Europe (non-en)** | allegro.pl, leboncoin.fr, bol.com, otto.de, marktplaats.nl, willhaben.at |

This list is not exhaustive — if you use a site that WebBrain handles badly,
you're probably the right person to write its adapter. **A PR adding one
high-quality adapter is more valuable to the project than a PR refactoring
ten files.**

### How to write a site adapter

Adapters live in [`src/chrome/src/agent/adapters.js`](src/chrome/src/agent/adapters.js)
and the parallel [`src/firefox/src/agent/adapters.js`](src/firefox/src/agent/adapters.js).
The shape is:

```js
{
  name: 'sahibinden',
  category: 'general',
  match: (url) => /^https?:\/\/(www\.)?sahibinden\.com\//.test(url),
  notes: `
- (one short bullet per non-obvious fact about the site, written in the
   imperative voice for an LLM that has never seen this page before.)
`,
},
```

Each adapter needs four things:

1. **`name`** — short identifier, lowercase, no spaces. Used in logs and the settings UI.
2. **`category`** — usually `'general'`. Reserved for future filtering.
3. **`match(url)`** — regex against the current tab URL. Match the broadest
   form of the domain (`.com`, `.co.uk`, `.com.tr` country variants if applicable),
   but don't match unrelated subdomains.
4. **`notes`** — the body the agent will see prepended to its first message
   on this site. **This is the actual contribution.** See below.

### What good adapter notes look like

Adapter notes are **not documentation for humans**. They're prompt fragments
for an LLM that's about to drive the page. The bar is:

- **Imperative voice.** *"Click `<text>`"* not *"You should click `<text>`"*.
- **Names actual selectors, URL patterns, or visible button text** — not vague
  guidance. *"The login button is labeled 'Giriş Yap', not 'Login'"* is
  useful. *"Be careful with the login flow"* is useless.
- **Mentions traps the model would otherwise fall into.** That's the whole
  point. If the search field looks like a normal `<input>` but actually opens
  a typeahead modal, **say so**.
- **Names the success indicators.** *"After posting, the new listing appears
  at the top of /ilanlarim with a 'Yayında' (Published) badge — not in
  /ilanlar."*
- **Says what NOT to do.** *"Don't click the green 'Hemen Al' button unless
  you actually want to buy — there is no confirm dialog."* Anti-patterns
  matter as much as patterns.
- **Stays short.** 5-15 bullets. The notes ride along with every first-turn
  request on that site, so they cost tokens. If your adapter is approaching
  20 bullets, split common patterns into shorter sentences or trim the
  least-likely scenarios.
- **Is dated when the UI is volatile.** If you write *"As of 2026-04, the
  listing form is at /ilan-ver/step-1"*, future contributors know how stale
  the note is.

A canonical example to imitate is the **github** adapter — it tells the model
about CodeMirror editors, the Choose-a-tag combobox, the `input#releases-upload`
selector for binaries, and the trap of clicking element `#38` (which model
training data sometimes "remembers" as the publish button but is actually
the Pull Requests link).

### What bad adapter notes look like

- *"GitHub is a code hosting site."* (Tells the model nothing useful.)
- *"Be careful when posting comments."* (Vague — what specifically goes wrong?)
- *"The site has many features."* (Filler.)
- 30+ bullets covering every page on the site. (Exceeds the budget; the
  model will skim.)
- Quoting screenshots or ASCII art. (Tokens you can't afford.)

### How to test your adapter before submitting

1. Load the unpacked extension (Chrome → `chrome://extensions/` → Developer
   mode → Load unpacked → pick `src/chrome/`).
2. Open the WebBrain side panel on the target site.
3. **Settings → Display → Site adapters** must be on (it is by default).
4. Run a representative task in Act mode — for sahibinden, something like
   *"find me 5 listings under 35,000 TL for X"*. Watch what the agent does.
5. Toggle **Settings → Display → Record traces** before the run. After
   the run, open the Traces page and inspect the timeline. Did the agent
   hit any of the dead-ends your adapter is meant to prevent? Did it follow
   the patterns you described?
6. Mirror the adapter to `src/firefox/src/agent/adapters.js` (the file
   structure is identical) and re-test on Firefox.

### Submitting

- One adapter per PR is ideal. If you've got two unrelated adapters, two PRs.
- Title: `agent: add adapter for <site>`.
- Body: a one-liner of *what real failure mode this adapter prevents*, plus
  one or two trace-based examples if you have them. We don't need a long
  rationale; we trust your judgment if you've actually used the site.
- Mirror to both `src/chrome/` and `src/firefox/` so neither browser regresses.

---

## Other valuable contributions

In rough priority order:

### Bug reports with traces

If WebBrain failed on a real task, the most useful thing you can give us is
the **trace JSON**. Open the Traces page → pick the run → "Export JSON".
Attach it to a GitHub issue. Strip anything sensitive (API keys, personal
emails) before uploading — the trace contains your conversation, page
content, and screenshots.

A trace tells us what the model saw, what it tried, what failed, and why
the loop ended. A screenshot or "it didn't work" message tells us nothing.

### Translations

The plugin UI ships in en, es, fr, tr, zh
([`src/chrome/src/ui/locales/`](src/chrome/src/ui/locales/)). Adding a new
locale is mechanical — copy `en.js`, translate the values, run the build,
mirror to firefox. Most useful additions: pt (Brazil/Portugal), de
(Germany/Austria), ja (Japan), ko (Korea), ru, ar (RTL — see notes below).
If you do RTL, add a brief CSS audit pass for the side-panel layout — most
flexbox in the UI works, but call out anything that breaks.

The marketing site has a parallel locale system in
[`web/build/locales/`](web/build/locales/) — `npm run build:web` after edits.

### Local model recommendations

We track which open-weight models work well for browser-agent tasks in
[`web/blog/vision-model-shootout/`](web/blog/vision-model-shootout/) and in
the FAQ on the main page. If you've benchmarked a model that should be on
that list (or shouldn't, for a stated reason), open an issue with the
benchmark setup, the trace, and the comparison data.

### Code: prompt tier system, Firefox parity, recorder fixes

See [`TODOs.md`](TODOs.md) for engineering items we know we want to do but
haven't gotten to. Some of those (e.g. small-tier ACT prompt, `upload_file`
in Firefox, missing step numbers on tool events in traces) are well-scoped
and a good first PR if you want a code task.

---

## Code conventions (skim)

- ES modules throughout. No build step except `npm run build:web` for the
  marketing site.
- Chrome (MV3) and Firefox (MV2) are mostly mirror codebases — when you
  change one, mirror to the other. The differences live in
  [`src/chrome/ARCHITECTURE.md`](src/chrome/ARCHITECTURE.md).
- Comments earn their place by explaining **why**, not what. The agent's
  prompt-engineering decisions are full of "we tried X, it broke Y, we
  switched to Z" rationale — preserve that voice.
- No frameworks added without discussion. The whole extension is vanilla
  JS + CSS, intentionally.
- `node test/run.js` runs the unit tests. Don't break them.
- **Touching the agent's tools, page reads, or message-building?** Read
  [`docs/prompt-injection-defense.md`](docs/prompt-injection-defense.md) first.
  It explains what counts as untrusted page content, the two registries that
  must stay exhaustive (`UNTRUSTED_CONTENT_TOOLS` and the capability map), and
  the rule that page-derived bytes must go through `_wrapUntrusted` — not a
  prose label. The unit tests check that tools are *listed*, not that you
  classified them *correctly*.

---

## Code of conduct

Be civil. Disagree with the code, not with the person. We don't have a CLA
and we won't add one — your contribution stays MIT, attributed to you in
the commit history, forever.

---

## Questions

Open a [GitHub Discussion](https://github.com/webbrain-one/webbrain/discussions)
or file an issue. Don't email Emre directly with code questions; the
conversation is more useful in public.
