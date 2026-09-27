# Optional MemCode recall

WebBrain's built-in user memory is local and remains the default. MemCode is an
optional cross-device **read-only** lookup, not a replacement for local memory.

1. Open **Settings → Profile → MemCode cross-device recall** and select **Connect
   MemCode**. WebBrain registers a public OAuth client and opens MemCode's sign-in
   and consent page using the browser's extension-owned redirect and PKCE.
2. After connecting, switch on **Enable MemCode recall**. Connection alone does
   not allow searches. The agent can then call `recall_memcode` with a short query.
3. Switch recall off or **Disconnect** at any time. Disconnect discards local
   credentials, attempts server-side OAuth revocation, and stops future lookups;
   it does not delete memories in MemCode. If revocation cannot be confirmed,
   Settings warns you to revoke the client in your MemCode account.

The query goes directly to the read-only personal search route at
`https://memory.memcode.in/v2/memory/search`, using an OAuth token bound to the
`https://memory.memcode.in` resource. WebBrain supplies its public
`software_id` during dynamic client registration so MemCode can assign
server-side integration attribution when `webbrain` is registered. This is not
proof of client identity by itself; verified attribution requires a separately
registered exact extension redirect. No caller-supplied integration header,
user ID, or API key is used.

Results are bounded and wrapped as untrusted tool output before the model sees
them. Recalled text is data, not a user command or permission to act on a
webpage. WebBrain's existing network permission gate also asks for
permission to contact the fixed MemCode host. Token expiry and network failures
leave local memory usable.

WebBrain requests only the `memory:read` OAuth scope. It never calls a write tool, never
uploads auto-learned preferences, form fields, pages, or transcripts, and never
injects remote recall into the trusted local-memory system prompt. A future
remote-write feature would require a separate exact-text approval UI and tests.

OAuth access and refresh tokens are stored in extension-local storage, like
WebBrain's other provider credentials. They are not included in portable settings
exports or sent to the configured LLM. Search queries and returned memories do
reach MemCode and, when used as tool context, the configured LLM provider.

MemCode's hosted MCP server currently requires both `memory:read` and
`memory:write` for every connection. This first slice uses the direct API
instead so its token truly lacks write permission. For deployment, the
`webbrain` software ID should be registered in MemCode's integration registry.
This PR contains mock-backed protocol tests; a signed-in Chrome and Firefox
smoke test and private dashboard attribution check are release validation steps.
