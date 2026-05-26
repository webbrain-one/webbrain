# WebBrain Project Governance

This document describes how the WebBrain project is governed, how decisions are made, and how anyone can become more involved over time.

WebBrain is an open-source project released under the MIT License. Our goal is to build a useful, trustworthy, open AI browser agent that anyone can run, inspect, fork, and extend. Governance exists to serve that goal — not the other way around.

## Roles

The project recognizes four roles. Each role is a description of responsibility, not a status symbol, and people commonly move between them over time.

**Users** are anyone who installs and uses WebBrain. Users help the project by filing issues, asking questions, sharing use cases, and giving feedback. No formal commitment is required.

**Contributors** are anyone who contributes to the project in any form — code, documentation, translations, bug reports with reproductions, design feedback, triage, or community support. Contributors do not need permission to contribute; opening a pull request or issue is enough.

**Maintainers** are contributors with merge rights on the repository. Maintainers review and merge pull requests, triage issues, shape the roadmap, and uphold the project's technical and community standards. Maintainers are listed in `OWNERS.md`.

**Lead Maintainer** is the maintainer responsible for overall project direction, release coordination, and final decision-making when the maintainers cannot reach consensus. The Lead Maintainer role is currently held by the project's original author and may rotate or be split as the maintainer group grows.

## Decision Making

WebBrain uses **lazy consensus** as its default decision-making process. This means a proposal moves forward unless someone with standing objects within a reasonable review window (typically 72 hours for ordinary changes, longer for substantial ones).

Most decisions never need a formal vote. A pull request that receives approval from at least one maintainer and no objections from other maintainers can be merged. Documentation fixes, bug fixes, and small improvements proceed under this default.

When a decision is contested or has wider implications, maintainers will discuss it in the relevant pull request, issue, or design discussion until consensus is reached. If consensus cannot be reached after good-faith discussion, the Lead Maintainer makes the final call and documents the reasoning.

Substantive changes — new LLM providers, new agent tools, security-sensitive behavior, breaking changes to the extension API, or anything that materially affects user trust — should be proposed in a GitHub issue or discussion before implementation, so the design can be reviewed openly.

## Becoming a Maintainer

There is no fixed quota of maintainers, and there is no application form. The path is:

Sustained, high-quality contribution over time. This includes code, but also things like helping with issue triage, reviewing other people's pull requests thoughtfully, improving documentation, or contributing translations. We look for people who have demonstrated good technical judgment and good community behavior, not just a high commit count.

An existing maintainer nominates the contributor by opening a pull request to update `OWNERS.md`. The nomination should briefly describe the contributor's involvement. Other maintainers respond within a reasonable window. Lazy consensus applies — if no maintainer objects, the nomination is accepted.

Maintainers are expected to act in the interest of the project and its users, not in the interest of any single employer or sponsor. WebBrain explicitly aims for maintainer diversity across organizations over time.

## Stepping Down and Inactivity

Maintainers may step down at any time by opening a pull request removing themselves from `OWNERS.md`. Maintainers who have been inactive for an extended period (typically 12 months with no reviews, merges, or substantive discussion) may be moved to an "Emeritus" section by consensus of the active maintainers. Emeritus maintainers retain credit and may return to active status by request.

## Removal

In rare cases, a maintainer may be removed for serious or sustained violation of the Code of Conduct, malicious action against the project, or sustained loss of trust from the rest of the maintainer group. Removal requires a supermajority (two-thirds) vote of the other active maintainers and is documented in the pull request that updates `OWNERS.md`.

## Security and Safety Decisions

WebBrain is a browser agent that can take real actions on a user's behalf. Decisions about default safety behavior — for example, the UI-first rule for API mutations, paywall handling, profile auto-fill defaults, or CAPTCHA solving — are treated as high-impact and require explicit maintainer review. The default posture is conservative: features that increase the agent's blast radius are off by default and clearly disclosed.

Security vulnerabilities should be reported privately following the process in `SECURITY.md` (if present) or by emailing the Lead Maintainer directly. Public issue reports for active vulnerabilities will be moved to private channels.

## Code of Conduct

All participation in the project — issues, pull requests, discussions, community channels — is governed by the project's Code of Conduct (`CODE_OF_CONDUCT.md`). The Code of Conduct applies equally to users, contributors, and maintainers. Maintainers are responsible for enforcing it fairly.

## Changes to This Document

Changes to this governance document follow the same lazy-consensus process as other substantive changes, with a longer review window (one week minimum) and explicit approval from a majority of active maintainers. The current version is whatever is on the `main` branch.
