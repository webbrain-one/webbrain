# WebBrain MCP Server

Give any MCP client — Claude Code, Codex, Cursor, OpenClaw — the ability to run tasks in **your real browser session**: already signed in, cookies present, MFA already passed.

That session is the whole point. A headless automation framework starts logged out of everything and hits a login wall on the first useful page. WebBrain is already inside the browser you use.

```
Claude Code ──stdio──▶ webbrain-mcp ──ws://127.0.0.1:17374──▶ WebBrain extension ──▶ your tabs
```

## Install

```bash
npm install -g @webbrain/mcp-server
```

Or run from a checkout:

```bash
cd mcp-server && npm install && npm run build
```

## Connect the browser

> **Chromium only.** Chrome, Edge, Brave, Opera, Vivaldi. The bridge runs from the extension's **offscreen document**, and the Firefox build has none — `cloud-bridge.js` and `cloud-runs.js` live only under `src/chrome/`. See [`src/firefox/ARCHITECTURE.md`](../src/firefox/ARCHITECTURE.md).

The MCP server hosts the listener; the extension dials out to it. A Manifest V3 extension cannot listen on a socket, so the direction is fixed.

1. Install the [WebBrain extension](https://webbrain.one) and open your browser.
2. In **WebBrain → Settings → General → Advanced → MCP**, set the URL to `ws://127.0.0.1:17374/extension` and enable it.
3. Ask your MCP client to call `webbrain_connection` to confirm.

> **One bridge at a time.** The extension holds exactly one outbound bridge socket. Pointing it here means it is *not* pointed at WebBrain Cloud (`17373`) or the LM Studio plugin (`17375`). Switch it under **Settings → General → Advanced → MCP**.

## Register with a client

**Claude Code**

```bash
claude mcp add --transport stdio webbrain -- npx -y @webbrain/mcp-server
```

**Codex / Cursor / anything reading `mcp.json`**

```json
{
  "mcpServers": {
    "webbrain": {
      "command": "npx",
      "args": ["-y", "@webbrain/mcp-server"]
    }
  }
}
```

The MCP client launches this command as a child process when it starts the
configured server; you do not need to keep a second copy running in a terminal.
After adding the configuration, restart or reconnect the MCP client if WebBrain
does not appear in its tool list.

## Launch manually

For a direct launch or connection test, run:

```bash
npx -y @webbrain/mcp-server
```

Leave that terminal open while using the bridge. The server owns the local
listener on `127.0.0.1:17374`, and exiting it closes the bridge. Press `Ctrl+C`
to stop it.

From a source checkout, build and launch the same server with:

```bash
cd mcp-server
npm install
npm run build
npm start
```

After it is running, enable `ws://127.0.0.1:17374/extension` under **WebBrain →
Settings → General → Advanced → MCP**. Ask the MCP client to call
`webbrain_connection` to verify the complete connection.

## Troubleshooting

**Connection error: WebSocket error** normally means that no process is
listening at the URL selected in WebBrain. Confirm the MCP server is still
running and that Settings uses port `17374`, then check the listener:

```bash
lsof -nP -iTCP:17374 -sTCP:LISTEN
```

No output means the MCP server is not listening. If it is listening but the
extension does not connect, make sure another bridge destination is not selected:
WebBrain Cloud uses `17373`, this MCP server uses `17374`, and the LM Studio
plugin uses `17375`. Only one can be selected at a time. The bridge is available
in Chromium browsers only, not Firefox.

## Tools

| Tool | Purpose |
|---|---|
| `webbrain_run` | Delegate a task. `mode='ask'` is read-only; `mode='act'` can click and type, gated by in-browser approval. |
| `webbrain_extract` | Read authenticated page data into a caller-supplied JSON Schema. Always runs in read-only Ask mode. |
| `webbrain_status` | Poll a run, or list every run. |
| `webbrain_respond` | Answer a run sitting at `needs_user_input`. |
| `webbrain_abort` | Stop a run. Actions already taken are not undone. |
| `webbrain_connection` | Report whether the extension is attached, and how to fix it if not. |

When a run pauses for an ordinary clarification, relay the question and pass the
user's answer verbatim to `webbrain_respond`. Permission prompts are structured:
after the user explicitly decides, send the exact stable value `once`, `always`,
or `deny`. A normal approval maps to `once`; use `always` only when the user
explicitly requests a persistent grant. Localized labels such as "allow" must
not be forwarded as the permission value because the extension deliberately
fails closed on unknown decisions.

Form-submission confirmations and saved-workflow repair prompts are structured
the same way, and fail closed the same way. Each lists the values it accepts on
a `decisions:` line in the status text — send one of those exactly.

### Example

> "Open my Stripe dashboard and list last week's failed payments."

```
webbrain_run(task: "open the Stripe dashboard and list last week's failed
             payments with amounts and customer emails", mode: "ask")
```

Read-only, in the tab you are already authenticated in. No API key, no headless login dance.

For predictable JSON instead of prose, give `webbrain_extract` an explicit
JSON Schema:

```
webbrain_extract(
  task: "list the overdue invoices visible in this account",
  output_schema: {
    type: "object",
    properties: {
      invoices: {
        type: "array",
        items: {
          type: "object",
          properties: {
            customer: { type: "string" },
            amount: { type: "number" },
            due_date: { type: "string" }
          },
          required: ["customer", "amount", "due_date"]
        }
      }
    },
    required: ["invoices"]
  }
)
```

This is still a task-level delegation through the browser agent and its normal
permission boundary; it is not a direct page-scraping primitive.

## Why six task-level tools and not 50 browser primitives

WebBrain exposes roughly fifty primitives internally — `click_ax`, `type_ax`, `extract_data`, `iframe_read` and so on. This server deliberately does **not** surface them.

**Safety.** WebBrain's capability × origin permission gate runs in the agent loop (`_executeToolBatch`), not inside `executeTool()`. An MCP layer calling primitives directly would sit *below* the gate and bypass every approval prompt the product is built on. Delegating a goal keeps the trust boundary in the browser, where the human is.

**Cost.** Driving a UI one primitive at a time over a socket costs a round trip and a slab of tokens per click. Handing over a goal costs one call.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEBBRAIN_BRIDGE_PORT` | `17374` | Port the extension connects to. |
| `WEBBRAIN_BRIDGE_PATH` | `/extension` | Path segment; must match the URL in Settings. |
| `WEBBRAIN_COMMAND_TIMEOUT_MS` | `30000` | Per-command reply timeout. |
| `WEBBRAIN_RUN_TIMEOUT_MS` | `300000` | Default ceiling for `webbrain_run` polling. |
| `WEBBRAIN_POLL_INTERVAL_MS` | `1000` | Status poll interval. |

## Security notes

- The listener binds `127.0.0.1` only. Anything that can reach this port can drive your signed-in browser — never expose it to a network or a container bridge.
- Connections from HTTP(S) pages and other non-extension browser origins are rejected before they can replace the extension socket. Accepted connections must also present the extension's `hello` frame with `client: "webbrain-extension"`; anything else is closed. This is **not** authentication. The shipping extension sends no shared secret, so a local process could impersonate it. Treat the port as trusted-local, and see [`docs/security-model.md`](../docs/security-model.md).
- A `webbrain_run` timeout does **not** abort the run. A task that already submitted a form should not be silently killed — the browser keeps going and `webbrain_status` picks it back up.
- `allow_api_mutations` lifts WebBrain's UI-first rule and is off by default. It is accepted only with `mode: "act"`; Ask runs remain read-only. The UI path is visible and stoppable; direct API mutations are neither.

## Tests

```bash
npm run build && node --test test/bridge.test.mjs
```

The suite stands up the real listener and connects a fake extension speaking the exact frames `src/chrome/src/offscreen/cloud-bridge.js` emits — handshake, id correlation under concurrency, error propagation, disconnect mid-command, and the poll/timeout/clarify paths. If the extension's wire format changes, these fail. That is intentional.

For manual poking, [`scripts/fake-extension.mjs`](scripts/fake-extension.mjs) is
the same fake as a standalone process — run the server, then:

```bash
node scripts/fake-extension.mjs
```

It logs every frame in both directions, so you can watch what your MCP client
actually sends without Chrome in the loop.

## License

This independently published package remains MIT-licensed. See [`LICENSE`](LICENSE).
