# WebBrain Settings walkthrough — recording script

Replaces the run of show in `assets/WebBrain_Settings_YouTube_Walkthrough.docx`, which follows the old six-tab layout (General, Providers, Multimodal, Memory, Skills, Permissions). Settings is now one page with a sidebar, three combined switches in General, and the former Providers and Permissions pages as sections.

The video it produces replaces `web/assets/webbrain-settings-walkthrough-1080p.mp4` (and its poster) on the docs overview, `/docs/#settings-walkthrough`. When the new video is in place, remove the "older layout" sentence from that section in `web/docs/index.html`.

Target running time: 16–19 minutes.

## Recording setup

- **Privacy check.** Record from a clean browser profile. Use dummy API keys, a fictional profile, harmless memory records and demo permission grants. Never show a real sync email, provider credential, personal memory or production trace. The synthetic profile used for the docs screenshots (`DOC_SEED` in `test/systemone-ui.mjs`) is a good starting point.
- **Window.** 1280 × 800 or larger, so the sidebar sits beside the page. Below about 880 px wide the sidebar turns into a strip above the page; show that once, in chapter 1, and record everything else wide.
- **Style.** Move the pointer slowly. Pause briefly after every sidebar click. Zoom only if the text stays sharp.
- **Editing rhythm.** Use each chapter's entry frame for its title card and the exit frame under the chapter's last sentence, then cut to the next section.

## Run of show

| Time | Chapter |
|---|---|
| 0:00 | One page, one sidebar |
| 1:00 | The fastest possible setup |
| 2:00 | General and the three combined switches |
| 5:00 | Models → LLM in detail |
| 7:00 | The helper models |
| 9:30 | Permissions & privacy |
| 11:00 | Budgets |
| 12:00 | Memory |
| 13:30 | Skills |
| 14:15 | Integrations: CAPTCHA and Bridge |
| 15:00 | Offline: Apocalypse Mode |
| 15:30 | Advanced |
| 17:30 | Recommended configurations and closing |

---

## Chapter 1 · 0:00 — One page, one sidebar

**Entry frame.** Settings open on General, the sidebar fully visible.

**On screen.** Hover down the sidebar, one entry at a time: General; the Models group (LLM, Vision, Speech, Generative, Decision, SafeSocial); Permissions & privacy; Budgets; Memory; Skills; the Integrations group (CAPTCHA, Bridge); Offline; Advanced. Then type "timeout" in the search box at the top of the sidebar, let the results from several sections appear, and clear it.

**Narration.**
- WebBrain has a lot of settings, but you only need a few of them. In this video I'll start with those, and then walk through every section, so you know what is there when you need it.
- Everything is on one page. The sidebar lists the sections: General for everyday choices, Models for the AI that powers WebBrain and its helpers, Permissions & privacy for what WebBrain may do and what leaves your browser, then Budgets, Memory, Skills, the Integrations, Offline mode and, at the bottom, Advanced.
- If you know what you're looking for, use the search box at the top. It searches every section at once and shows each match under its section's name.

**Optional close-up.** Narrow the window below 880 px to show the sidebar becoming a strip, then widen it again.

**Narration (optional).** In a narrow window, the sidebar becomes a strip you scroll sideways.

**Exit frame.** The sidebar with LLM highlighted.

---

## Chapter 2 · 1:00 — The fastest possible setup

**Entry frame.** Models → LLM, with the active provider card and its badge.

**On screen.** Point to the Active badge. Expand the active card, then briefly open one other card. Dummy credentials only.

**Narration.**
- If you only want to get started, this is the important part. You can also get here from the side panel: open the model menu and choose More….
- The provider marked Active is the model WebBrain uses right now. WebBrain Cloud needs no setup and includes a daily allowance. You can also use your own cloud API key, a model router, or a model running on your own computer.
- To switch, open a provider's card, fill in its fields, click Save, then Test Connection. When the test passes, click Set Active. That's the whole setup; everything after this is fine-tuning.

**Mid-chapter close-up.** Save, Test Connection and Set Active on a cloud card.

**Exit frame.** The active card after a successful test.

---

## Chapter 3 · 2:00 — General and the three combined switches

**Entry frame.** General, top of the section.

**On screen.** Show Appearance, Agent activity effect, Download directory, Messages during a running task, Selection shortcut and, in Chrome, Use WebBrain PDF viewer. Keep this brisk. Slow down at the three combined switches.

**Narration.**
- The first few settings are about comfort: light or dark mode, the animation you see while WebBrain works, where downloads go, and what happens when you type while a task is running: queue the message for later, or steer the task with it.
- Below them are three switches that each set a group of related settings at once. They're the most useful settings on the page.

**On screen.** Open the Agent supervision menu. Show Thorough, Balanced, Fast.

**Narration.**
- Agent supervision decides how closely WebBrain checks the agent while it works. Thorough plans every turn, asks you to approve each plan, and stops whenever a check can't confirm an action. Balanced, the default, adapts to the model: strong cloud models check their own work, smaller models get WebBrain's checks. Fast lets the model check its own work and runs plans without stopping for review. It's best with strong models.
- Whatever you pick, permission prompts stay on, and so do the limits on who receives a message, deleting data, spending money, credentials and publishing.

**On screen.** Open Image quality: Economy, Balanced, Sharp. Then Completion alerts: All, Quiet, Off.

**Narration.**
- Image quality decides how much picture the model gets. Economy sends smaller and fewer screenshots to save tokens. Sharp sends full-size screenshots after every action that changes the page, which costs more.
- Completion alerts decide what happens when a plan waits for you or a task finishes: a sound, confetti and a flashing tab, just the flashing tab, or nothing.

**Mid-chapter close-up.** Click "Fine-tune in Advanced" under Agent supervision; Advanced opens at the Agent supervision heading. Change Lean mode to Off, go back to General, and show the switch now reading Custom with its note. Pick Balanced again.

**Narration.**
- Each switch has a "Fine-tune in Advanced" link that takes you to the settings behind it. If you change one of those, the switch shows Custom. Pick a position to reset them.

**On screen.** Research escalation and, in Chrome, "Use WebBrain as my new tab page".

**Narration.**
- The last two are optional: Research escalation can offer to send a very complex research question to ChatGPT, always with your approval, and in Chrome WebBrain can replace your new tab page.

**Exit frame.** The three combined switches on their defaults.

---

## Chapter 4 · 5:00 — Models → LLM in detail

**Entry frame.** Models → LLM with the Local, Cloud and Router filters and the search field.

**On screen.** Click each filter. Search for "ollama". Open a local card (llama.cpp or Ollama) and point to the server URL, Load models, context window, Model Supports Vision and Prompt Tier. Then open a cloud card and point to the API key and the cost fields.

**Narration.**
- The list is long, so use the filters and the search box. The active provider always stays visible.
- A local provider needs the address of the server on your computer and a model name. Load models fills the model list for you. Context window and prompt tier tell WebBrain how much the model can handle; smaller local models do better with a smaller tier.
- Cloud providers need an API key. The cost fields only estimate usage for the cost allowance in Budgets; they don't change what the provider bills.
- In Chrome, the WebGPU card runs a model entirely in your browser, with no server at all.

**Exit frame.** The provider list with a filter applied.

---

## Chapter 5 · 7:00 — The helper models

**Entry frame.** Models → Vision.

**On screen.** Show the in-browser vision model choice (Chrome) and the optional endpoint fields. Then Speech, Generative, Decision (Auto / On / Off and its status line) and SafeSocial, one after another.

**Narration.**
- The other entries under Models are optional helpers. None of them changes your active provider.
- Vision decides what reads screenshots. If your chat model can see images, it does that itself. If it can't, Chrome can use a model running in your browser. You can also save a separate vision endpoint, so a cheaper chat model does the planning and a vision model only reads screenshots.
- Speech is a Whisper-compatible endpoint for recordings. Generative connects an image and video service for the generate tool.
- Decision models answer the agent's quick yes-or-no questions, like "is this task finished?". Auto needs no setup, and the status line tells you what it's using. On lets you pick a provider; Off never uses one.
- SafeSocial is an optional on-device filter for Instagram images.

**Exit frame.** Decision on Auto with its status line.

---

## Chapter 6 · 9:30 — Permissions & privacy

**Entry frame.** Permissions & privacy with "Ask before consequential actions" on and two demo grants.

**On screen.** Point to the master switch, then to the grant list; revoke one grant. Scroll to the Privacy heading and point to the three switches.

**Narration.**
- This is where you control what WebBrain may do. Keep "Ask before consequential actions" on. WebBrain then asks the first time it clicks, types or acts on a site. When you choose "Always allow", it remembers that one action on that one site, and the grant shows up here. Revoke it and WebBrain asks again.
- The same switch is in the side panel, behind the warning button next to the microphone, and its "Manage site permissions" link brings you here.
- Below, under Privacy: screenshot redaction blurs form fields and personal-looking text before a screenshot reaches a vision model. It's best effort, not a guarantee. Strict secret handling stops WebBrain from repeating passwords and keys in its answers. Local network access lets the agent reach servers on your own network; leave it off unless you need it.

**Mid-chapter close-up.** Turn the master switch off to show the warning, then turn it back on.

**Narration.** Turning the master switch off allows actions on every site without asking, until you turn it back on. That's much broader than allowing one action on one site.

**Exit frame.** The master switch back on.

---

## Chapter 7 · 11:00 — Budgets

**Entry frame.** Budgets.

**On screen.** Point to the two cost allowances and Reset spend, the clarify timeout and its policy, Max Agent Steps and the request timeout.

**Narration.**
- Budgets holds every hard limit. The cost allowances stop paid model calls once a conversation, or all conversations together, reach the amount you set.
- The clarify timeout decides how long a question waits for your answer, and what happens when nobody answers.
- Max Agent Steps caps how many actions one message may take, and the request timeout is how long WebBrain waits for the model to start answering. Slow local models may need more.

**Exit frame.** The step slider at 130.

---

## Chapter 8 · 12:00 — Memory

**Entry frame.** Memory with Encrypted Cloud Sync and profile auto-fill.

**On screen.** Point to sync, then profile auto-fill, then user memory with harmless demo records. Turn user memory off to show its options greying out, then back on.

**Narration.**
- Memory holds three things. Encrypted Cloud Sync, for Compass members, encrypts your keys, profile and memories with a password only you know before they're uploaded.
- Profile auto-fill is a short block of details WebBrain can use when filling forms. User memory keeps preferences you want WebBrain to remember. Auto-learning and learning from forms are optional, and they only work while user memory is on.
- Don't keep passwords or keys here.

**Exit frame.** The memory list.

---

## Chapter 9 · 13:30 — Skills

**Entry frame.** Skills with the enabled list and the packaged skills.

**On screen.** Point to the enabled list, then click Add skill to show the form, and Cancel.

**Narration.**
- Skills add instructions, and sometimes tools, to WebBrain. Enable a packaged skill, or add your own from a link or pasted text.
- Importing a skill is a trust decision: its tools can call the addresses it declares without asking each time.

**Exit frame.** The enabled list.

---

## Chapter 10 · 14:15 — Integrations: CAPTCHA and Bridge

**Entry frame.** CAPTCHA, with one card per solver.

**On screen.** Point to one solver card and its Advanced weight. Then open Bridge and point to "Let a backend control this browser", the presets and the pairing key.

**Narration.**
- Under Integrations, CAPTCHA holds your solver accounts. Nothing runs until you save a key, and you can enable several; the highest weight goes first.
- Bridge lets another program drive this browser: an MCP client like Claude Code or Cursor, LM Studio, or WebBrain Cloud. It's off until you turn it on, and it only accepts connections from your own computer. The MCP and LM Studio guides walk through the setup.

**Exit frame.** Bridge, switched off.

---

## Chapter 11 · 15:00 — Offline: Apocalypse Mode

**Entry frame.** Offline with its status line.

**On screen.** Point to the status line, then click "Open Apocalypse Mode" and show the kit page opening in a new tab. Close it.

**Narration.**
- Offline shows whether Apocalypse Mode is on and what it has installed. Open Apocalypse Mode to manage it: the switch, the local models and the offline Wikipedia archives live on its own page, because turning it on starts large downloads.

**Exit frame.** The Offline section.

---

## Chapter 12 · 15:30 — Advanced

**Entry frame.** Advanced, at the Agent supervision heading.

**On screen.** Scroll slowly through the headings: Agent supervision, Vision and screenshots, Completion alerts, Privacy and diagnostics, Automation, Network and API, Interface. Pause on Enforce action guards, Lean mode and the image budget.

**Narration.**
- Advanced holds every fine-grained control, sorted under headings. The first three groups are the settings behind the combined switches in General, so you rarely need to touch them one by one.
- Enforce action guards should stay on. Turning it off lets the model decide by itself whether to send, retry, delete or publish.
- Lean mode, planning and plan review are what the Agent supervision switch sets. Vision mode, screenshot size, auto-screenshot and the image budget are what Image quality sets.
- The rest are for specific needs: Record traces for comparing models, scheduled tasks and their confirmation, cookie banners, site adapters, the API options, and interface preferences like Verbose Mode and voice input.

**Exit frame.** The Agent supervision heading.

---

## Chapter 13 · 17:30 — Recommended configurations and closing

**Entry frame.** General with the three combined switches.

**On screen.** Set each configuration as it's described, then return everything to the defaults.

**Narration.**
- Three configurations cover most people.
- A strong cloud model: leave everything on Balanced. If you trust the model and want speed, try Agent supervision on Fast.
- A smaller or local model: keep Agent supervision on Balanced, or Thorough for important tasks, and Image quality on Economy if screenshots are slow.
- Privacy first: run a local model, turn on screenshot redaction and strict secret handling in Permissions & privacy, and keep local network access off.
- Whatever you choose, keep "Ask before consequential actions" on. That's it. Thanks for watching.

**Exit frame.** Hold the sidebar for two seconds, then cut to the WebBrain side panel or the end card.
