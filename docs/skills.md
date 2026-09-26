# Skills

A skill is trusted instruction text — optionally with its own tool manifest —
that WebBrain loads into a run **only when it is relevant**. Manage them under
Settings → Skills, where you can import skill text or a URL, or remove any
bundled skill.

## How loading works

Mid and Full runs receive a small catalog of eligible skills: ID, name, summary,
and optional canonical semantic intents. Full instructions are appended to the
system prompt only after the skill is activated for the current run, via
`load_skill`. **Compact tier disables skills entirely** — no loader, no skill
prompt, no skill tools.

Imported skills are copied into browser local storage.

## Metadata

An optional fenced `webbrain-skill` JSON block can declare:

| Field | Meaning |
|---|---|
| `summary` | Maximum 200 characters |
| `modes` | `ask`, `act`, and/or `dev` |
| `intents` | Up to six canonical intents such as `verification_code` or `public_media_download` |

Intents are cross-language *meaning* hints for the LLM, not literal keyword
matching. Skills without metadata infer the first prose paragraph as their
summary, have no inferred intents, and default to Act/Dev.

WebBrain also recognizes the required `name` and `description` YAML frontmatter
from an imported [Agent Skills `SKILL.md`](https://agentskills.io/specification).
The name and description populate the routing catalog, and the frontmatter is
removed before the Markdown body is loaded. A name entered in Settings and a
`webbrain-skill` block still take precedence.

This is instruction-only compatibility. WebBrain imports one text document; it
does not fetch bundled `scripts/`, `references/`, or `assets/`, execute skill
code, or treat the Agent Skills `allowed-tools` field as a WebBrain permission
or tool manifest. Use `webbrain-tools` for WebBrain HTTP tools. WebBrain
recognizes `webbrain-skill` and `webbrain-tools` fences only in the Markdown
body after valid frontmatter; fence-like text inside frontmatter cannot grant
routing eligibility or register tools.

## Skill tools

A skill can expose read-only HTTP tools, or short-lived download-job tools, with
a fenced `webbrain-tools` JSON manifest.

**Importing a skill is the trust boundary for its declared HTTPS endpoint.**
Download-job skill tools still run in Act mode and use the normal Downloads
permission gate before saving files. Tool results derived from third-party
content should be marked `resultPolicy: "untrusted"` so they are wrapped as
data, not instructions.

Skill HTTP tools reject redirects (including opaque browser redirects), so
manifests must use a final HTTPS host that does not 3xx.

Skill tools are not part of the static [tool matrix](agent-tools.md#tool-matrix):
before a skill is loaded, or after it is removed, its tools are absent.

## Bundled skills

Packaged skill markdown lives under `skills/` and is registered in
`PACKAGED_SKILL_SOURCES` (`agent/skills.js`). Settings → Skills lists every
packaged skill; only the defaults below are seeded enabled.

### Enabled by default

All three can be removed from Settings → Skills. A removed default is not
silently restored, including by preactivation.

#### FreeSkillz.xyz

Can expose `read_youtube_transcript`, `fetch_nytimes_article`,
`resolve_public_media`, and `download_public_media` through its skill manifest.
On NYTimes / The Athletic tabs it is preactivated for the current run so a
structured blocking `pageGate` can route directly to the credentialless article
fallback.

#### OTP / verification-code helper

Loads only for relevant requests and declares no external network tool. On Mid
and Full it adds one narrow internal reader for an already open, signed-in
supported webmail tab. A provider-verified already-open message is read directly.
Candidate discovery otherwise leaves the mailbox untouched; candidate disclosure
requires the full normalized service identity or all sufficiently discriminative
service tokens. `inspect` remains read-only in Ask. Because opening can mark an
email read, `open_message` requires Act/Dev and normal click permission for the
mailbox host; the selected inbox item opens only in a temporary inactive duplicate
that is closed after every bounded message-scoped continuation is consumed.
Incomplete, changed, or unscoped continuations fail closed. The model receives opaque message
references, not a tab catalog, mailbox URLs, or accessibility references. Compact
keeps no skill or cross-tab tool surface. On the active run tab the skill still
prefers selected text or a bounded accessibility-tree subtree, excludes
SMS/native-app access, and honors Strict secret handling.

When used, the scoped page content and the code are included in the normal
request to your configured LLM provider. If **Record traces** is enabled, raw
tool results and model responses are also stored locally until those traces are
deleted.

#### Humanizer

Rewrites prose WebBrain composes for you, such as an email reply or a post, so
it reads as human writing. It declares no network tool and adds no tools.

On webmail tabs (Gmail, Outlook, Yahoo, Proton, Fastmail, Zoho, Yandex) it is
preactivated for the current run, so a reply is humanized without spending a
`load_skill` hop. Preactivation rides on the site-adapter match, so it does
nothing when **Site adapters** is turned off in Settings; the skill then loads
through the catalog like anywhere else. Elsewhere it loads through the normal
catalog when the request is about drafting or rewriting text. It returns only
the final text; it does not report what it changed unless you ask.

Select text anywhere and you get a **Humanize** entry, both in the popup and in
the right-click menu. That explicit entry preactivates the skill on any site;
later turns in the same selected-text conversation keep it. The canned readers
— Summarize, Explain, Quiz me, Proofread, Translate — and free-form questions
typed into the selection box do not, since they do not establish a structured
writing request. This routing exists because a selected-text run carries no
tools at all: the catalog is out of reach, so a skill that is not loaded when
the run starts cannot be loaded later.

It rewrites only prose being composed for a human reader. Quoted material,
addresses, codes, prices, form-field values, and wording you supplied verbatim
are left alone.

### Opt-in packaged skills

These ship in the extension and appear under Settings → Skills as available to
enable. They are not seeded on by default.

| Skill | Modes | Network tools |
|---|---|---|
| Disposable email (Mail.tm) | Act, Dev | Mail.tm HTTPS API |
| Temporary file share (Litterbox) | Act, Dev | Uses browser upload tools; short-lived public link |
| Open-Meteo weather | Ask, Act, Dev | Geocoding + forecast HTTPS |
| Open Library | Ask, Act, Dev | Open Library search HTTPS |
| Wikipedia | Ask, Act, Dev | Live Wikipedia APIs + explicitly installed Kiwix/ZIM archives |
| Turkish deasciifier | Ask, Act, Dev | Instruction-only; uses ordinary verbatim form-entry tools |
| Phone calls (Phonr) | Ask (instructed GET only), Act, Dev | Bearer-authenticated `fetch_url` to `https://phonr.xyz/v1`; POST requires the existing API-mutation permission |

Enable a skill only when you want its tools and instructions available for
`load_skill` on eligible runs.

The optional [Apocalypse Mode](apocalypse-mode.md) management page lets users
choose a Wikipedia language and Kiwix archive tier, review exact size and
license metadata, install resumably, import an existing `.zim`, and manage its
lifecycle. It is independent from the interface language, disabled by default,
and never downloads an archive merely because the Wikipedia skill is enabled.
Installed archive passages retain canonical attribution and remain untrusted.

### Phone calls (Phonr)

Enable **Phone calls (Phonr)** under Settings → Skills, then ask WebBrain to call
a person or business with a specific purpose and language. Supply your Phonr
bearer key for that service; the packaged skill contains no credential and cannot
read the server's `.env`. Act/Dev calls use `fetch_url` with the existing
`/allow-api` or persistent API-mutation authorization. Ask mode can read call
status and results through the skill's instructions; `fetch_url` does not enforce
that restriction. Previewing uses POST but never places a call. The service
address is `https://phonr.xyz/v1`; installing the skill does not deploy it.

The skill preserves an idempotency key across interrupted starts, follows the
same call through completion, handles uncertain provider status without
redialing, and distinguishes a call ending from its purpose being fulfilled.
Caller number, recording mode, and duration limit come from the Phonr server.
It uses the default natural-conversation system message unless the user requests
a change. Example: “Call this restaurant in Spanish and ask whether a table for
four is available tonight at 7. Get the options; don't book yet.”

This is an instruction-only API integration: its bearer header is part of
model-generated `fetch_url` arguments, so the key may appear in the configured
LLM conversation and enabled traces. Do not embed it in skill text, memory,
scheduled instructions, or links. The skill can inspect transcript, result, and
clip metadata; WebBrain's generic download tool cannot attach a bearer header,
so actual audio retrieval uses the local Phonr dashboard or the authenticated
curl example in the skill. It does not claim to play audio from metadata alone.

## See also

- [Opt-in external memory proposal](memcode-memory-proposal.md) — why hosted MemCode needs an extension-owned OAuth flow before it can be packaged as a skill
- [Agent tools](agent-tools.md) — tiers, modes, and the full tool matrix
- [Privacy and data flow](privacy-and-data-flow.md#bundled-skills)
- [Architecture](architecture.md) — skills and dynamic tool exposure in the turn
  flow
