# DIV Discord Server — Setup Guide

This is the single source of truth for configuring the DIV Discord server
(invite: https://discord.gg/cgC325ssfw). It exists so the server can be
(re)created from scratch quickly, and so channel, role, and copy changes are
reviewable like code. When the live server changes, update this file in the same
PR.

The community-facing reference (rules, escalation, Discord-vs-GitHub guidance) is
[`community.md`](community.md). Server structure and copy here should stay in
sync with it.

---

## 1. Server Basics

| Setting                    | Value                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Server name                | DIV                                                                                       |
| Server description         | Official community for the DIV AI browser agent — chat, help, adapters, and contributions |
| Invite                     | `https://discord.gg/cgC325ssfw`                                                                |
| Verification level         | Low (email verified)                                                                           |
| Explicit content filter    | Keep it enabled at the default                                                                 |
| Community / welcome screen | On, with the onboarding copy below                                                             |
| Rules screening            | On — new members must accept `#rules`                                                          |

Recommended settings under **Server Settings → Overview**:

- Enable **Community** features (enables welcome screen and rules screening).
- Set the **System Messages Channel** to `#announcements`.

---

## 2. Channel Structure

Create channels in this order, under four categories.

### Category: Info

| Channel          | Type             | Topic                                     |
| ---------------- | ---------------- | ----------------------------------------- |
| `#welcome`       | text (read-only) | Landing message with invite reminder      |
| `#rules`         | text (read-only) | Server rules, accepted by all new members |
| `#announcements` | text (read-only) | Releases, store updates, community news   |

### Category: Community

| Channel          | Type | Topic                                              |
| ---------------- | ---- | -------------------------------------------------- |
| `#general`       | text | Anything DIV: questions, ideas, conversation  |
| `#introductions` | text | Say hi, tell us what you use DIV for          |
| `#show-and-tell` | text | Traces, workflows, adapters, runs you are proud of |

### Category: Support

| Channel            | Type | Topic                                                       |
| ------------------ | ---- | ----------------------------------------------------------- |
| `#help`            | text | Getting started, side panel, modes, slash commands          |
| `#subscription`    | text | Subscription relted issues                                  |
| `#traces-and-bugs` | text | Trace debugging and triage before a GitHub issue            |

### Category: Development

| Channel          | Type             | Topic                                                     |
| ---------------- | ---------------- | --------------------------------------------------------- |
| `#contributing`  | text             | First issues, PR reviews, contributor onboarding          |
| `#site-adapters` | text             | The highest-leverage contribution — see `CONTRIBUTING.md` |
| `#roadmap`       | text             | Feature proposals and design discussion                   |
| `#github-feed`   | text (read-only) | GitHub bot stream of issues, PRs, releases                |

`#help` is a good candidate for Discord **Forums** (per-topic threads) once
traffic justifies it; start as a text channel to keep moderation simple.

---

## 3. Roles

Create roles in this order. Suggested colors keep roles readable in the member
list.

| Role          | Color          | Permission baseline                                                                  |
| ------------- | -------------- | ------------------------------------------------------------------------------------ |
| `Member`      | default (grey) | Default `@everyone` permissions                                                      |
| `Contributor` | green          | `Member` + can post in `#contributing` when it is otherwise gated                    |
| `Moderator`   | orange         | `Member` + Manage Messages, Move/Manage Threads, timeout members                     |
| `Maintainer`  | red            | `Moderator` + Manage Roles, Manage Channels, Mention Everyone (for `#announcements`) |

Notes:

- **`Contributor`** is a thank-you, not a repository right. Grant it to anyone
  with a merged PR, sustained support help, or useful issue triage. Granting is a
  maintainer decision.
- Keep `#announcements`, `#github-feed`, `#rules`, and `#welcome` **read-only**
  for `Member` (Send Messages denied) so announcements stay clean.
- `@everyone` should be able to read everything except nothing-sensitive. Do not
  create private channels; if a conversation is sensitive it belongs in DMs.

---

## 4. Rules Message (paste into `#rules`)

Use Discord's **Rules Screening** with the text below so new members must accept
it before posting. Reuse the same text as a pinned message in `#rules`.

```text
1. Be civil. Disagree with the code, not with the person.
2. No spam, self-promotion, or unsolicited DMs. The only exception is sharing
   your own DIV workflows in #show-and-tell.
3. Never post credentials, API keys, or traces containing personal data.
   Scrub traces before sharing.
4. Report security issues privately to a maintainer (see SECURITY.md).
   Never discuss active vulnerabilities in public channels.
5. Respect maintainer and moderator direction in this server.
6. The project Code of Conduct applies here in full:
   https://github.com/webbrain-one/webbrain/blob/main/CODE_OF_CONDUCT.md
```

---

## 5. Welcome Screen (paste into `#welcome`)

This is the pinned welcome message and the landing copy for the welcome screen.

```text
Welcome to the DIV community.

DIV is an open-source AI browser agent for Chrome and Firefox. It chats
with web pages, automates multi-step tasks, and runs on your choice of LLM —
local (llama.cpp, Ollama, LM Studio) or cloud (OpenAI, Anthropic, Google,
OpenRouter, and 100+ others).

Getting started
- Install: https://webbrain.one
- Repo: https://github.com/webbrain-one/webbrain
- Docs: https://webbrain.one/docs

Where to go
- #help — questions about using DIV
- #local-models / #providers — which models work, and how to set them up
- #site-adapters — write guidance for a site you use; it is our highest-value
  contribution (see CONTRIBUTING.md)
- #show-and-tell — share traces and workflows
- #general — anything else

Please read #rules before posting.
```

---

## 6. Onboarding Flow

1. Member joins via the invite and lands on the **welcome screen** (rules +
   welcome copy above).
2. Rules screening requires accepting `#rules`.
3. A maintainer greets them in `#introductions` when they post there.
4. First merged PR or sustained support help → `Contributor` role.
5. Occasional triage of the GitHub feed → `Contributor`.

Optional: a bot like _Carl-bot_ or _MEE6_ can auto-assign `Member` on join and
post the welcome message; the plain pinned message works equally well and avoids
an extra bot dependency.

---

## 7. GitHub Bot Feed (optional)

Post repository activity to `#github-feed` using a bot such as the official
**GitHub** Discord app, or a self-hosted webhook:

1. Repository: `webbrain-one/webbrain`
2. Events worth posting: issues, pull requests, releases.
3. Keep the channel read-only so the feed stays clean.
4. Point people from the feed back to the repo; Discord is for discussion, GitHub
   is where issues and PRs live.

The webhook secret must not be committed to the repository. Configure it in
Discord's integration settings only.

---

## 8. Moderation Playbook

- **Spam / abuse:** `Moderator` deletes the message, warns, then timeout as
  needed. The project prefers warnings over bans for first offenses.
- **Off-topic:** gently redirect to `#general` or `#off-topic`; move threads when
  Discord threads are in use.
- **Bug reports:** help the reporter produce a scrubbed trace and a GitHub issue
  in `#traces-and-bugs`; link `CONTRIBUTING.md`.
- **Security reports:** take to DMs with a maintainer immediately; never leave
  the details in a public channel.
- **Maintainer disputes:** follow `GOVERNANCE.md` — lazy consensus, then the Lead
  Maintainer's call.

Moderators act for the project per the Code of Conduct. They do not make product
or roadmap decisions; those follow `GOVERNANCE.md`.
