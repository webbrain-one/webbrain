# MCP Browser Bridge

WebBrain can expose the already-open browser/profile to MCP clients such as
OpenClaw, Hermes, Claude Desktop, or other local agent hosts.

This is intentionally not a Playwright/Chromium launcher. The MCP server talks
to the installed WebBrain extension over localhost, so agents operate inside
the user's real browser session: current tabs, cookies, logged-in accounts,
installed extensions, downloads, and remembered profile state are preserved.

## How It Works

```
MCP client (OpenClaw, Hermes, etc.)
  <-> stdio MCP server: scripts/mcp-server.mjs
  <-> ws://127.0.0.1:17362/webbrain
  <-> WebBrain extension in the real browser profile
  <-> current browser tabs
```

The browser side opens an outbound WebSocket to localhost. The local MCP server
accepts only extension origins (`chrome-extension://...` or
`moz-extension://...`) on the WebSocket endpoint.

## Start It

1. Load or reload the WebBrain extension in Chrome or Firefox.
2. Start the MCP server:

```bash
npm run mcp
```

3. Open or click WebBrain in the browser profile you want agents to use. The
   extension will connect to the bridge automatically.

The HTTP status endpoint is useful during setup:

```bash
curl http://127.0.0.1:17362/status
```

## MCP Client Config

Use the absolute path to this repository in your MCP client config:

```json
{
  "mcpServers": {
    "webbrain-browser": {
      "command": "node",
      "args": ["G:\\esoku\\Documents\\webbrain\\scripts\\mcp-server.mjs"]
    }
  }
}
```

Optional environment variables:

```json
{
  "env": {
    "WEBBRAIN_MCP_HOST": "127.0.0.1",
    "WEBBRAIN_MCP_PORT": "17362"
  }
}
```

If you change the port, set the matching value in extension storage:

```js
chrome.storage.local.set({ mcpBridgePort: 17362 })
```

Set `mcpBridgeEnabled:false` in extension storage to disable the browser-side
connection loop.

## Exposed MCP Tools

- `webbrain_status`: bridge and connected-browser status.
- `webbrain_list_tabs`: list real profile tabs.
- `webbrain_active_tab`: return the active tab.
- `webbrain_tool_catalog`: list WebBrain's browser tools.
- `webbrain_chat`: ask WebBrain to complete a task in ask or act mode.
- `webbrain_call_tool`: directly call a low-level WebBrain tool.
- `webbrain_continue`: continue a run that hit the step limit.
- `webbrain_abort`: stop a running task.
- `webbrain_clear_conversation`: clear per-tab WebBrain state.

Prefer `webbrain_chat` for normal automation because it keeps WebBrain's agent
loop, page-content defenses, and permission prompts. Use `webbrain_call_tool`
when an outside agent wants to orchestrate browser steps itself.

Direct low-level tool calls are read-only by default. Calls that can affect the
browser, downloads, local files, forms, navigation, or authenticated network
data require:

```json
{ "allowPrivilegedBrowserAction": true }
```

That flag is deliberately noisy because direct tool calls bypass the side-panel
permission prompt that the normal WebBrain agent loop uses.
