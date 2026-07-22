# Site Adapters — How to Write One

Site adapters are the **#1 most-wanted contribution** (see CONTRIBUTING.md). They inject short, hand-curated guidance into the agent's first message when it operates on a known site. The goal is NOT to encode every selector (those rot fast), but to capture the non-obvious quirks that cost an LLM several dead-end tool calls to discover on its own.

---

## How They Work

### File

`src/chrome/src/agent/adapters.js` (and `src/firefox/src/agent/adapters.js` — both builds share the same file content, mirror changes to both).

### Matching

`getActiveAdapter(url)` iterates the `ADAPTERS` array and returns the **first** adapter whose `match(url)` returns `true`:

```js
export function getActiveAdapter(url) {
  if (!url) return null;
  for (const a of ADAPTERS) {
    try {
      if (a.match(url)) return a;
    } catch (e) { /* skip malformed matchers */ }
  }
  return null;
}
```

Only ONE adapter fires at a time, so prompt cost is fixed regardless of total adapter count.

For federated platforms such as Mastodon, keep generic URL shapes conservative.
Bare `/@user` and `/users/user` paths appear on many non-Mastodon sites, and the
current adapter matcher only sees the URL string. Future work may integrate
[`instances.social`](https://instances.social/api/doc/) as a skill-backed lookup
or maintained known-instances list so candidate hosts can be verified before
injecting Mastodon guidance more broadly.

### Injection Timing

- **First turn**: the adapter's `notes` are appended to the first user message in `_enrichUserMessageWithCurrentPage()`.
- **Mid-conversation navigation**: if the user navigates to a URL matching a different adapter, the agent injects a `[Site context changed → now on <name>]` message. Controlled by `_maybeReinjectAdapter()`.

### Universal Preamble

`UNIVERSAL_PREAMBLE` is injected alongside every system prompt when `useSiteAdapters` is enabled. It covers cookie/consent banners and paywalls — two patterns that appear across the public web and cause LLMs to make bad assumptions.

---

## Adapter Format

```js
{
  name: 'my-site',          // unique short identifier
  category: 'general',       // 'general' | 'finance'
  match: (url) => /^https?:\/\/(www\.)?example\.com\//.test(url),
  notes: `
- Bullet 1: the actionable tip.
- Bullet 2: another tip.
- Keep these SHORT (4–8 bullets max). Every adapter costs tokens on every first turn.
`,
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique identifier for the adapter. Used in system-prompt headings. |
| `category` | `'general'` or `'finance'` | `'finance'` adds a `[FINANCE / HIGH-STAKES]` banner to the heading and triggers extra safety guidance in the system prompt. |
| `match` | `(url) => boolean` | Returns `true` when the adapter should fire for this URL. Regex is preferred — keep it specific enough to avoid false matches. |
| `notes` | string | Bulleted guidance injected into the first user message. **Keep 4–8 lines max.** See style guidance below. |

### Ordering

Adapters are ordered by category/site in the `ADAPTERS` array. **Finance adapters must come BEFORE `finance-generic`**, since `finance-generic` uses a broad regex that would shadow specific adapters. Currently: Stripe → Coinbase → Robinhood → TradingView → finance-generic.

---

## Writing Effective Notes

### DO

- **Describe the SHAPE of the page** rather than literal selectors. Selectors rot; page layout patterns are stable longer.
  ```js
  // Good
  notes: `- The composer is a contenteditable div, not a textarea.`
  // Bad
  notes: `- Click div[contenteditable="true"] to compose.`
  ```
- **Name the tool to prefer**: guide toward AX tools (`click_ax`, `set_field`) over legacy tools (`click({text})`, `type_text`).
- **Flag destructive subtleties**: "The 'Cancel' button on the billing page immediately stops service — read the confirmation modal."
- **Flag SPA navigation traps**: "Settings changes autosave; navigating via browser back discards unsaved edits."
- **Flag sticky overlays**: "The cookie banner reappears every 24h. Don't describe its text as page content."
- **Flag virtualized containers**: "The timeline is virtualized — scroll to load more items."
- **Keep each bullet to a single actionable tip**. The model has limited context and will skim.

### DON'T

- **Don't encode CSS selectors** — they change with every site redesign.
- **Don't write more than 8 bullets** — the token cost compounds on every conversation.
- **Don't include obvious advice** the model would figure out by reading the page (e.g., "the submit button submits the form").
- **Don't duplicate the universal preamble** (cookie/paywall guidance).
- **Don't add alphabetical or reference adapters** — each adapter must provide real guidance that saves the model from at least 2–3 trial-and-error tool calls.

### Example: Good Adapter

```js
{
  name: 'twitter',
  category: 'general',
  match: (url) => /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//.test(url),
  notes: `
- The composer is a contenteditable, not a textarea. Character count is enforced client-side.
- The timeline is virtualized — tweets scroll out of the DOM. Use search, not scroll, to find a tweet.
- "Reply", "Retweet", "Like" icons are below each tweet.
- Quote tweets vs reposts: the retweet icon opens a menu with both options.
`,
}
```

### Example: Finance Adapter

```js
{
  name: 'stripe',
  category: 'finance',
  match: (url) => /^https?:\/\/(dashboard\.)?stripe\.com\//.test(url),
  notes: `
- LIVE vs TEST mode toggle in the top-right. Always confirm which mode.
- Refunds are partial-by-default — check the amount carefully.
- Customer deletion is irreversible.
- SUBSCRIPTIONS: proration prompts ("Charge prorated amount immediately" vs "On next invoice").
`,
}
```

---

## Testing Your Adapter

1. **Add the adapter** to both `src/chrome/src/agent/adapters.js` and `src/firefox/src/agent/adapters.js`.
2. **Verify matching**: navigate to the target URL in a browser with the extension loaded. Open the DevTools console on the service worker / background page and run:
   ```js
   import { getActiveAdapter, listAdapters } from './agent/adapters.js';
   console.log(getActiveAdapter('https://example.com/some-page'));
   ```
3. **Verify the notes appear**: in Ask, Act, or Dev mode, type a simple instruction (e.g., "what's on this page?"). Open the side panel's verbose mode and confirm the first user message contains `[Site guidance for <name>]` with your notes.
4. **Verify only ONE adapter fires**: navigate to a URL that could match multiple matchers. Check that the first match wins and no others leak through.
5. **Test navigation re-injection**: start a conversation on a non-adapted site, then navigate to your adapted site. Confirm a `[Site context changed]` message appears.

### Manual test URLs

Open each adapted site and verify:
- The adapter loads on page 1 (not on a SPA route change)
- The notes are useful (don't mislead the model)
- The model doesn't follow outdated instructions

---

## Adding a New Adapter Checklist

- [ ] Add the adapter object to the `ADAPTERS` array in `src/chrome/src/agent/adapters.js`
- [ ] Mirror the exact same change to `src/firefox/src/agent/adapters.js`
- [ ] Ensure the `match()` regex is specific and doesn't shadow neighboring adapters
- [ ] If `category: 'finance'`, place it BEFORE `finance-generic` in the array
- [ ] Verify the notes are 4–8 concise bullets
- [ ] Test matching with `getActiveAdapter(url)`
- [ ] Test end-to-end with the extension loaded
- [ ] If the adapter targets a non-English market, add localized label hints (see the WordPress adapter for an example of how to annotate non-English UI labels)
