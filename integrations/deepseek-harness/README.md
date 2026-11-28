# WebBrain local browser for DeepSeek Harness

The `@webbrain/dsh-local` bundle gives Harness six tools for the WebBrain extension in your signed-in browser. Harness starts the paired WebBrain MCP server as a child process. Run Harness, Node.js 24.9 or later, and the browser on the same computer. Choose a model in WebBrain for delegated tasks.

## Install from npm

When your registry offers both `@webbrain/dsh-local@0.1.0` and its paired server dependency `@webbrain/mcp-server@0.1.2`, install the bundle into the profile you use. These examples use the `web` profile.

```sh
dsh plugin --profile web add @webbrain/dsh-local@0.1.0
```

## Install from this checkout

If either package version is unavailable from your registry, start at the WebBrain repository root. Build the server, link it into the bundle, and install the bundle into your Harness profile.

```sh
npm --prefix mcp-server ci
cd integrations/deepseek-harness
npm install --no-save --package-lock=false ../../mcp-server
cd ../..
dsh plugin --profile web add ./integrations/deepseek-harness
```

Keep this checkout available while the plugin is installed. Restart the profile if it is already running. The bundle launches its own copy of the server on port 17374. Close any other MCP client using that port first.

## Pair the browser

1. For an npm installation, run `npx -y @webbrain/mcp-server@0.1.2 pairing-key` in your own terminal. For a checkout installation, run `node mcp-server/dist/index.js pairing-key` from the repository root. Copy the value directly into the extension.
2. In **WebBrain → Settings → Bridge**, set the URL to `ws://127.0.0.1:17374/extension`, paste the value into **Pairing key**, and enable the bridge. The Cloud Bridge token field can stay empty.
3. In Harness, ask it to call `mcp__webbrain__webbrain_connection`. A paired browser reports `Connected.`.

The extension uses one bridge destination at a time. To switch between this plugin and LM Studio, change the bridge URL in the extension. Each uses the same default local pairing key.

## Use the tools

Try “Use WebBrain in Ask mode to summarize the active tab.” For a longer task, ask Harness to start it with `wait: false` and poll its run ID. The six tools appear under the `mcp__webbrain__` prefix.

| Tool | Use |
| --- | --- |
| `webbrain_connection` | Check the paired extension. |
| `webbrain_run` | Delegate a task. Ask is read-only by default. Act supports browser interaction with WebBrain’s usual approvals. |
| `webbrain_extract` | Extract data using a caller-supplied JSON Schema in Ask mode. |
| `webbrain_status` | Check the progress or result of a run. |
| `webbrain_respond` | Relay the user’s answer when a run requests input. |
| `webbrain_abort` | Stop a running task. |

The setup uses a local extension and its configured model. WebBrain Cloud has its own Harness bundle and hosted browser sessions.

To remove the local bundle, run `dsh plugin --profile web remove @webbrain/dsh-local`.
