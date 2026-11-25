# WebBrain on Omarchy

Use WebBrain from Omarchy's desktop and your selected coding agent while keeping
the browser profile you already use. The integration installs a native
Quickshell panel and a local MCP server for Claude Code, Codex, or OpenCode.

The desktop panel launches a task in the selected agent. That agent owns the
MCP connection and delegates browser work to the WebBrain extension. The panel
reports installation readiness; it does not monitor a browser run or imply that
the extension is connected.

## Requirements

- Omarchy Quattro, targeting the plugin API in Omarchy **4.5.0**.
- A Chromium-based browser with the current
  [WebBrain extension](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb).
- **Node.js 20 or later**, npm, and Git.
- One installed coding agent: Claude Code, Codex, or OpenCode. Complete that
  agent's normal sign-in before launching a task.
- Network access for the MCP server's locked npm dependencies during setup.

The integration runs as your user. It does not need `sudo`, change your default
browser or agent, or install browser policy for other users. WebBrain's browser
extension and model provider are configured separately. Local Ollama and
llama.cpp providers are supported; see [providers and models](providers-and-models.md).

Firefox is not a supported target for this integration yet: its WebBrain bridge
exists, but the MCP path has not been verified on a real Firefox installation.

## Install

Clone the integration and MCP source from the same WebBrain checkout:

```bash
git clone --filter=blob:none --sparse --depth 1 https://github.com/esokullu/webbrain.git
cd webbrain
git sparse-checkout set integrations/omarchy mcp-server
node integrations/omarchy/bin/webbrain-omarchy.mjs install --agent claude
```

Replace `claude` with `codex` or `opencode` to select another supported agent.
Preview the operations first with `--dry-run`:

```bash
node integrations/omarchy/bin/webbrain-omarchy.mjs install --agent codex --dry-run
```

The installer discovers and enables the widget when the Omarchy shell is
running. Add `--no-enable` to skip automatic activation; this does not disable
an already-enabled copy during an update.
If setup reports that the shell was unavailable, enable it later from your
Omarchy desktop:

```bash
omarchy-shell shell rescanPlugins
omarchy plugin enable webbrain.browser
```

The installer builds the MCP server from this checkout. It does not download an
unversioned `@webbrain/mcp-server` package: pairing requires the newer server
implementation, and an npm mirror may still resolve the earlier unpaired
release. Use a reviewed WebBrain commit when you need a reproducible installation.

The installed files are self-contained, so the source checkout is only needed
when you want to update:

| Location | Contents |
| --- | --- |
| `~/.local/bin/webbrain-omarchy` | Command-line launcher |
| `~/.local/share/webbrain-omarchy/` | Helper, installed MCP server, and integration state |
| `~/.config/omarchy/plugins/webbrain.browser/` | Plugin manifest and QML files |
| Selected agent's configuration | MCP registration named `webbrain-omarchy` |

If setup detects another enabled WebBrain MCP registration, it stops without
changing that entry. Disable or remove the old registration in the selected
agent, then rerun setup. Both servers would otherwise try to own the same bridge
port. Unrelated MCP registrations are preserved.

This integration lives in a subdirectory of the WebBrain monorepo. Do not pass
the repository root to `omarchy plugin add`: it does not contain a plugin
manifest. Use the installer above.

## Install and pair the browser extension

1. Run `webbrain-omarchy open extension` and install WebBrain in the Chromium
   profile you want the agent to use. Complete the extension's normal onboarding.
2. In a private terminal, run:

   ```bash
   webbrain-omarchy pairing-key
   ```

3. Open **WebBrain → Settings → Bridge**. Set the URL to
   `ws://127.0.0.1:17374/extension`, paste the printed value into **Pairing key**,
   and enable the bridge. Leave the separate **Cloud Bridge token** empty for
   this MCP connection.
4. Launch the selected agent and ask it to call `webbrain_connection` on the
   `webbrain-omarchy` server. The connection is ready only when this tool reports
   that the paired extension is connected.

The pairing key is stored in `~/.webbrain/bridge-key`. Paste it directly into
the extension, not into an agent conversation. The desktop panel and
`status --json` never display it.

The coding agent starts the MCP server when it connects. A WebSocket error
before the agent starts is expected: there is no listener yet. Do not start a
second server manually alongside the agent's server.

## Launch a task

Open the **WebBrain** widget in Omarchy's bar, enter a browser task, and launch
it with the selected agent. Keep your browser open. The agent verifies the
connection before delegating work.

You can also launch from a terminal:

```bash
webbrain-omarchy launch --task "Summarize the page already open in my browser and include its URL."
```

By default this opens an Omarchy terminal for the selected agent. Add `--inline`
when you want to use the current terminal instead.

If a WebBrain bridge is already running, the launcher stops and directs you back
to the existing agent window. Continue the conversation there, or close that
agent before opening another one. The panel does not inject tasks into an
existing agent session.

The integration supplies a WebBrain-specific starting prompt to the agent. The
agent remains responsible for choosing and calling the MCP tools. Results,
clarification questions, and run controls appear in that agent and in WebBrain;
the desktop panel does not stream them.

WebBrain's task-level tools preserve its browser action and permission checks.
For read-only work, ask the agent to use `webbrain_extract` or Ask mode on the
already-open page. Use Act mode when a task needs navigation or interaction.
See the [MCP guide](../mcp-server/README.md#tools) for run status, clarification,
and abort behavior.

The panel also opens the extension's store page, this guide, and the Cloud
dashboard. For command-line diagnostics:

```bash
webbrain-omarchy status --json
```

Readiness means the integration and MCP installation are present. It is not a
live browser connection check; use `webbrain_connection` inside the agent for
that check.

## Optional Cloud browsers

```bash
webbrain-omarchy open cloud
```

This opens the WebBrain Cloud dashboard. A Cloud browser has its own profile
and website logins; it does not inherit the local browser's cookies. This
integration does not create, run, pause, or destroy Cloud sessions itself.

To let your agent operate Cloud browsers, install the separate
[WebBrain Cloud skill](https://webbrain.cloud/skills.md) and supply
`WEBBRAIN_API_KEY` through the agent's environment or secret manager. The
[Cloud API guide](https://www.webbrain.cloud/docs) covers session readiness,
saved workflows, live viewing, billing, and cleanup. Keep Cloud keys out of
plugin settings, tasks, and source control.

## Update or change agents

Close the agent sessions using WebBrain, update your source checkout, and rerun
the installer with the same selected agent:

```bash
git pull --ff-only
node integrations/omarchy/bin/webbrain-omarchy.mjs install --agent claude
```

This refreshes the integration and builds the MCP server from the updated
source. Keep the browser extension current too; an extension without the
**Pairing key** field cannot connect to the paired server.

To select a different agent, uninstall the integration first, then run the
installer with the new `--agent` value. This avoids leaving multiple managed
registrations competing for the same browser bridge.

## Uninstall

Close agent sessions using WebBrain, then run:

```bash
webbrain-omarchy uninstall
```

Uninstall removes this integration's files and its unchanged managed MCP
registration. User-modified or unrelated configuration is preserved. It keeps
the browser extension, website logins, model settings, and pairing key. Remove
the browser extension through the browser's extension settings if you also
want to stop using WebBrain there.

It also disables the widget and rescans plugins when the Omarchy shell is
available. If removal reports that shell cleanup could not be confirmed, run
these commands in your Omarchy desktop session:

```bash
omarchy plugin disable webbrain.browser
omarchy-shell shell rescanPlugins
```

Configuration backups are kept in a private directory under
`~/.local/share/webbrain-omarchy-backups-*` after removal. They may contain your
agent's other settings and credentials, so keep them private.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `webbrain-omarchy: command not found` | Ensure `~/.local/bin` is on your `PATH`; reopen the terminal after installation. |
| No WebBrain widget | Check `omarchy plugin list`; enable `webbrain.browser` if needed. The plugin requires Omarchy's Quickshell shell. |
| Panel says setup is missing | Run `webbrain-omarchy status --json`, then rerun the source installer for the selected agent. |
| Node or build error | Use Node 20+, npm, and a complete `mcp-server/` directory from the same checkout. Setup needs access to the locked dependencies. |
| Stored Node runtime missing | Uninstall, then rerun the source installer with your current Node runtime. The MCP registration uses the absolute Node path selected at installation. |
| Existing WebBrain registration | Disable or remove the old enabled WebBrain server in the selected agent, then rerun setup. The installer does not overwrite it. |
| Agent does not expose WebBrain tools | Restart its MCP connection and check that the active account/configuration contains the `webbrain-omarchy` registration. |
| WebSocket connection error | Start the selected agent, check port `17374` and the `/extension` path, and ensure the browser is open. |
| Pairing key mismatch | Run `webbrain-omarchy pairing-key` in a private terminal and replace the key in WebBrain's Bridge settings. |
| Bridge port already occupied | Continue in the already-open agent, or close it before launching another task. One process must own `17374`. |
| Browser connected elsewhere | WebBrain has one outbound bridge socket. Check whether its Bridge settings point at Cloud (`17373`), local MCP (`17374`), or LM Studio (`17375`). |
| Firefox does not connect | Use a Chromium-based browser for this integration. |

Omarchy can maintain more than one account/configuration for a coding agent.
Install for the account you intend to use. The helper records its configuration
location and reuses that context for status checks, launches, updates, and
removal, including when launched from the desktop panel. It stores configuration
paths and the selected Omarchy account name rather than account credentials.
Changing Omarchy's active account later does not switch this integration to it.
To change the integration's agent or account, uninstall and reinstall for the
new selection. Do not copy the pairing key into account prompts or configuration
notes.

## Current scope

- Native Omarchy panel and launcher for a single selected coding agent.
- Paired browser access through the existing WebBrain MCP server.
- Installation diagnostics and links to browser setup, docs, and Cloud.
- No shared multi-agent broker, live run monitor, automatic Cloud lifecycle,
  or native desktop-control API.

Several simultaneous agent processes and a standalone browser-execution panel
would need a shared broker with task ownership. Starting more copies of the
current stdio MCP server does not provide that capability.

For the underlying interfaces, see the [MCP server](../mcp-server/README.md),
[Omarchy plugin source](../integrations/omarchy/), and
[Omarchy shell plugin manual](https://omarchy.org/manual/shell-plugins/).
