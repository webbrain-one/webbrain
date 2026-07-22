# Adding a Tool

This guide walks through adding a new tool to the WebBrain agent — from schema definition to execution dispatch to result handling.

---

## Overview

There are two ways to add a model-callable tool:

- **Core tool**: product-owned browser, DOM, network, download, scheduler, or
  privileged behavior implemented in WebBrain source. Use the full checklist
  below.
- **Skill tool**: user-importable, removable HTTP or download-job integration
  declared in a skill's `webbrain-tools` manifest. Use this when the tool is
  best treated as a trusted third-party extension rather than a WebBrain core
  primitive.

A core tool requires changes in three layers:

1. **Tool schema** — define the name, description, and parameters in `tools.js`
2. **Tool execution** — add a handler in `agent.js`'s `executeTool()` or in a content script
3. **UI labels** (optional) — add localized display names in `locales/*.js`

Most tools also need to be mirrored to both the Chrome and Firefox builds.

---

## Option 0: Expose a Tool from a Skill

If the integration is a trusted third-party HTTP service, prefer a skill tool
before hard-coding a core tool. Skill tools are removable from Settings -> Skills
and can be renamed or replaced by editing the manifest. Use `kind: "http"` for
read-only lookups and `kind: "httpDownloadJob"` for services that create a
temporary job, expose a file URL, and need browser Downloads.

Add a fenced `webbrain-tools` JSON block to the skill markdown:

````markdown
# Example Skill

Use this skill when...

```webbrain-skill
{
  "summary": "Read public metadata from Example when the user requests it.",
  "modes": ["ask", "act"]
}
```

```webbrain-tools
{
  "tools": [
    {
      "id": "example_lookup",
      "name": "example_lookup",
      "description": "Read public metadata from Example. Use this before downloading media.",
      "kind": "http",
      "readOnly": true,
      "method": "POST",
      "endpoint": "https://api.example.com/v1/lookup",
      "defaultArgs": {},
      "activeTabUrlArg": "url",
      "inputUrlArg": "url",
      "inputUrlAllowlist": [
        { "host": "example.com", "paths": ["/"] }
      ],
      "resultPolicy": "untrusted",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "Optional URL. Omit to use the active tab."
          }
        },
        "required": []
      }
    }
  ]
}
```
````

`webbrain-skill` is optional and is stripped from the loaded prompt. Its
single-line `summary` is capped at 200 characters and appears with the skill ID
and name in the Mid/Full `load_skill` catalog. `modes` controls catalog
eligibility; Ask must be listed explicitly, while Dev inherits Act eligibility.
Without metadata, WebBrain infers the first prose paragraph as the summary and
defaults the skill to Act/Dev. Compact exposes no skills. Full skill prose and
declared tools remain absent until `load_skill` activates the skill for the
current run.

### Write metadata for routing, not documentation

Ordinary selection is semantic: there is no keyword or URL matcher that chooses
a skill before the model sees the catalog. Write `summary` as one concrete
sentence describing the user intents the skill owns. Include the relevant
object or service and the action the user is asking for; omit implementation
detail, safety prose, endpoint URLs, and generic claims such as "helps with web
tasks." The full skill body remains the place for workflow and safety rules.

Good:

```json
{
  "summary": "Find, read, copy, or enter a one-time verification code from recent message content visible in the active browser tab.",
  "modes": ["ask", "act"]
}
```

Too vague:

```json
{
  "summary": "Helps with email.",
  "modes": ["ask", "act"]
}
```

Choose modes according to the workflow, not merely whether an individual HTTP
tool is read-only:

- Include `ask` only when the skill is genuinely useful without browser or
  external state changes.
- Include `act` for action workflows. Dev automatically inherits Act-eligible
  skills; add `dev` only for a Dev-specific skill that should not appear in Act.
- Remember that skill eligibility and tool eligibility are separate. Loading an
  Ask-compatible skill does not expose a tool whose manifest is Act-only.

Avoid overlapping summaries unless the skills are intentionally composable. If
two skills can both apply, make the distinction explicit—for example, an OTP
skill for a code in an already visible mailbox versus a disposable-email skill
that creates and manages a temporary mailbox. The model may load multiple
relevant skills in one run, and repeated loads are idempotent.

Trusted product-owned recommended actions are a separate path: when they name a
skill tool as `firstTool` or `tool`, the agent deterministically preactivates the
enabled, mode-compatible skill that owns it. Do not rely on this behavior for
ordinary free-form requests; those route through the catalog summary.

A download-job skill uses the same manifest fence, but declares the job
endpoints. The endpoint origin must stay the same across create, status, file,
and cleanup URLs:

````markdown
```webbrain-tools
{
  "tools": [
    {
      "id": "example_download_media",
      "name": "example_download_media",
      "description": "Download a public media file from Example into the browser Downloads folder.",
      "kind": "httpDownloadJob",
      "readOnly": false,
      "requiresDownloadPermission": true,
      "method": "POST",
      "endpoint": "https://api.example.com/v1/media/jobs",
      "job": {
        "idField": "job_id",
        "statusEndpoint": "https://api.example.com/v1/media/jobs/{job_id}",
        "fileEndpoint": "https://api.example.com/v1/media/jobs/{job_id}/file",
        "cleanupEndpoint": "https://api.example.com/v1/media/jobs/{job_id}",
        "pollIntervalMs": 1000,
        "timeoutMs": 90000
      },
      "activeTabUrlArg": "url",
      "inputUrlArg": "url",
      "resultPolicy": "untrusted",
      "modes": ["act"],
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string" },
          "filename": { "type": "string" }
        },
        "required": []
      }
    }
  ]
}
```
````

How it is wired:

- `agent/skills.js` parses manifests from enabled skills and builds tool schemas
  at LLM-call time.
- The manifest block is stripped from the prompt instructions, so endpoint JSON
  is not copied into the main system prompt.
- `agent.js` routes declared skill tool calls through
  `executeHttpSkillTool()` in `network-tools.js`.
- Skill tools currently require HTTPS and `credentials: "omit"`. `kind: "http"`
  tools must be GET or POST and `readOnly: true`. `kind: "httpDownloadJob"`
  tools must be POST, `readOnly: false`, `requiresDownloadPermission: true`,
  and declare same-origin status/file/cleanup endpoint templates with
  `{job_id}`.
- Privileged packaged integrations are not a third manifest kind. For example,
  the opt-in Chrome Web Store release skill receives its fixed
  `chromeWebStore` handlers only when `skills.js` recognizes the exact built-in
  skill ID and packaged path. A raw or URL-imported skill cannot declare those
  handlers; its `webbrain-tools` block remains limited to the HTTP kinds above.

Security model:

- Importing/enabling the skill is the trust boundary for the declared HTTPS
  endpoint. After import, declared skill tools can send their declared inputs to
  that endpoint without per-call confirmation.
- Download-job skill tools are still action-mode-only (Act or Dev) and run through the normal
  Downloads permission gate before a file is saved.
- Mark any third-party/page/document response as `resultPolicy: "untrusted"` so
  the result is wrapped in `<untrusted_page_content>` and cannot become trusted
  instructions during summarization.
- Use `inputUrlAllowlist` when the service should only receive specific public
  URL families.

Use a core tool instead when the tool needs browser privileges beyond Downloads,
cookies, content-script DOM access, mutation permissions, a custom permission
gate, or non-HTTP execution.

---

## Step 1: Define the Schema

Open `src/chrome/src/agent/tools.js` and add an entry to the `AGENT_TOOLS` array:

```js
{
  type: 'function',
  function: {
    name: 'my_new_tool',
    description: 'What this tool does, when to use it, and what the model should expect back. Be explicit about error cases.',
    parameters: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: 'What this parameter is for.',
        },
        param2: {
          type: 'number',
          description: 'Another parameter.',
        },
      },
      required: ['param1'],
    },
  },
},
```

### Schema rules

- **Description quality matters**: the LLM reads this to decide when to call the tool. Include: what it does, when to prefer it over alternatives, what errors to expect, and any side effects.
- **Parameters should be well-named**: the model infers semantics from parameter names + descriptions.
- **Use enums** for constrained choices:
  ```js
  param: { type: 'string', enum: ['option1', 'option2'] }
  ```
- **Required fields**: list only what's truly mandatory. Optional fields give the model flexibility.
- **Keep descriptions concise**: ~2–3 sentences max. The full tool list is sent on every LLM call.

### Tool classification

- **Ask tools** (semantic/read-only and safe for every model): add to `ASK_ONLY_TOOLS` in `tools.js`. Do not put developer/debugging reads here unless they truly belong in ordinary Ask.
- **Normal action tools**: add the schema to `AGENT_TOOLS`, then decide which provider tiers should see it through `COMPACT_TOOL_NAMES`, `MID_TOOL_NAMES`, or the Full Act default.
- **Dev-only tools**: add source/style/debug tools that should not appear in normal Act to `DEV_ONLY_TOOL_NAMES`.
- **Dev-extended tools**: add tools that should stay Full Act but also become available to Mid-tier Dev in `DEV_EXTENDED_TOOL_NAMES`. Shadow/frame tools use this pattern.
- **Navigation tools**: add to `Agent.NAV_TOOLS` (auto-screenshot on navigation)
- **State-change tools**: add to `Agent.STATE_CHANGE_TOOLS` (auto-screenshot on state change)
- **Navigation-prone tools**: add to `Agent.NAV_PRONE_TOOLS` when a successful call should be checked for URL/history changes (`navigate`, `go_back`, `go_forward`, click-like tools)
- **URL-family tools**: if the tool takes a URL argument that should be bucket-identity-hashed for loop detection, update `loop-bucket.js`'s `URL_FAMILY_TOOLS`

Keep mode and tier separate: mode is `ask | act | dev`; tier is `compact | mid | full`. `getToolsForMode('dev', { tier: 'mid' })` returns Mid Act tools plus Dev add-ons. `getToolsForMode('dev', { tier: 'compact' })` is intentionally empty because Compact Dev is blocked before an LLM request.

---

## Step 2: Implement the Handler

### Option A: Content-script tool (DOM interaction)

Add a handler in `src/chrome/src/content/content.js`:

```js
if (msg.action === 'my_new_tool') {
  const result = await myNewToolHandler(msg.args);
  sendResponse(result);
}
```

Then add the dispatch in `agent.js`'s `executeTool()`:

```js
if (name === 'my_new_tool') {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'my_new_tool',
      args,
    });
    return response || { success: false, error: 'No response from page' };
  } catch (e) {
    // Content script may not be injected yet — inject and retry
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js'],
    });
    const response = await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'my_new_tool',
      args,
    });
    return response || { success: false, error: 'No response after injection' };
  }
}
```

### Option B: Background/service-worker tool (network, chrome.* APIs)

Add the handler directly in `executeTool()`:

```js
if (name === 'my_new_tool') {
  try {
    const result = await doSomething(args);
    return { success: true, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```

### Option C: CDP-powered tool (Chrome only)

Use `cdpClient` for trusted events / DOM queries:

```js
if (name === 'my_new_tool') {
  try {
    await cdpClient.attach(tabId);
    const result = await cdpClient.evaluate(tabId, `/* JS to run in page */`);
    return { success: true, value: result?.result?.value };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```

---

## Step 3: Result Shape

Tool results must be JSON-serializable. Follow these conventions:

```js
// Success
{ success: true, data: ..., note: '...' }

// Error
{ success: false, error: 'Human-readable description of what went wrong' }
```

### Special result fields

These fields are stripped before stringification and handled specially by `_executeToolBatch`:

| Field | Type | Purpose |
|---|---|---|
| `_attachImage` | `string` (data URL) | Pushed as an `image_url` block on a follow-up user message for vision-capable providers |
| `_attachDocument` | `object` | Pushed as an Anthropic `document` content block for native PDF passthrough |
| `done` | `boolean` | Signals `_executeToolBatch` to stop the loop and return `summary` |
| `summary` | `string` | The final answer when `done: true` |

### Tool result size

`_limitToolResult()` caps serialized results at **8,000 characters**. If your tool returns large data (pages of text, long lists), the result will be silently truncated. Consider:
- Returning a summary with a `truncated: true` flag
- Supporting pagination (like `get_accessibility_tree` does with `page` parameter)
- Letting the model call back for more detail

---

## Step 4: Add UI Labels (Optional)

If the tool should have a human-readable label in the side panel, add it to `src/chrome/src/ui/locales/en.js`:

```js
'tool.my_new_tool': 'My New Tool',
'tool.my_new_tool.with_param': 'My New Tool with {param}',
```

And to every other locale file under `locales/*.js`.

---

## Step 5: Mirror to Firefox

Copy the changes to `src/firefox/src/agent/tools.js`, `src/firefox/src/agent/agent.js`, and `src/firefox/src/content/content.js`.

Some tools are intentionally Chrome-only (those needing CDP, offscreen documents, tab capture, or other Chrome-only APIs). For those, add the schema to both builds but implement the Firefox handler with a clear error or no-op:

```js
// Firefox: not supported
if (name === 'chrome_only_tool') {
  return { success: false, error: 'This tool is not available on Firefox.' };
}
```

---

## Step 6: Security Classification

Every new tool should be classified for security:

1. **Can it read or exfiltrate data from the page?** → Add credential-field sensitivity checks if it reads input values.
2. **Can it perform destructive mutations?** → Consider whether it should be gated behind `/allow-api`.
3. **Can it be prompt-injected?** → If the tool accepts user-provided strings that end up in tool-call arguments, document the injection surface in the tool description.
4. **Which mode/tier should expose it?** → Ask-only semantic read goes in `ASK_ONLY_TOOLS`; common action tools should join the smallest normal tier that can reliably use them; developer-only source/style/debug tools go in Dev-only; Full fallbacks that Mid should get only during debugging go in Dev-extended.
5. **Can it shortcut repeated UI actions to network calls?** → Keep the UI-first policy intact. The background API observer may surface exact XHR/fetch URL+method hints during click loops, plus an opaque `replayRequestId` when same-origin body/header replay material is available. Mutating `fetch_url` calls still need the conversation's `/allow-api` state, and hidden form tokens must stay behind the replay id rather than being exposed to the model. GET requests and non-network capabilities still use the normal permission gate.

See `docs/security-model.md` for the full threat model.

---

## Step 7: Test

1. Verify the tool appears in the LLM's available tools (check `getToolsForMode()` in verbose debug log)
2. Test the handler runs and returns the correct result shape
3. Test error handling (invalid args, missing page, network failure)
4. Test in Ask, Act, and Dev modes as applicable, including Compact/Mid/Full tier boundaries
5. Test on both Chrome and Firefox builds
6. Verify the result is properly displayed in the side panel

---

## Checklist

- [ ] Schema added to `AGENT_TOOLS` in `src/chrome/src/agent/tools.js`
- [ ] Schema mirrored to `src/firefox/src/agent/tools.js`
- [ ] Handler added to `executeTool()` in both `agent.js` files
- [ ] Content-script handler added (if applicable) in both `content.js` files
- [ ] Added to the correct Ask/Act/Dev exposure constants (`ASK_ONLY_TOOLS`, tier sets, `DEV_ONLY_TOOL_NAMES`, or `DEV_EXTENDED_TOOL_NAMES`)
- [ ] Compact, Mid, Full, and Dev Compact-block behavior covered when the tool surface changes
- [ ] Added to `Agent.NAV_TOOLS` / `Agent.STATE_CHANGE_TOOLS` / `Agent.NAV_PRONE_TOOLS` (if it navigates, changes page state, or should be checked for navigation)
- [ ] Security classification documented
- [ ] README / architecture docs updated when the public tool surface or execution flow changes
- [ ] UI labels added to `locales/*.js` (if needed)
- [ ] Tool description updated in corresponding system prompt (if the model should know about it proactively)
