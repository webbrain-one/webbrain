# The site in Turkish, Arabic and Persian

`web/index.html` is the English page and the template for the others. `build.mjs` writes `web/tr/`, `web/ar/` and `web/fa/` from it and from `tr.json`, `ar.json` and `fa.json`. Don't edit the written pages; edit the English page or a translation and run:

```bash
npm run web:i18n
```

## How a string gets translated

- In the English page, `data-i18n="key"` marks an element whose content is translated, and `data-i18n-<attribute>="key"` (for example `data-i18n-alt`) marks a translated attribute.
- Each entry in a language file keeps the English it was translated from (`en`) next to the translation. When the English page changes, the build lists the strings whose English no longer matches.
- To catch up after the English page changes:
  1. `node scripts/i18n/build.mjs --sync` adds new strings with an empty translation and drops the ones that are gone.
  2. Update the translations and run `--accept` to record the new English.
  3. `--check` fails if a page is out of date, which suits CI.

Translations are HTML. Keep the markup the English uses (`<em>`, `<strong>`, `<code>`, `<b>`, `<i>`), since the build reports any difference. You may change where `<br>` breaks a heading.

## Conventions

**Names.** Murshid, WebBrain and Companion stay in Latin letters in every language, and so do the model and product names.

**Turkish.**
- The nav, the buttons and the small labels are set in capitals, and Turkish capitals turn i into İ. Wrap a Latin name inside those strings in `<span lang="en">`, for example `<span lang="en">Murshid</span>'i indirin`. Otherwise the name comes out as MURSHİD.
- The page script does this for the system names in the hero's download button.

**Arabic and Persian.**
- The pages are right to left, but commands, file names and URLs stay left to right. `code` elements do this on their own.
- Wrap a Latin name that holds digits or hyphens in `<bdi>`, for example `<bdi>SHA-256</bdi>`, `<bdi>Bonsai 2 27B</bdi>` or `<bdi>GPL-3.0</bdi>`. Without it, the bidi algorithm reorders it (256-SHA).
- When a number follows a Latin word, as in the platform status lines (`x64 · 150 MB`), put a right-to-left mark (U+200F) before the number. Without it, the number joins the Latin run and the line reads backwards.
- In Persian, also put one after each `،` that separates Latin names.

**Persian.**
- Use Persian characters and digits: ی and ک, not the Arabic ي and ك, and ۰–۹ in prose.
- Put a zero-width non-joiner in می‌, ‌ها and the like.
- The build rejects Arabic letter forms, Arabic-Indic digits and a "می" followed by a space.
- Version numbers (0.1.0), x64 and IP addresses stay in Latin digits.

**Arabic.**
- Use Arabic letter forms, not the Persian ی and ک; the build rejects them.
- Digits are Western (0–9), as on most Arabic technology sites.

## Review

The Arabic and Persian copy was written without a native speaker's review and would benefit from one. The interface names in the install notes need it most: the Windows SmartScreen buttons in Arabic and the macOS settings path in Arabic. The Persian page gives these in English, because macOS has no Persian interface.
