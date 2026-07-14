# Accessibility Tree & ref_id System

The accessibility-tree (AX) subsystem is the primary page-interaction path for the agent. It replaces the older index-based `get_interactive_elements` for almost all flows.

---

## Architecture

Two content scripts loaded in order:

1. **`accessibility-tree.js`** — the tree builder and `ref_id` registry
2. **`content.js`** — the tool handlers that use the tree

Both are injected into `<all_urls>` pages at `document_idle`.

---

## The Tree (`accessibility-tree.js`)

Builds the tree with an internal `generateAccessibilityTree(...)` (invoked by
the agent via `executeScript`) and installs a ref-resolution API on `window`
(`__wbElementMap`, `__wb_ax_lookup`, `__wb_ax_release`):

### `generateAccessibilityTree(filter, maxDepth, maxChars, ref_id, page)`

Walks the DOM and emits a flat, indented text tree:

```
dialog "Add a product" [ref_166]
 heading "Add a product" [ref_167]
 button "Close" [ref_169]
 textbox "Name" [ref_170] type="text" placeholder="Product name" value="namaz"
 combobox "Billing period" [ref_180] type="button"
```

**Parameters:**
| Parameter | Default | Description |
|---|---|---|
| `filter` | `'all'` | `'all'` (whole DOM), `'visible'` (in-viewport, visible nodes), `'interactive'` (clickable/typeable only) |
| `maxDepth` | `15` | Max tree depth to descend |
| `maxChars` | — | Hard cap on output length (auto-slices with `autoDegraded:true` if exceeded) |
| `ref_id` | — | Anchor at a specific element's subtree instead of `document.body` |
| `page` | — | 1-based chunk number for paginated results when tree is truncated |

**Output format:**
```
role "accessible name" [ref_id] href="..." type="..." placeholder="..." value="..."
```

Indentation is 1 space per tree-depth level (skipped generic containers don't bump depth).

### `__wb_ax_lookup(ref_id)`

Resolves a `ref_N` string back to the live DOM `Element`. Returns `null` if the element was removed from the DOM.

### `__wb_ax_suggest(ref_id, n)`

When a lookup misses, returns up to `n` nearby still-valid `ref_ids` so the error message can guide the model back on track.

---

## ref_id Registry (`window.__wbElementMap`)

### How it works

- A plain object (`Object.create(null)`) keyed by `ref_N` strings
- Each value is a `WeakRef` to the DOM element
- A monotonic counter (`window.__wbRefCounter`) assigns the next `ref_N`
- The map is **partially cleared** at the start of every tree build: entries whose `deref()` returns `null` are swept. Live entries survive across calls.

### Stability properties

- **Within a turn**: a `ref_id` fetched from `get_accessibility_tree` is guaranteed to resolve in the same turn.
- **Across turns**: a `ref_id` resolves as long as the element survives in the DOM. Elements removed by navigation or DOM manipulation become unresolvable (the tool returns a clear "not found" error and suggests re-reading the tree).
- **After SPA navigation**: the map survives, but most elements from the old route are gone → their refs will miss. The agent is expected to re-call `get_accessibility_tree` after navigation.

### Why WeakRefs

Without `WeakRef`, the map would pin every element it ever indexed, preventing garbage collection and leaking memory on long-lived pages (SPAs, chat apps). With `WeakRef`, the browser can GC removed elements naturally. The cost is that `deref()` can return `null` even for elements that exist if the GC ran — but in practice this is rare within a single agent turn (sub-second) and the agent re-reads the tree on navigation anyway.

---

## AX Tools

### `get_accessibility_tree`

The primary page-reading tool. Returns the rendered tree string plus metadata (`truncated`, `hasMore`, `autoDegraded`, `notice`).

The agent uses this as its first action on almost every turn — it's faster and cheaper than a screenshot, and works on text-only models.

### `click_ax({ref_id})`

1. Resolves `ref_id` via `__wb_ax_lookup()`
2. Scrolls into view (`scrollIntoView({block: 'center'})`)
3. Focuses the element
4. Dispatches `el.click()`

Returns `{success, method, tag, rect, name, href?, navigates?, hint?}`.

On Chrome, the click fires via CDP `Input.dispatchMouseEvent` → trusted event. On Firefox, it's a synthetic `el.click()`.

### `type_ax({ref_id, text, clear})`

1. Resolves `ref_id`
2. Uses `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` to bypass React/Vue controlled-component wrappers
3. Dispatches `input` + `change` events
4. For contenteditable: sets `textContent` + dispatches `beforeinput` + `input`

Rejects non-typeable input types (checkbox, radio, submit, file) with a clear error.

### `set_field({ref_id, text, clear, submit})`

Atomically focuses + (optionally clears) + types + (optionally submits). The one-shot equivalent of `click_ax` + `type_ax`.

**Combobox-aware submit**: when `submit:true`, the tool detects if the field is a combobox/autocomplete (role=combobox, aria-autocomplete, aria-controls pointing at a listbox, or a visible listbox on the page). If so, dispatches `ArrowDown` → `Enter` with small delays to commit the highlighted option. Otherwise falls back to `form.requestSubmit()` or a plain `Enter` key press.

---

## Overlay Hoisting

When building the tree, open dialogs, listboxes, menus, and `[aria-expanded=true]` comboboxes are emitted under an `[open overlays]` banner at the top of the tree — before the rest of the page content. This ensures portal-rendered popups (React, Radix, Stripe) survive the 3,000-char soft cap seen by the model.

---

## Accessible Name Resolution Priority

`getAccessibleName(el)` follows this order:

1. `<select>` selected option's text
2. `aria-label`
3. `aria-labelledby` — concatenates all referenced ids' text
4. `placeholder`
5. `title`
6. `alt`
7. `<label for>` lookup
8. Input `value` (submit/button/reset only — never for text inputs)
9. Direct text content
10. `innerText` fallback for buttons, links, summary
11. Preceding sibling text (unlabeled form fields pattern: "Every 1 month(s)" → the preceding text is the label)
12. Direct text fallback

---

## Shadow DOM Piercing

### Chrome

The CDP client (`cdp-client.js`) can pierce **closed** shadow roots via `Runtime.evaluate`:

```js
await cdpClient.evaluate(tabId, `
  (() => {
    const host = document.querySelector('my-component');
    return host.shadowRoot ? 'open' : 'closed';
  })()
`);
```

For deeper queries, `shadow_dom_query` uses CDP's `DOM.getDocument` + `DOM.querySelector` to reach into closed roots.

Tool exposure is tiered: `get_shadow_dom`, `shadow_dom_query`, and `get_frames`
are Full Act fallbacks, and Dev mode also adds them for Mid-tier providers so
page-debugging runs can inspect Web Component and iframe structure without
giving Mid normal Act the whole Full UI fallback surface.

### Firefox

Only **open** shadow roots (`element.shadowRoot`) are accessible. Closed roots cannot be read through the content script. `execute_js` is exposed in Dev mode on both builds, but ordinary page JavaScript still cannot obtain a closed root, and the tree builder cannot reach it.

---

## iframe Targeting

`get_frames`, `iframe_read`, `iframe_click`, and `iframe_type` work with cross-origin iframes because the extension injects content scripts directly into each frame, bypassing the same-origin policy.

The tree builder does **not** recurse into iframes by default. The agent must explicitly call `iframe_read` or `get_frames` to discover and read iframe content.

---

## Common Failure Modes

| Failure | Symptom | Fix |
|---|---|---|
| Element removed from DOM | `click_ax` returns "not found" | Re-read the tree; the page may have re-rendered |
| Stale ref after SPA nav | All refs miss | Agent should read the tree again after `/navigate` or `wait_for_stable` |
| Shadow DOM closed root | Tree shows `<my-component>` but not its children | Use `get_shadow_dom` + `shadow_dom_query` on Chrome; Firefox cannot pierce a closed root |
| iframe not in tree | Agent can't find iframe content | Call `get_frames` then `iframe_read` / `iframe_click` |
| Truncated tree | `truncated: true` + `hasMore: true` | Call `get_accessibility_tree` with `page: nextPage` or `ref_id` to zoom in |
| Portaled overlay not visible | Tree shows the combobox but not the dropdown | The overlay is hoisted to the `[open overlays]` section — re-read with `filter: 'all'` |

---

## Debugging

- The tree output is visible in verbose mode (side panel toggle)
- `window.__wbElementMap` in the page console lists all live refs
- `window.__wb_ax_lookup('ref_42')` tests a specific ref
- The deep-verbose debug log (`Shift+click` verbose button) dumps the last 200 LLM request/response pairs including AX tool results
