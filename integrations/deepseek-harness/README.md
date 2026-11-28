# WebBrain local browser for DeepSeek Harness

The `@webbrain/dsh-local` bundle gives Harness six tools for the WebBrain extension in your signed-in browser. Harness starts the paired WebBrain MCP server as a child process. Run Harness, Node.js 24.9 or later, and the browser on the same computer. Choose a model in WebBrain for delegated tasks.

## Install in the desktop app

1. Open **Plugins** in the Harness sidebar, select **Installed**, then click **Add plugin**.
2. Paste `@webbrain/dsh-local@0.1.0` into **Package name or address** and click **Install**.
3. Click **Enable now** when installation finishes. If you already closed the dialog, turn the plugin on in **Installed**. Restart Harness if prompted.
4. [Pair your browser](#pair-the-browser), then ask Harness to call `mcp__webbrain__webbrain_connection`. A paired browser reports `Connected.`.

## Install with the CLI

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

1. Once the server starts, open `~/.webbrain/bridge-key` on macOS or Linux, or `%USERPROFILE%\.webbrain\bridge-key` on Windows. You can also print the same key in your own terminal with `npx -y @webbrain/mcp-server@0.1.2 pairing-key`. For a checkout installation, run `node mcp-server/dist/index.js pairing-key` from the repository root. Copy the value directly into the extension.
2. In **WebBrain → Settings → Bridge**, choose **DeepSeek Harness**. If your extension does not show that button yet, choose **MCP** or enter `ws://127.0.0.1:17374/extension` manually. Paste the value into **Pairing key** and click **Save & test connection**.
3. In Harness, ask it to call `mcp__webbrain__webbrain_connection`. A paired browser reports `Connected.`.

The extension uses one bridge destination at a time. To use LM Studio, select **LM Studio** in Bridge settings. The two destinations share the default pairing key. OpenCode, Claude Code, and Cursor use the same MCP port as Harness, so stop the current client's server before switching between those clients.

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

This setup uses a local extension and its configured model. For hosted browser sessions, see the [WebBrain Cloud plugin for Harness](https://webbrain.cloud/docs#deepseek-harness).

To remove the local bundle, run `dsh plugin --profile web remove @webbrain/dsh-local`.
