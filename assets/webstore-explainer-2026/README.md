# Web Store explainer visuals 2026 — v5 (typographic, thumbnail-safe)

Same gallery and copy as v3/v4. v4 set headlines in Instrument Serif 400, which looked
good at full size but fell apart small: its hairlines are about a pixel at 88px, so on a
Product Hunt gallery thumbnail (~300px wide, headline ~20px effective) the strokes broke
up and went grey. v5 keeps the same structure with a display face that survives
downscaling.

No product icon and no "WebBrain" corner wordmark on any slide. The hero keeps a small
mono "WEBBRAIN" kicker as the only brand mark.

Type system:
- Display (headlines, prices, stat numerals) — **Bricolage Grotesque** 800, `opsz` 72–96
- UI (body, subs, panel text) — **Instrument Sans** 400–700
- Labels (eyebrows, chips, URLs, buttons) — **Geist Mono** 650, uppercase

Versus v4, tracking on the mono labels dropped from 0.11em to ~0.07em and their size went
up ~1px — wide-tracked small caps smear when downscaled. Sub weight went 450 → 520.

Check any type change at thumbnail size before shipping it:

```bash
sips -Z 320 --out /tmp/thumb.png assets/webstore-explainer-2026-5/01-hero.png && open /tmp/thumb.png
```

Fonts are vendored in `fonts/` and inlined as base64 at render time, so output does not
depend on what is installed locally. Both families are OFL 1.1; the license texts in
`fonts/OFL-*.txt` must stay with the binaries.

The mock agent panel on 02 still reads "WebBrain is acting" — depicted product UI, not
slide branding.

v2–v4 are untouched; the versions are independent copies, so a copy change needs applying
in each.

Files (1280×800):
- 01-hero.png: Mono kicker + heavy grotesque tagline hero
- 02-tell-the-browser.png: Flight-search command front and center as chat input, browser acting on it
- 03-ask-any-page.png: Ask mode, cropped to the answer panel
- 04-any-llm.png: Model picker, cropped to the provider dropdown
- 05-plan-before-act.png: Plan review with Approve/Adjust before actions run
- 06-launch-offer.png: WebBrain Compass $5/mo (reg. $8), Save 35%
- 07-social-proof.png: 1700+ GitHub stars, 100+ contributors, GPL — repo bar with contributor avatars
- 14-record-video.png: Record calls and demos with `/record`; illustrated call preview and screen/window command

Light-background alternates of the two dark slides (originals kept, use whichever fits the gallery):
- 01-hero-light.png
- 05-plan-before-act-light.png

Both come from the same `hero(light)` / `planScene(light)` functions, so edits apply to
dark and light together. In the light plan card the panel goes white and the accent green
darkens for contrast against white button text.

Star/contributor counts are hardcoded in `proofScene()`; bump them there when they go stale. The contributor avatars are a 2026-08-27 snapshot of human GitHub contributors, with `esokullu` first; bot, automation, AI-agent, and project-brand accounts are excluded.

Slide 07 is appended after the offer to keep the existing filenames stable. If proof-then-price reads better, swap the last two entries in the `scenes` array and rename the two PNGs.

Regenerate:

```bash
node assets/webstore-explainer-2026/render.mjs
```

Render only the recording slide with `ONLY=14-record-video.png node assets/webstore-explainer-2026/render.mjs`.

The renderer also writes copy-free variants of slides 02, 03, and 04 to
the Chrome and Firefox `install-assets` directories. The install page overlays
localized HTML copy on those variants; the Web Store images in this directory
keep their original English text. The install page's "Also built in" cards
(Apocalypse Mode, full-page screenshots, bulk downloads, recording, CAPTCHA,
SafeSocial) are live HTML/CSS scenes in `install-scenes.css`, so they need no
rendered artwork.

If browser launch is unavailable, `python3 assets/webstore-explainer-2026/render-record.py` renders slide 14 directly with Pillow and the same vendored fonts. This fallback uses an independently drawn layout.
