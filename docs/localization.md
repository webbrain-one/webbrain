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
    ├── es.js              # Spanish
    ├── fr.js              # French
    ├── tr.js              # Turkish
    ├── zh.js              # Chinese
    ├── ru.js              # Russian
    ├── uk.js              # Ukrainian
    ├── ar.js              # Arabic
    ├── ja.js              # Japanese
    ├── ko.js              # Korean
    ├── id.js              # Indonesian
    ├── th.js              # Thai
    ├── ms.js              # Malay
    └── tl.js              # Filipino
```

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
  'brand': 'WebBrain',
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

1. Open the extension settings
2. Switch to the new language in the Language dropdown
3. Verify the side panel, settings, and traces pages render correctly
4. Check that missing keys fall back to English gracefully
5. Test RTL layouts if adding Arabic or Hebrew

---

## Translation Tips

- **Keep placeholders intact**: `{model}`, `{error}`, `{count}` must appear exactly as in the English file. The code replaces these with runtime values.
- **Don't translate brand names**: "WebBrain" is kept in English across all locales.
- **Watch for HTML in values**: Some keys contain HTML (`data-i18n-html`). Preserve the HTML structure but translate the text content.
- **Plurals**: The system doesn't have plural forms. Use `{n} item(s)` style or code-level plural handling where needed.
- **Tool labels**: Keys starting with `tool.` are used as compact step labels in the side panel. Keep them short (2–4 words).

### Key Naming Conventions

| Prefix | Section |
|---|---|
| `sp.` | Side panel UI |
| `st.` | Settings page |
| `tr.` | Traces page |
| `tool.` | Tool labels |
| `ob.` | Onboarding flow |

---

## Maintenance

- `en.js` is the canonical source of truth. When adding a new key, always add it to `en.js` first.
- After adding a key to `en.js`, add it to every other locale file. English values as placeholders are acceptable for initial commits.
- Updated strings in `en.js` should be flagged for translators — there is no automated sync.
