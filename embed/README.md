# WebBrain for websites — the embed widget

The script a site owner adds to their pages to give every visitor a WebBrain
assistant:

```html
<script src="https://sites.webbrain.one/embed.js" data-site-id="site_…"></script>
```

It is built from the WebBrain extension's own code in this repository, so the
widget reads and acts on pages exactly the way the extension does:

| Extension file (`src/chrome/`) | What the widget uses it for |
| --- | --- |
| `src/content/accessibility-tree.js` | Reading the page as an accessibility tree |
| `src/content/content.js` | Clicking, typing, scrolling and extracting on the page |
| `src/content/agent-visual-indicator.js` | The on-page activity glow |
| `src/ui/activity-brain.js` | The thinking animation |
| `src/ui/markdown-render.js` | Rendering answers |
| `src/agent/calculator.js` | Exact arithmetic |
| `src/agent/read-page-window.js` | Paging `read_page` results |
| `src/agent/credential-fields.js` | Keeping credential field values out of tool results |
| `src/agent/tools.js`, `adapters.js` | The Ask and Act tools and prompts in `tools.json` |

`src/widget-runtime.js` adds the launcher, the chat panel and the agent loop
that talks to the server. The widget only runs the tools `tools.json` lists
for the turn's mode, and Act is off unless the site's config sets
`modePolicy: "ask_and_act"`.

Elements with `data-webbrain-ask="…"` start an Ask run when a visitor clicks
them. `data-webbrain-act="…"` only puts its prompt in the composer for the
visitor to send, since any markup on the page, including content the site's
users wrote, can carry the attribute.

The widget is licensed GPL-3.0-or-later, like the rest of WebBrain. Every copy
of `embed.js` states its license and links back to this folder.

## Build and test

No dependencies to install; Node 20 or newer.

```bash
cd embed
npm run build   # writes dist/
npm test
npm run test:browser   # loads embed.js in Chrome; needs `npm ci` at the repository root
```

`dist/` contains:

| File | Purpose |
| --- | --- |
| `embed.js` | The widget |
| `tools.json` | System prompts and tool definitions for the server that answers the widget |
| `icon48.png`, `icon128.png` | WebBrain icons the widget shows |
| `VERSION.json` | Widget version, the commit it was built from, and a link to that source |
| `SHA256SUMS` | Checksums of the files above |

## Releases

1. Bump `version` in `embed/package.json`.
2. Push a tag `embed-v<version>`, for example `embed-v1.0.0`.

The **Embed widget** workflow builds, tests and publishes a GitHub release
with the files above. It is never marked as the repository's latest release,
so extension releases stay on top.

The server behind sites.webbrain.one pins one of these releases by version and
checks it against `SHA256SUMS`. Pull requests that change the widget or the
extension files it bundles run the same build and tests.
