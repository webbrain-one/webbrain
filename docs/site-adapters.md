# Site Adapters — How to Write One

Site adapters are the **#1 most-wanted contribution** (see CONTRIBUTING.md). They inject short, hand-curated guidance into the agent's first message when it operates on a known site. The goal is NOT to encode every selector (those rot fast), but to capture the non-obvious quirks that cost an LLM several dead-end tool calls to discover on its own.

---

## How They Work

### File

`src/chrome/src/agent/adapters.js` (and `src/firefox/src/agent/adapters.js` — both builds share the same file content, mirror changes to both).

### Matching

`getActiveAdapter(url)` iterates the `ADAPTERS` array and returns the **first** adapter whose `matches(url)` returns `true`:

```js
export function getActiveAdapter(url) {
  if (!url) return null;
  for (const a of ADAPTERS) {
    try {
      if (a.matches(url)) return a;
    } catch (e) { /* skip malformed matchers */ }
  }
  return null;
}
```

Only ONE adapter fires at a time, so prompt cost is fixed regardless of total adapter count.

The nine CMS content adapters live in mirrored `agent/cms-adapters.js` modules,
appended after existing site-specific matches. Their short notes reach Compact
without a skill tool; detailed Mid/Full recipes load from the packaged catalog on
demand. CMS-specific self-hosted paths support custom domains; generic admin/Studio
paths do not inject CMS notes. Webflow matches dashboard/Designer routes instead
of its marketing pages. URL matching alone never proves CMS identity or API access.
See [CMS content APIs](cms-api-first.md) for auth and routing limits.

For federated platforms such as Mastodon, keep generic URL shapes conservative.
Bare `/@user` and `/users/user` paths appear on many non-Mastodon sites, and the
current adapter matcher only sees the URL string. Future work may integrate
[`instances.social`](https://instances.social/api/doc/) as a skill-backed lookup
or maintained known-instances list so candidate hosts can be verified before
injecting Mastodon guidance more broadly.

### Injection Timing

- **First turn**: the adapter's `notes` are appended to the first user message in `_enrichUserMessageWithCurrentPage()`.
- **Mid-conversation navigation**: if the user navigates to a URL matching a different adapter, the agent injects a `[Site context changed → now on <name>]` message. Controlled by `_maybeReinjectAdapter()`.

Every matched adapter also emits one content-free `adapter_match` trace note per
adapter revision in a run. It contains only `adapter`, `revision`, and
`notesInjected`; it never copies the notes, page URL, title, or page content.
This measures notes-only adapters as well as structured workflows. When a job
is selected, the existing `adapter_context` note separately records its bounded
workflow identity. Legacy notes-only adapters use implicit revision 1; adapters
with a structured contract use their declared workflow revision.

### Universal Preamble

`UNIVERSAL_PREAMBLE` is injected alongside every system prompt when `useSiteAdapters` is enabled. It covers cookie/consent banners and paywalls — two patterns that appear across the public web and cause LLMs to make bad assumptions.

### Structured Workflow Contracts

Adapters with repeated, evidence-backed tasks may also declare a versioned
`webbrain-adapter-workflow/2` contract. This is runtime policy, not more page
prose. Before either the compact intent planner or the full planner runs,
DIV gives it only the active adapter name and a bounded list of app-owned
job IDs plus short descriptions. The planner selects `site_job` semantically,
so routing does not depend on the language of the user's request. Page content
cannot add or select a job, and an ID is accepted only if it still belongs to
the same adapter on the live page immediately before execution. Navigation
while planning or reviewing drops the binding unless the adapter, revision,
schema, and job still match. A trusted Continue turn may retain prior evidence
only after the same live revalidation.

The selected job can only tighten execution. It can require a consequential
tool result, job-bound terminal evidence after its submit/commit dispatch, or
item-level progress-ledger reconciliation. A generic success toast or another
site's submit cannot satisfy the selected job: transaction workflows require a
paid/ticket-issued state, protected messaging requires the recipient-bound
dispatch, an empty composer in that conversation, and a positive sent-status
confirmation, while form/publish/update jobs require their own confirmation
state. A workflow that requires a ledger
must reconcile exact app-owned inventory IDs from a complete accessibility-tree
read or app-seeded expected/classifier targets. Model-created rows—even one
terminal row—cannot prove complete coverage. Form inventory v1 is the last
exhaustive document-root snapshot (`filter: all`, not depth-truncated).
Skipped required rows cannot prove success; optional (`required: false`)
inventory rows may be skipped, and that flag is emitted only when optionality
is explicit (`aria-required="false"`). Missing `required` stays unknown.
The fields a form request names, and the values it gives them, are in the
user's own words. Which inventory field each of them is gets read by a model
in any language (`form_field_match`: the named field, a different one, or
unclear), the decision model first, before the reconciliation and again at
`done`. A requested value has to read back from a field read as the named
one, and an optional row may be skipped only once every named field reads as
a different one; a pair nobody has read yet keeps the row required.
An upload row is proved by the page showing its file beside its own control
after the upload: a line whose name or value is the file name, or another line
naming the file that a model read, in any language, as saying it was uploaded
or attached (`workflow_state`, `file_attached`). A line read as a failed or
unfinished upload proves nothing, and neither does a line nobody has read.
An update-metadata job and a publication job check the values saved after the
dispatch against the requested ones. Which requested detail each saved field
holds is read from its label or name by a model, in any language
(`metadata_field` for the details of a video or other item, `publication_field`
for the parts of a post, release or file change), at `done` for the fields read
after the dispatch and before a write is recorded for the field it wrote. A
requested value has to read back from exactly one field read as that detail; a
label nobody has read holds no detail, so it cannot prove a value and is not
counted as a second field for one.
GitHub's resolve-review-threads job inventories the resolve control of each
unresolved review thread. Which buttons resolve one is read from their labels by
a model in any language (`review_thread_control`) before the read is recorded;
a read whose button labels are not all read yet leaves the inventory
incomplete, so the job's empty-inventory no-op cannot stand for a page whose
resolve controls nobody read.
Depth truncation is form-relevant (an omitted includable descendant). Empty
or erroring third-party frames are omitted only when another frame already
inventoried form controls; a lone failed cross-origin application frame stays
incomplete. Checkbox/radio/Next actions stale completeness until a
fresh root read. The executor receives the
app-owned stages plus success and partial evidence contract. Edited plan-review
text clears hidden workflow routing instead of retaining stale authorization.
Metadata-only traces retain only the adapter match/injection flag and, for a
selected job, its revision, schema, job, and template—never notes, page, form,
or message content.

```js
{
  name: 'example-forms',
  category: 'general',
  revision: 1,
  regions: ['global'],
  jobs: ['submit-form'],
  workflow: {
    schema: 'webbrain-adapter-workflow/2',
    jobs: {
      'submit-form': {
        description: 'Fill, review, submit, and verify the form.',
        template: 'form',
        stateChange: true,
        requiresSubmission: true,
        requiresLedger: true,
        stages: ['inventory', 'fill', 'review', 'reconcile', 'commit', 'verify'],
        successEvidence: ['A post-submit confirmation is visible.'],
        partialEvidence: ['Completed and unresolved questions plus the blocker are reported.'],
      },
    },
  },
  matches: (url) => /^https:\/\/forms\.example\.com\//.test(url),
  notes: `...`,
}
```

`workflow.jobs` must exactly match `jobs`. Job IDs and stages are stable
identifiers; evidence strings are bounded behavioral requirements, not CSS
selectors. `requiresSubmission` implies `stateChange`, every job includes
`verify`, and submission jobs also include `commit`. Bump `revision` whenever
the behavioral contract changes.

---

## Adapter Format

```js
{
  name: 'my-site',          // unique short identifier
  category: 'general',       // 'general' | 'finance'
  matches: (url) => /^https?:\/\/(www\.)?example\.com\//.test(url),
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
| `matches` | `(url) => boolean` | Returns `true` when the adapter should fire for this URL. Regex is preferred — keep it specific enough to avoid false matches. |
| `notes` | string | Bulleted guidance injected into the first user message. **Keep 4–8 lines max.** See style guidance below. |
| `revision` | positive integer | Optional workflow-contract revision. Required when any structured workflow field is present. |
| `regions` | string[] | Stable regions where the structured job contract applies, such as `global`, `CN`, or `MENA`. |
| `jobs` | string[] | Stable planner-routing IDs. Must exactly match `workflow.jobs`. |
| `workflow` | object | Optional validated `webbrain-adapter-workflow/2` job contract used to tighten runtime completion. |

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
  matches: (url) => /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//.test(url),
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
  matches: (url) => /^https?:\/\/(dashboard\.)?stripe\.com\//.test(url),
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
6. **If a workflow contract is present**: validate `listAdapterWorkflowProfiles()`, verify planner routing for positive and negative URLs, and test state-change, submission, ledger, trace-privacy, and Chrome/Firefox parity behavior.

### Manual test URLs

Open each adapted site and verify:
- The adapter loads on page 1 (not on a SPA route change)
- The notes are useful (don't mislead the model)
- The model doesn't follow outdated instructions

---

## Adding a New Adapter Checklist

- [ ] Add the adapter object to the `ADAPTERS` array in `src/chrome/src/agent/adapters.js`
- [ ] Mirror the exact same change to `src/firefox/src/agent/adapters.js`
- [ ] Ensure the `matches()` regex is specific and doesn't shadow neighboring adapters
- [ ] If `category: 'finance'`, place it BEFORE `finance-generic` in the array
- [ ] Verify the notes are 4–8 concise bullets
- [ ] Test matching with `getActiveAdapter(url)`
- [ ] Test end-to-end with the extension loaded
- [ ] For a structured profile, prove the job from repeated traces or current UI evidence; validate exact URL routing and completion requirements
- [ ] If the adapter targets a non-English market, add localized label hints (see the WordPress adapter for an example of how to annotate non-English UI labels)
