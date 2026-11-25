# WebBrain for Omarchy

A native Omarchy Quickshell panel and user-scoped setup helper for delegating
browser tasks through the WebBrain MCP server. Supports one selected Claude
Code, Codex, or OpenCode installation and a Chromium-based browser.

## Install

From a reviewed WebBrain checkout on Omarchy:

```bash
node integrations/omarchy/bin/webbrain-omarchy.mjs install --agent claude
```

Use `--agent codex` or `--agent opencode` to choose another agent. Add
`--dry-run` to preview setup. The helper builds the MCP server from this
checkout, installs the `webbrain.browser` plugin, and registers the
`webbrain-omarchy` MCP server without changing your default agent.

The widget is enabled automatically when the Omarchy shell is running. Use
`--no-enable` to skip activation. Setup stops if another enabled WebBrain MCP
registration exists; disable or remove that old registration before continuing.

Then install the browser extension and pair it:

```bash
webbrain-omarchy open extension
webbrain-omarchy pairing-key
```

Enter the key directly in **WebBrain → Settings → Bridge**, use
`ws://127.0.0.1:17374/extension`, leave the Cloud Bridge token empty, and enable
the bridge. Launch your selected agent and ask it to call
`webbrain_connection` to confirm the paired browser is connected.

The plugin reports setup readiness and opens the selected agent with your
task. The agent owns the MCP connection, results, and run controls. The plugin
does not monitor a browser run or start a second server.

Read the [complete installation and troubleshooting guide](../../docs/omarchy.md)
or the [website guide](https://webbrain.one/docs/omarchy/).

## Commands

```bash
webbrain-omarchy status --json
webbrain-omarchy launch --task "Summarize the page already open in my browser."
webbrain-omarchy open docs
webbrain-omarchy open cloud
webbrain-omarchy uninstall
```

Requirements: Omarchy Quattro (targeting the 4.5.0 plugin API), Node 20+, npm,
Git, a supported agent, and a current Chromium WebBrain extension. Setup does
not require `sudo`. Keep only one MCP client on the default bridge port.
If a bridge is already running, continue in its agent window instead of
launching another task window. Uninstall disables and removes the plugin when
the Omarchy shell is available; follow its printed cleanup instructions if not.

The WebBrain monorepo has no root plugin manifest, so install with the helper
above instead of passing the repository root to `omarchy plugin add`.
