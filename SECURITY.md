# Security Policy

## Reporting a Vulnerability

WebBrain operates with extensive browser permissions (`<all_urls>`, `debugger`, `downloads`, `nativeMessaging`) and drives authenticated sessions. If you discover a security vulnerability, please handle it responsibly.

**Do NOT file a public GitHub issue.** Instead, email the maintainer directly:

**security@webbrain.app**

You can also reach out via the project's [GitHub Security Advisories page](https://github.com/anomalyco/webbrain/security/advisories/new).

### What to include

- A clear description of the vulnerability
- Steps to reproduce (browser, OS, extension version)
- If possible, a minimal proof of concept
- Your preferred disclosure timeline

### Response timeline

- **24–48 hours**: acknowledgment of receipt
- **7–14 days**: initial assessment and fix plan
- **30–60 days**: patch release (depends on complexity)

We aim to ship fixes through the normal extension update channel (Chrome Web Store / Firefox Add-ons) rather than hotfix branches.

## Scope

We are interested in vulnerabilities affecting:

- **Privilege escalation**: the extension performing actions the user did not authorize
- **Credential leakage**: agent output or trace data exposing user credentials
- **Prompt injection**: crafted page content causing the agent to perform unintended actions (see `docs/security-model.md` for the existing defenses)
- **Provider key exposure**: LLM API keys or OAuth tokens readable by third parties
- **Cross-origin data access**: the extension reading data from sites the user is not actively on

## Out of scope

- Vulnerabilities requiring physical access to the user's machine
- Social engineering of the extension user
- Denial of service against the user's browser
- Issues in third-party LLM providers (report those to the provider directly)

## Security Model

For a detailed description of the extension's security architecture (permissions, credential handling, prompt-injection defenses, `/allow-api` flag, trace isolation), see `docs/security-model.md`.
