# Proposal: opt-in external memory for WebBrain

This is an architecture proposal, not an installable skill or an enabled integration. WebBrain already has local user memory in browser storage; that remains the default and source of truth. The proposed MemCode connection would be a separate opt-in capability for people who want cross-device recall.

## Why a skill manifest alone is not enough

`webbrain-tools` HTTP tools are read-only HTTPS requests. MemCode's hosted MCP resource (`https://mcp.memcode.in/i/webbrain/mcp`) requires OAuth with dynamic client registration, PKCE, token refresh and a resource-bound bearer token. WebBrain's current skill importer does not perform that flow or securely hold per-skill OAuth tokens. Putting an API key in a Markdown skill, URL, or model-generated `fetch_url` arguments would disclose it to the configured LLM and possibly traces. The public `/i/webbrain/mcp` alias is attribution, not authentication.

## Proposed minimum boundary

1. **Explicit connection.** A Settings → Memory choice defaults to **local only**. Connecting external memory opens an extension-owned OAuth flow. Credentials stay in extension storage, never in skill text, prompts or page content. Disconnect revokes or discards local credentials and stops future traffic; remote deletion is a separate user action.
2. **Separate consent for reads and writes.** A user can enable cross-device recall without enabling upload. A durable write shows the exact short text, destination/account and scope for approval. Auto-learn, form capture, page text and raw transcripts do not silently become remote writes.
3. **Scope is local policy plus server authorization.** Only active, user-selected records are considered. Scope is explicitly chosen (for example personal vs. a named project); a page, skill or model cannot invent a user ID or integration identity. The server derives the account from OAuth and enforces access to any project scope.
4. **Treat recall as untrusted data.** Returned memory takes the same nonce-delimited untrusted-content path used for page-derived tool output, not a trusted system-prompt insertion. The existing local user-memory block cannot be copied wholesale to that remote path. No recalled text can authorize browser actions or override the user's current request.
5. **Fail closed, stay useful.** Disabled, expired, denied, offline or failing remote connections make no remote call and leave local memory and the agent usable. Token errors show a reconnect affordance without exposing credentials or recalled text in logs.

## Suggested implementation slices

- Extension-owned OAuth/PKCE client for the MemCode MCP resource, with account display, refresh and disconnect. Do not add a bundled skill until this exists.
- A read-only recall tool gated by the user's memory-read choice and marked untrusted in both Chrome and Firefox builds; add permission and prompt-injection tests in each build.
- A distinct write tool with exact-text approval and idempotent retry. It must not be reachable through Ask or Compact mode, nor through an instruction in retrieved content.
- One end-to-end signed-in test and an attribution check showing `webbrain` assigned by the server, never from a caller-provided header.

This proposal deliberately does not replace WebBrain's local preference memory or change its default privacy posture. Maintainers can choose the smaller first slice or decline remote write support entirely.
