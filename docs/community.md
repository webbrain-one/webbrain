# DIV Community

DIV runs a Discord server as the informal home for users, contributors, and
maintainers to discuss everything DIV: how to use it, which models and
providers work well, site adapters, feature ideas, show-and-tell, and
coordination between contributors.

- **Invite:** https://discord.gg/cgC325ssfw
- **Server setup and copy-paste content:** [`discord-setup.md`](discord-setup.md)
- **Rules:** the project [Code of Conduct](../CODE_OF_CONDUCT.md) applies in full.

Discord is a _support and discussion_ channel. Bug reports, feature requests,
and contributions still belong on
[GitHub](https://github.com/webbrain-one/webbrain) so they stay tracked and
searchable. If a Discord discussion turns into an actionable bug, feature, or
PR, move it to a GitHub issue so it does not get lost in chat.

## Channel Structure

| Channel            | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `#welcome`         | One-time welcome message with the rules and a "getting started" pointer |
| `#rules`           | Server rules (read-only)                                                |
| `#announcements`   | Releases and project news (read-only)                                   |
| `#general`         | Anything DIV: questions, ideas, conversation                       |
| `#introductions`   | Say hi, tell us what you use DIV for                               |
| `#show-and-tell`   | Traces, workflows, adapters, and runs you are proud of                  |
| `#help`            | Getting started, side panel, modes, slash commands                      |
| `#local-models`    | llama.cpp, Ollama, LM Studio, Jan, vLLM, and local provider setups      |
| `#providers`       | Cloud providers, API keys, context windows, model recommendations       |
| `#traces-and-bugs` | Trace debugging and triage. Take confirmed bugs to GitHub issues        |
| `#contributing`    | Getting started as a contributor, first issues, PR reviews              |
| `#site-adapters`   | The highest-leverage contribution — see `CONTRIBUTING.md`               |
| `#roadmap`         | Proposed features and design discussion, mirroring GitHub Discussions   |
| `#github-feed`     | GitHub bot stream of issues, PRs, and releases                          |
| `#off-topic`       | Non-DIV conversation, clearly marked safe space for casual chat    |

## Roles

| Role          | Grant                                                      | What it means                                               |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `Member`      | Default                                                    | Can read and post in most channels                          |
| `Contributor` | After a merged PR, issue triage, or sustained support help | Acknowledges contribution; can post in contributor channels |
| `Maintainer`  | Maintainers listed in `OWNERS.md`                          | Project authority, per `GOVERNANCE.md`                      |
| `Moderator`   | Appointed by maintainers                                   | Enforces the Code of Conduct, moves/cleans channels         |

`Contributor`, `Maintainer`, and `Moderator` are granted by maintainers, matching
the roles in [`GOVERNANCE.md`](../GOVERNANCE.md). Being a Discord `Contributor`
does not grant repository rights; merge rights are a separate, GitHub-only
decision.

## Rules

1. Be civil. Disagree with the code, not with the person.
2. No spam, self-promotion, or unsolicited DMs. The only exception is show-and-tell
   of your own DIV workflows in `#show-and-tell`.
3. Do not post credentials, API keys, or traces containing personal data. Traces
   should be scrubbed before sharing — see `CONTRIBUTING.md`.
4. Keep security-sensitive discussions in DMs with a maintainer, or file a
   private report via `SECURITY.md`. Do not discuss active vulnerabilities publicly.
5. Follow maintainer direction in this server. Escalation paths are below.
6. The project Code of Conduct applies everywhere, including here.

## Escalation

- **Channel or thread issues:** ping a `Moderator`.
- **Code of Conduct violations:** message a `Moderator` or `Maintainer`
  privately. Maintainers are responsible for enforcing the Code of Conduct
  fairly, per `GOVERNANCE.md`.
- **Security vulnerabilities:** report privately, never in a public channel.
  Follow `SECURITY.md`.
- **Moderator or maintainer disputes:** the Lead Maintainer makes the final
  call, per `GOVERNANCE.md`.

## Discord vs GitHub

| You want to...                | Where                                                             |
| ----------------------------- | ----------------------------------------------------------------- |
| Get quick help using DIV | Discord `#help`, `#local-models`, `#providers`                    |
| Report a bug with a trace     | GitHub issue (see `CONTRIBUTING.md`)                              |
| Ask for a feature             | GitHub Discussion, or Discord `#roadmap` for discussion first     |
| Contribute an adapter / PR    | GitHub, coordinated in Discord `#site-adapters` / `#contributing` |
| Chat about DIV casually  | Discord `#general`                                                |

## Setup and Maintenance

Maintainers (and anyone recreating the server) follow
[`discord-setup.md`](discord-setup.md) for the exact channel list, roles,
welcome-screen copy, and bot configuration. The setup doc is the single source
of truth for server configuration; keep it in sync when the server changes.
