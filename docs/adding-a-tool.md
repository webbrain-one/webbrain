# Adding a Tool

This guide walks through adding a new tool to the WebBrain agent — from schema definition to execution dispatch to result handling.

---

## Overview

Each tool requires changes in three layers:

1. **Tool schema** — define the name, description, and parameters in `tools.js`
2. **Tool execution** — add a handler in `agent.js`'s `executeTool()` or in a content script
3. **UI labels** (optional) — add localized display names in `locales/*.js`

Most tools also need to be mirrored to both the Chrome and Firefox builds.

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

- **Read-only tools** (safe in Ask mode): add to `ASK_ONLY_TOOLS` array in `tools.js`
- **Navigation tools**: add to `Agent.NAV_TOOLS` (auto-screenshot on navigation)
- **State-change tools**: add to `Agent.STATE_CHANGE_TOOLS` (auto-screenshot on state change)
- **URL-family tools**: if the tool takes a URL argument that should be bucket-identity-hashed for loop detection, update `loop-bucket.js`'s `URL_FAMILY_TOOLS`

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

Some tools are intentionally Chrome-only (those needing CDP, offscreen documents, or `chrome.downloads`). For those, add the schema to both builds but implement the Firefox handler with a clear error or no-op:

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
4. **Should it work in Ask mode?** → If yes, add to `ASK_ONLY_TOOLS`.

See `docs/security-model.md` for the full threat model.

---

## Step 7: Test

1. Verify the tool appears in the LLM's available tools (check `getToolsForMode()` in verbose debug log)
2. Test the handler runs and returns the correct result shape
3. Test error handling (invalid args, missing page, network failure)
4. Test in both Ask and Act modes (if applicable)
5. Test on both Chrome and Firefox builds
6. Verify the result is properly displayed in the side panel

---

## Checklist

- [ ] Schema added to `AGENT_TOOLS` in `src/chrome/src/agent/tools.js`
- [ ] Schema mirrored to `src/firefox/src/agent/tools.js`
- [ ] Handler added to `executeTool()` in both `agent.js` files
- [ ] Content-script handler added (if applicable) in both `content.js` files
- [ ] Added to `ASK_ONLY_TOOLS` (if read-only)
- [ ] Added to `Agent.NAV_TOOLS` / `Agent.STATE_CHANGE_TOOLS` (if triggers auto-screenshot)
- [ ] Security classification documented
- [ ] UI labels added to `locales/*.js` (if needed)
- [ ] Tool description updated in corresponding system prompt (if the model should know about it proactively)
