# WebBrain 49.0.0 Settings walkthrough

This is the source script for the 1080p English walkthrough embedded at `/docs/#settings-walkthrough`. It replaces the version 22.3.1 video and follows the current `src/chrome/src/ui/settings.html` sidebar. Providers and Permissions are sections on this one page; their old HTML pages redirect here.

The machine-readable scene list is [`settings-walkthrough-scenes.json`](settings-walkthrough-scenes.json). Each scene contains its stable ID, title, sidebar `data-tab` value, actual UI focus selector, and spoken narration. Optional `shots` contain additional focus selectors and exact spoken `cue` phrases; switch to each at its measured word time. Treat that JSON as the narration source of truth. The transcript below mirrors it.

There are 34 scenes and 1,678 narration words. Duration and chapter offsets must come from the rendered audio; do not reuse the old video's timestamps. Each screen must remain visible for its complete matching narration, including natural pauses.

## Capture and narration notes

- Use the actual current HTML, styles, localization, and rendering logic. Record with a clean, isolated demo browser profile; never read an existing personal browser profile or credentials.
- Capture English at 1920 × 1080, keeping the sidebar visible. Focus the scene selector and preserve enough surrounding UI to make its location clear. A long card may need more than one view.
- For scene 09 expand the OpenAI provider card; for scene 10 expand Ollama. Keep credentials blank or use visibly fictional demo data. Do not show a successful connection unless a real test was performed.
- Scene 02 explains search; demonstrating a harmless query and clearing it is optional. Scene 05 explains Unsupervised without turning it on. Do not enable bridges, download models, connect accounts, buy credits, or change real permissions during recording.
- Use a calm, conversational English voice. Align captions and screen changes to measured speech timing. Give every new section a brief visual settling pause.
- Final outputs replace `web/assets/webbrain-settings-walkthrough-1080p.mp4` and its poster. Update the embed version, duration, captions, and cache version after rendering; remove any statement that this video shows an older layout.

## Reproducing the video

The current cut is **14:18.20**, 1920 × 1080 at 25 fps, with English Aria Neural
narration, 198 caption cues, and 34 chapters. The voice runs at `-8%`; each scene
adds 350 ms before speech and at least 650 ms after it. Additional focus shots
switch at the narration's measured word boundaries.

Authoring requires the repository's Playwright installation and Chromium,
FFmpeg/ffprobe on PATH, and Python with `edge-tts` (this cut used 7.3.1). Edge TTS
sends only the public narration text to Microsoft's speech service. The capture
uses an isolated synthetic profile and blocks external network requests.

After updating the scene narration and selectors for any future UI changes:

```sh
node scripts/render-settings-walkthrough.mjs --capture
py -3.11 scripts/narrate-settings-walkthrough.py
node scripts/render-settings-walkthrough.mjs --render
npm run build:web
```

On other platforms, use the Python executable with `edge-tts` installed instead
of `py -3.11`. Temporary PNGs, speech, exact timings, and clips stay in the ignored
`.build/settings-walkthrough/` directory. The renderer replaces the MP4 and poster
and writes the English caption and chapter WebVTT files under `web/assets/`.
Update the docs duration and media cache version if the resulting cut changes.

## Chapter grouping

| Scenes | Chapter | Content |
|---|---|---|
| 01–02 | One page, one sidebar | General and cross-section search |
| 03–07 | Everyday choices | General, supervision, image quality, alerts |
| 08–10 | Choose a main model | LLM, cloud setup, local setup |
| 11–15 | Supporting models | Vision, Speech, Generative, Decision, SafeSocial |
| 16–17 | Permissions and privacy | Site permissions, redaction, secrets, local network |
| 18–19 | Budgets | Cloud allowances, clarification, steps, request timeout |
| 20–23 | Memory | Encrypted sync, profile, user memory, MemCode recall |
| 24 | Skills | Packaged and custom skills |
| 25–27 | Integrations | CAPTCHA, Bridge, experimental WebMCP |
| 28 | Offline | Apocalypse Mode status and kit manager |
| 29–33 | Advanced | Supervision, images, diagnostics, automation, API and interface |
| 34 | A simple starting configuration | Return to General |

## Current behavior checked against source

- Main provider selection is labeled **Selected** / **Select for chat**. An **Active** badge can also indicate a configured provider; the two concepts are distinct.
- WebBrain Compass includes a free **weekly** allowance. Eligible cloud cost budgets exclude Compass and local providers.
- Supervision has Thorough, Balanced, Fast, and Unsupervised. Only Unsupervised disables action guards; the permission gate is a separate setting in every preset.
- Screenshot redaction, strict secret handling, and agent access to the local network start off. Redaction is best effort.
- Cloud sync is for Compass members and excludes chat history and OAuth sign-ins. MemCode recall is a separate optional read-only integration.
- Experimental WebMCP page tools are different from connecting an external MCP client through Bridge.
- Sources reviewed: `settings.html`, `settings.js`, `settings-presets.js`, provider rendering, and the English Settings, presets, sidebar, CAPTCHA, Bridge, SafeSocial, and MemCode localization copy.

## Narration and capture targets

### 01-overview · One Settings page, one sidebar

**Section:** `display` · **Focus:** `#display-settings`

Welcome to WebBrain. This walkthrough follows the redesigned Settings page in version forty-nine. Everything now lives behind one sidebar, including models and permissions. We'll start with the everyday choices, then visit the deeper controls. You don't need to configure every section before your first conversation.

### 02-navigation · Find a setting quickly

**Section:** `display` · **Focus:** `#settings-search`

The sidebar is your map. General comes first, followed by Models, Permissions and privacy, Budgets, Memory, and Skills. Integrations, Offline, and Advanced sit below. The search box looks across all sections, so you can find a setting without remembering where it lives. Clear the search to return to browsing.

### 03-general · General: everyday comfort

**Section:** `display` · **Focus:** `#display-settings .setting-row:first-child`

General starts with appearance, the agent's activity effect, and an optional download subfolder. Messages during a running task can wait in the queue or steer the current work. Selection shortcuts and Chrome's PDF viewer are here too. These are everyday preferences; begin with whatever feels comfortable.

### 04-supervision · Agent supervision

**Section:** `display` · **Focus:** `[data-preset-group=supervision]`

Agent supervision combines several controls. Balanced is the default and adapts to your model. Thorough plans every turn, asks for plan approval, and stops when a check cannot confirm an action. Fast lets the model check its own work and skips plan-review stops. It makes most sense with a capable model.

### 05-unsupervised · Understand Unsupervised

**Section:** `display` · **Focus:** `[data-preset-group=supervision]`

There is also an Unsupervised option. It turns off action guards, including checks around recipients, deletion, spending, credentials, and publishing. Treat that as a deliberate trust decision. Permission prompts remain a separate setting in every preset. For a first setup, leave supervision on Balanced.

### 06-image-quality · Image quality

**Section:** `display` · **Focus:** `[data-preset-group=image]`

Image quality balances detail against cost. Economy sends smaller and fewer screenshots. Balanced is the everyday default. Sharp sends larger, high-detail images and captures after actions that change the page. Try more detail when the agent struggles to see something; use Economy when image traffic is expensive or slow.

### 07-alerts-presets · Alerts and fine-tuning

**Section:** `display` · **Focus:** `[data-preset-group=alerts]`

Completion alerts can play sounds, show confetti, and flash the tab. Quiet keeps only the flashing tab; Off disables those alerts. Each combined control has a Fine-tune in Advanced link. If individual settings no longer match a preset, General shows Custom. Choosing a preset restores that group's settings.

### 08-llm · Models: choose your main model

**Section:** `llm` · **Focus:** `#providers`

Under Models, LLM is where you choose the main conversational model. Look for the Selected badge to see which provider is selected for chat. WebBrain Compass includes a free weekly allowance. You can also bring a cloud API key, use a router, or connect a local model.

### 09-provider-setup · Save, test, select for chat

**Section:** `llm` · **Focus:** `.provider-card[data-provider-id=openai]`

- At “save the configuration”: `.provider-card[data-provider-id=openai] .btn-row:has(.btn-save)`

Use the category filters and provider search to narrow the list, then expand a card. For a cloud API, enter your key and model, save the configuration, and test the connection. Select for chat chooses it for conversation. A configured provider and the provider selected for chat are different things.

### 10-local-models · Local models and model capacity

**Section:** `llm` · **Focus:** `.provider-card[data-provider-id=ollama]`

- At “Check the context window”: `.provider-card[data-provider-id=ollama] .field:has([data-key=contextWindow])`
- At “Ollama also needs”: `.provider-card[data-provider-id=ollama] .provider-ollama-warning`

Local providers need a running server and its address. Load models helps find what's available. Check the context window and prompt tier against your model's capacity. Ollama also needs to allow the extension's origin; its card explains that setup. Chrome's WebGPU provider is another option, running the model inside the browser.

### 11-vision · Vision: reading screenshots

**Section:** `vision` · **Focus:** `#vision-card`

- At “or you can configure a separate endpoint here”: `#vision-endpoint-fields`

The remaining model sections configure helpers. Vision decides how screenshots are read. A capable chat model can handle images itself. Chrome also offers an in-browser vision route, or you can configure a separate endpoint here. A separate vision model can read screenshots while your main model handles the conversation.

### 12-speech · Speech: transcribing recordings

**Section:** `speech` · **Focus:** `#transcription-card`

Speech holds a Whisper-compatible transcription endpoint: its base URL, API key, and model. Save and test it before relying on recordings. This is an optional helper configuration. You can leave it alone if you don't need transcription, and return when you have a service you want to use.

### 13-generative · Generative: images and video

**Section:** `generative` · **Focus:** `#image-gen-card`

Generative connects the services used to create images and video. Choose a provider, then configure the model and any required credentials. The fields change for hosted services and local ComfyUI workflows. Video has its own model and resolution options. Set up only the media service you intend to use.

### 14-decision · Decision: small supporting judgments

**Section:** `decision` · **Focus:** `#system-one-card`

Decision models handle supporting judgments, such as checking whether a task is complete. Auto chooses the available route without manual setup, and the status line explains what it is using. On reveals provider controls and individual features. Off disables this helper. Start with Auto unless you have a specific reason to change it.

### 15-safesocial · SafeSocial: an optional local filter

**Section:** `safesocial` · **Focus:** `#safesocial-card`

- At “Choose the categories”: `#safesocial-card .safesocial-labels-fieldset`
- At “A higher threshold”: `#safesocial-card .field:has(#safesocial-threshold)`

SafeSocial is an optional local image classifier for Instagram. Choose the categories you want softened, then blur, hide, dim, or warn on matching images. A higher threshold filters fewer images. It starts off; enabling it downloads a model. Classification runs on your device, and filtered images can be revealed.

### 16-permissions · Permissions and privacy

**Section:** `permissions` · **Focus:** `#permissions-card`

Permissions and privacy is now a section in this same sidebar. Keep Ask before consequential actions on. Saved site permissions appear underneath, where you can revoke them. Allowing an action on one site is a narrower choice than turning off the permission gate for every site.

### 17-privacy · Screenshot redaction and secrets

**Section:** `permissions` · **Focus:** `#screenshot-redaction-setting`

The Privacy controls below are separate choices. Screenshot redaction tries to blur sensitive-looking content before vision processing, but cannot guarantee that everything is hidden. Strict secret handling prevents credentials being repeated in answers. Both start off. Local network access also starts off; enable it only when your task needs that access.

### 18-cost-budgets · Budgets: cloud cost allowances

**Section:** `budgets` · **Focus:** `#budget-settings .setting-row:first-child`

Budgets brings the limits together. Session and total cost allowances stop further eligible paid model calls when reported or estimated spend reaches the allowance. These controls apply to usage-billed cloud and router providers. They exclude WebBrain Compass and local providers. Estimated cost here is not a replacement for your provider's billing records.

### 19-timeouts · Questions, steps, and timeouts

**Section:** `budgets` · **Focus:** `.setting-row:has(#range-clarify-timeout)`

- At “Below that, Max Agent Steps”: `.setting-row:has(#range-max-steps)`

Clarify timeout controls how long ordinary questions wait, and the next option decides what happens afterward. Permission and form-submit confirmations still wait for you. Below that, Max Agent Steps limits a run's length, and request timeout controls how long WebBrain waits for the model. Slow local models may need more time.

### 20-sync · Memory: encrypted cloud sync

**Section:** `memory` · **Focus:** `#profile-sync-card`

Memory begins with optional encrypted cloud sync for Compass members. It syncs memories, profile autofill, and API-key provider settings, encrypted with your sync password before upload. Chat history and OAuth sign-ins are excluded. Keep that password somewhere safe: WebBrain cannot recover it for you.

### 21-profile · Profile auto-fill

**Section:** `memory` · **Focus:** `#profile-card`

Profile auto-fill is a short block of details the agent can reuse, for example a name, company, or preferred writing style. When enabled, this text goes into the model's prompt. Keep it minimal. It is stored locally in plain text, so this is not a password vault.

### 22-user-memory · User memory and optional learning

**Section:** `memory` · **Focus:** `#user-memory-card`

- At “Review saved records”: `#user-memory-card .field:has(#user-memory-list)`
- At “Automatic learning after chats”: `#user-memory-card .setting-row:has(#toggle-user-memory-auto)`

User memory holds durable preferences across tasks. Review saved records, forget outdated details, or export and import them. Automatic learning after chats and learning from completed forms are optional. The character limit controls how much memory reaches the prompt. Enabled memory is shared with your configured model, so avoid storing secrets.

### 23-memcode · Optional MemCode recall

**Section:** `memory` · **Focus:** `#memcode-recall-card`

MemCode adds optional recall from a connected account. Connecting the account and enabling recall are separate steps. The integration is read-only and does not automatically upload your local memory. Search queries and matching memories reach MemCode and your configured model. Local WebBrain memory remains the default.

### 24-skills · Skills: reusable instructions

**Section:** `skills` · **Focus:** `#skills-settings`

- At “or use Add skill”: `#btn-show-skill-form`

Skills add reusable instructions and sometimes tools. Review the enabled and packaged lists, or use Add skill to import a URL or paste instructions. Relevant skills are loaded on demand in Mid and Full prompt tiers; Compact does not load them. Read unfamiliar skills before enabling them, especially their tool permissions.

### 25-captcha · Integrations: CAPTCHA solvers

**Section:** `captcha` · **Focus:** `#captcha-card`

- At “When multiple solvers are available”: `.captcha-provider[aria-labelledby=capsolver-heading] .captcha-advanced`

Under Integrations, CAPTCHA holds optional solver accounts. Configure a service with your own key, save it, and test it. When multiple solvers are available, their advanced weights set the preference order. These are separate services with their own usage charges. You can leave this section unconfigured until a task calls for it.

### 26-bridge · Bridge: connect another program

**Section:** `cloudbridge` · **Focus:** `#cb-card`

Bridge lets a backend control this browser. Choose the Cloud, MCP, LM Studio, or custom local destination, then supply the matching pairing information. Only one destination is active at a time. The connection status shows whether setup worked. Leave Bridge off until you want a trusted program connected to your browser.

### 27-webmcp · Experimental WebMCP

**Section:** `cloudbridge` · **Focus:** `#webmcp-card`

The experimental WebMCP switch below Bridge is a separate feature. It lets WebBrain discover structured tools offered by supported Chrome pages. It does not configure an external MCP client. Use the documentation link when setting up a backend connection; the names are similar, but the directions of integration differ.

### 28-offline · Offline: Apocalypse Mode

**Section:** `offline` · **Focus:** `#apocalypse-mode-summary`

Offline shows the status of Apocalypse Mode. Its button opens the separate kit manager, where you prepare local models and offline reference archives. Set that up while you have a connection and enough storage. This Settings section is the overview; the downloads and detailed offline controls live in the kit manager.

### 29-advanced-supervision · Advanced: supervision controls

**Section:** `advanced` · **Focus:** `#adv-group-supervision`

- At “The default review policy”: `#row-plan-review-confidence`

Advanced exposes the controls behind General's presets. Action guards, strict checks, Lean mode, planning, and plan review sit together. The default review policy uses a confidence threshold. If you change these individually, General may show Custom. Keeping the Balanced preset is a useful starting point while you learn the trade-offs.

### 30-advanced-vision · Advanced: screenshots and image budget

**Section:** `advanced` · **Focus:** `#image-budget-card`

Vision and screenshots includes automatic capture, detail level, image count, and maximum dimensions. These controls can materially change token use and how well the model sees small text. The Image quality preset changes several together. If you fine-tune them, make one change at a time and compare the result.

### 31-diagnostics · Privacy and diagnostics

**Section:** `advanced` · **Focus:** `#adv-group-privacy`

Privacy and diagnostics includes Help Improve WebBrain, which is on by default for eligible Compass text and tool interactions. Review its explanation and opt out here if you prefer. Local and bring-your-own API requests have separate per-provider research sharing. Trace recording is another control; inspect diagnostic exports before sharing them.

### 32-automation · Automation controls

**Section:** `advanced` · **Focus:** `#adv-group-automation`

Automation brings together scheduled tasks, confirmation for consequential scheduled actions, cookie banners, and site adapters. Keep scheduled confirmations enabled while you get comfortable with unattended work. Cookie-banner behavior has its own menu, so choose how broadly it should apply. These controls are available when a workflow gives you a reason to adjust them.

### 33-network-interface · Network, API, and interface

**Section:** `advanced` · **Focus:** `#adv-group-network`

The final Advanced groups cover API mutation access, request observation, streaming, and interface preferences such as verbose output, voice input, and tab grouping. Read each description before changing behavior you rely on. Allowing API mutations does not remove the other confirmation checks. Most people can leave these controls as they are.

### 34-closing · A simple starting configuration

**Section:** `display` · **Focus:** `[data-preset-group=supervision]`

That's the new Settings layout. Choose your model, keep supervision and image quality on Balanced, and leave permission prompts enabled. Adjust alerts to your taste. Then return to a real task, see what helps, and change settings only when you have a reason. The sidebar and search will bring you back to the right place.
