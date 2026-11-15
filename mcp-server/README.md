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

> **Chromium first.** Chrome, Edge, Brave, Opera, Vivaldi run the bridge from the extension's **offscreen document** (`src/chrome/src/offscreen/cloud-bridge.js`). Firefox has no offscreen document, so `src/firefox/src/cloud-bridge.js` runs it in the background page, configured under the same **Settings → Bridge** tab; it has not yet been verified against this MCP server on a real Firefox install.
>
> This server does not use the optional browser-approval handshake (token, `connection_pending` / `connection_approved`); leave the Cloud Bridge token empty. It authenticates the extension with a **pairing key** instead (below). See [Cloud Bridge browser approval](../docs/cloud-bridge-browser-approval.md) for backends that want approval.

The MCP server hosts the listener; the extension dials out to it. A Manifest V3 extension cannot listen on a socket, so the direction is fixed.

1. Install the [WebBrain extension](https://webbrain.one) and open your browser.
2. Print the pairing key (requires `@webbrain/mcp-server` **0.1.2+**):

   ```bash
   npx -y @webbrain/mcp-server pairing-key
   ```

   The first run creates it in `~/.webbrain/bridge-key` (`%USERPROFILE%\.webbrain\bridge-key` on Windows), readable only by you. You can also open that file and copy its contents.

   > **If `pairing-key` starts the server instead of printing a key:** your environment resolved `@webbrain/mcp-server@0.1.0` (which predates `pairing-key` and the HMAC pairing handshake). Until the `0.1.2+` package is live on your npm mirror, build and run from a source checkout instead:
   >
   > ```bash
   > cd mcp-server && npm install && npm run build
   > node dist/index.js pairing-key
   > ```
   >
   > and register `node /absolute/path/to/webbrain/mcp-server/dist/index.js` as the MCP command in your client.
3. In **WebBrain → Settings → Bridge**, set the URL to `ws://127.0.0.1:17374/extension`, paste the key into **Pairing key**, and enable the bridge.
4. Ask your MCP client to call `webbrain_connection` to confirm.

The LM Studio plugin reads the same key file, so one pairing covers both destinations.

### Pairing

Anything on your machine can open a socket to `127.0.0.1:17374` and claim to be WebBrain, so the server does not trust a socket until it proves it holds the pairing key:

1. On connect the server sends `{type: "pairing_challenge", scheme: "hmac-sha256-v1", nonce}` with a fresh random nonce.
2. The extension answers `{type: "pairing_proof", scheme, proof}`, where `proof` is the hex HMAC-SHA256 of `"webbrain-bridge-pairing-v1:" + nonce` keyed with the pairing key. The key itself never crosses the socket, and a recorded proof is useless on the next socket.
3. Only after a valid `hello` **and** a valid proof does the socket become the extension. Until then it receives no commands and the already-connected extension keeps working. A wrong proof closes the socket with code `4001`; a socket that does not pair within 10 seconds is closed the same way.

The extension stops reconnecting after a `4001` and shows the reason under **Settings → Bridge**. Saving a new key reconnects it.

### Upgrading from an unpaired version

Earlier versions of this server accepted any socket that sent the right `hello`. After upgrading:

1. Update the WebBrain extension first. A version without the **Pairing key** field cannot pair, and this server closes its socket after 10 seconds with "Pairing required". The updated extension still works with older servers: without a challenge it never sends a proof.
2. Run `npx -y @webbrain/mcp-server pairing-key`, paste the key under **Settings → Bridge → Pairing key**, and press **Save & test connection**.

Deleting `~/.webbrain/bridge-key` and restarting the server rotates the key; paste the new one into WebBrain.

> **One bridge at a time.** The extension holds exactly one outbound bridge socket. Pointing it here means it is *not* pointed at WebBrain Cloud (`17373`) or the LM Studio plugin (`17375`). Switch it under **Settings → Bridge**.

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
Settings → Bridge** with the pairing key from `npx -y @webbrain/mcp-server pairing-key`
(or `node dist/index.js pairing-key` in a checkout). Ask the MCP client to call
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

**Rejected by the backend: Pairing key mismatch** means the key under
**Settings → Bridge → Pairing key** is not the one this server uses. Print it
again with `npx -y @webbrain/mcp-server pairing-key`. If the server runs with
`WEBBRAIN_BRIDGE_KEY` or `WEBBRAIN_BRIDGE_KEY_FILE`, use that key instead.
**This bridge requires a pairing key** means the field is empty.

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
| `WEBBRAIN_BRIDGE_KEY` | — | Pairing key to use instead of the key file (at least 16 characters). |
| `WEBBRAIN_BRIDGE_KEY_FILE` | `~/.webbrain/bridge-key` | Key file to read, or create on first start. |

### Embedding the server in another app

A host process that launches `dist/index.js` itself (for example over stdio, as
webbrain.me does) configures pairing through the same environment:

- Pass nothing to use the shared `~/.webbrain/bridge-key`, and show the user the
  output of `node <path-to>/dist/index.js pairing-key` (or the file's contents)
  to paste into WebBrain.
- Or generate a key, keep it in the host's own user-only storage, and pass it as
  `WEBBRAIN_BRIDGE_KEY` in the child's environment. `WEBBRAIN_BRIDGE_KEY_FILE`
  points the server at a different file instead.

`webbrain_connection` answers `Connected.` only for a paired extension. Its
"Not connected" text names the key's source (a file path or variable name),
never the key.

## Security notes

- The listener binds `127.0.0.1` only. Anything that can reach this port can drive your signed-in browser — never expose it to a network or a container bridge.
- Connections from HTTP(S) pages and other non-extension browser origins are rejected outright. Every other socket must send the extension's `hello` frame and answer the pairing challenge (see [Pairing](#pairing)) before it receives a command; until then it cannot replace the connected extension. A local process without the key can still occupy the port before the server starts, or connect and be refused, but it cannot read tasks or answer them.
- The pairing key is as sensitive as the browser session it unlocks. It lives in a user-only file; do not paste it into an MCP client chat. See [`docs/security-model.md`](../docs/security-model.md).
- A `webbrain_run` timeout does **not** abort the run. A task that already submitted a form should not be silently killed — the browser keeps going and `webbrain_status` picks it back up.
- `allow_api_mutations` lifts WebBrain's UI-first rule and is off by default. It is accepted only with `mode: "act"`; Ask runs remain read-only. The UI path is visible and stoppable; direct API mutations are neither.

## Tests

```bash
npm run build && node --test test/bridge.test.mjs
```

The suite stands up the real listener and connects a fake extension speaking the exact frames `src/chrome/src/offscreen/cloud-bridge.js` emits — handshake, pairing, id correlation under concurrency, error propagation, disconnect mid-command, and the poll/timeout/clarify paths. `test/pairing.test.mjs` also runs the extension's real Chrome and Firefox bridge code against the server. If the extension's wire format changes, these fail. That is intentional.

For manual poking, [`scripts/fake-extension.mjs`](scripts/fake-extension.mjs) is
the same fake as a standalone process. It pairs with the server's key — run the server, then:

```bash
node scripts/fake-extension.mjs
```

It logs every frame in both directions, so you can watch what your MCP client
actually sends without Chrome in the loop.

## License

This independently published package remains MIT-licensed. See [`LICENSE`](LICENSE).
