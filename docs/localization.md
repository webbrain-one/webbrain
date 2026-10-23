# Localization

---

## How It Works

The UI (side panel, settings, traces page) is translated via a simple key-based system in `src/chrome/src/ui/i18n.js`. It works identically in Chrome and Firefox.

### Architecture

```
src/chrome/src/ui/
├── i18n.js                # Core: t(), setLocale(), applyDOMTranslations()
└── locales/
    ├── en.js              # English — canonical, always complete
    ├── ar.js              # Arabic
    ├── bn.js              # Bengali
    ├── de.js              # German
    ├── es.js              # Spanish
    ├── fa.js              # Persian
    ├── fr.js              # French
    ├── he.js              # Hebrew
    ├── hi.js              # Hindi
    ├── id.js              # Indonesian
    ├── ja.js              # Japanese
    ├── ko.js              # Korean
    ├── ms.js              # Malay
    ├── nl.js              # Dutch
    ├── pl.js              # Polish
    ├── pt.js              # Portuguese
    ├── ru.js              # Russian
    ├── th.js              # Thai
    ├── tl.js              # Filipino
    ├── tr.js              # Turkish
    ├── uk.js              # Ukrainian
    ├── vi.js              # Vietnamese
    └── zh.js              # Chinese
```

The side panel's language picker lists all **23** locales from `LANGUAGES` in
`i18n.js` (English and Chinese pinned first; the rest sorted by English name).
The settings pages follow the chosen language through `wb-locale-changed`.
### Key Functions

```js
import { t, setLocale, getLocale, applyDOMTranslations, LANGUAGES } from './i18n.js';

// Translate a key
t('sp.btn.send')              // → "Send"
t('sp.status.connected', { model: 'gpt-5' })  // → "Connected (gpt-5)"

// Change locale
setLocale('tr');
applyDOMTranslations(document);  // Re-translate the current page

// Available languages
LANGUAGES  // → [{ code: 'en', label: 'English' }, { code: 'tr', label: 'Türkçe' }, ...]
```

### English Fallback

If a key is missing from the active locale, the `t()` function falls back to `en.js`:

```js
export function t(key, params) {
  const dict = DICTS[currentLocale] || DICTS.en;
  let s = dict[key];
  if (s == null) s = DICTS.en[key];  // English fallback
  if (s == null) return key;         // Last resort: return the raw key
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
  }
  return s;
}
```

This means a partial translation is safe to ship — missing keys just show English.

### Agent response language

The interface locale and the language of an agent-authored deliverable are related but not identical. The interface locale is a fallback for conversational framing; it is not a blanket instruction to translate every result.

For Act-mode planning, the planner records a trusted response-language policy with three parts:

- `framing_locale`: the language used for explanations around the result;
- `deliverable_locales`: languages explicitly required for authored output, such as the target of a translation or both sides of a bilingual comparison;
- `preserve_source_text`: whether quoted, extracted, or transcribed source text must remain in its original language.

The policy is derived only from the user's request and trusted conversation context. Page text, titles, URLs, documents, and tool results are untrusted data and cannot choose the response language. An explicit response-language instruction sets the framing language, while a translation target changes only the authored deliverable. Explicit translation and multilingual instructions take precedence over the framing locale, and all requested deliverable locales are preserved. Code, identifiers, URLs, product names, and personal names remain unchanged unless the user requests translation or transliteration.

When the user edits an approved plan, explicit language instructions in that user-edited plan override the policy inferred before review. This exception applies only to the runtime-marked approved-plan block; it does not grant authority to other scratchpad content.

When **Continue** resumes an interrupted run, DIV carries the normalized policy only into that trusted continuation of the same conversation. The handoff is stored in the session snapshot so it survives a browser worker restart, then consumed as a one-shot value. For a fallback policy, the synthetic Continue message is explicitly excluded from language inference, which remains anchored to the most recent earlier genuine user request. A genuine new user turn discards the carryover and derives a new policy from the new request.

If planning is unavailable, DIV infers framing from the language of the latest genuine user request. It uses the interface locale only as a soft fallback when that request language is unclear, and continues to honor explicit language or translation instructions.

An incomplete or malformed planner language policy is treated the same way as an unavailable policy. In particular, a missing source-preservation decision never defaults to translating quoted or extracted text. A planner answer that names deliverable languages but supplies only invalid locale codes also fails closed, while an explicitly empty deliverable list is kept as the coherent answer it is: no fixed target, so the deliverable follows the framing language or an explicit instruction in the request.

The policy is written into the system prompt once per run, in one of two renderings. An ordinary policy, meaning the deliverable language matches the framing language and source text stays as it is, gets a single line of about 40 tokens. Translation targets, multilingual deliverables, approved-plan overrides, and continuations resumed by the synthetic Continue control keep the full block, because those are the cases where the precise wording earns its cost. On the compact prompt tier the short rendering is used wherever it can carry the policy without losing the deliverable language, since the compact base prompt is only around 1,500 tokens. Forced terminal delivery always gets the full block and repeats it in the `done` schema; ordinary turns do not, so the instruction appears once per request rather than twice.

### DOM Translation

HTML elements use `data-i18n` attributes:

```html
<button data-i18n="sp.btn.send">Send</button>
<span data-i18n-title="sp.tooltip.help">?</span>
<input data-i18n-placeholder="sp.input.ask_placeholder">
```

`applyDOMTranslations(root)` processes `data-i18n`, `data-i18n-html`, `data-i18n-title`, `data-i18n-placeholder`, and `data-i18n-aria-label`.

---

## Adding a New Locale

### Step 1: Create the translation file

Copy `src/chrome/src/ui/locales/en.js` to `src/chrome/src/ui/locales/<code>.js` and translate the values.

The file exports a flat key → string map:

```js
export default {
  'brand': 'DIV',
  'sp.btn.send': 'Send',
  // ... all keys from en.js
};
```

### Step 2: Register in i18n.js

Add to the import, dictionary, and `LANGUAGES` array:

```js
import de from './locales/de.js';

const DICTS = { en, es, fr, tr, zh, ru, uk, ar, ja, ko, id, th, ms, tl, de };

export const LANGUAGES = [
  // ... existing entries ...
  { code: 'de', label: 'Deutsch' },
];
```

### Step 3: Mirror to Firefox

Copy the locale file to `src/firefox/src/ui/locales/<code>.js` and update `src/firefox/src/ui/i18n.js` identically.

### Step 4: Test

1. Open the side panel
2. Pick the new language from its language menu (top left)
3. Verify the side panel, settings, and traces pages render correctly
4. Check that missing keys fall back to English gracefully
5. Test RTL layouts for Arabic and Hebrew; `RTL_LOCALES` in `i18n.js` controls document direction

---

## Translation Tips

- **Keep placeholders intact**: `{model}`, `{error}`, `{count}` must appear exactly as in the English file. The code replaces these with runtime values.
- **Don't translate brand names**: "DIV" is kept in English across all locales.
- **Watch for HTML in values**: Some keys contain HTML (`data-i18n-html`). Preserve the HTML structure but translate the text content.
- **Plurals**: The system doesn't have plural forms. Use `{n} item(s)` style or code-level plural handling where needed.
- **Tool labels**: Keys starting with `tool.` are used as compact step labels in the side panel. Keep them short (2–4 words).

### Key Naming Conventions

| Prefix | Section |
|---|---|
| `sp.` | Side panel UI |
| `st.` | Settings, Providers and Permissions pages |
| `tr.` | Traces page |
| `tool.` | Tool labels |
| `ob.` | Onboarding flow |

---

## Maintenance

- `en.js` is the canonical source of truth. When adding a new key, always add it to `en.js` first.
- After adding a key to `en.js`, add it to every other locale file. English values as placeholders are acceptable for initial commits.
- Updated strings in `en.js` should be flagged for translators — there is no automated sync.

### Agent-emitted copy

Most user-facing strings come from `src/chrome/src/ui/locales/`, which the service
worker cannot use: those dictionaries are DOM-scoped and loaded by `i18n.js` in a
page context. Strings the agent itself writes into an answer live beside the agent
instead.

`src/chrome/src/agent/offline-answer-copy.js` holds the copy for the standalone
Apocalypse Mode chat's unverified-answer caveat: the label, the two cautions
(general and health), and the reason each offline source came up empty. It ships
English plus the same 22 locales as the interface, and follows the same shape as
`apocalypse-copy.mjs`: a canonical English map, a per-locale override map, and an
accessor with English fallback.

```js
import { offlineAnswerText } from './offline-answer-copy.js';

offlineAnswerText(runOptions.locale, 'oa.gap.wikipedia.not_installed');
```

Two rules for this file:

- Product names are inlined per locale, matching the names already used in
  `apocalypse-translations.mjs` and `emergency-translations.mjs`. Turkish says
  "Acil Durum Kutusu", not "Emergency Box".
- Model-facing text is not copy. The ungrounded answer policy and the mid-sentence
  recovery nudge stay English in `agent.js`, because they instruct the model rather
  than address the user.

The caveat follows the interface locale. The model itself replies in the language
of the request, so a user asking in Turkish from an English interface will see a
Turkish answer under an English caveat. Interface locale is the soft fallback the
response-language rules already describe, and it is deterministic; inferring the
request language for the caveat alone would not be.

This file is Chrome-only, like the standalone WebGPU path it serves. Firefox MV2
has no on-device standalone chat, so it has no importer.
