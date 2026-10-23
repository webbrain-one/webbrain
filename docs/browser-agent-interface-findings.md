# Browser-agent interfaces: Fara, Browser Use, Compass, and DIV

Reviewed: 2026-09-15.

This note records how the private v2 browser benchmark connected models to a
browser, and how that differs from the DIV application. It contains no
benchmark scores, rankings, latency measurements, or spending figures.

The benchmark observations below are verified from its frozen adapter and
browser code. The DIV application observations describe this repository
at commit `e79980f8c3e27d3f51beafe09998108f4f01f989`. That current application
snapshot is not proof of the exact environment used to train Compass.

## Models, adapters, and applications are separate

Fara, the Browser Use model, and Compass generate responses or actions. A
runtime supplies observations, interprets those responses, executes browser
operations, and returns their results. The runtime's prompts, tool schemas,
page representation, history, and execution behavior all affect the resulting
agent.

The benchmark used separate custom adapters for these model families. It did
not run the complete DIV extension or the complete Browser Use framework.
Calling those adapters "native" without qualification overstates what was
established: support for a model's action syntax is not proof that its complete
training or reference runtime has been reproduced.

| Participant | Page observation in the benchmark | Action interface in the benchmark |
|---|---|---|
| Fara 1.5 | Screenshot, plus textual task and action feedback | `computer_use` actions, including coordinate clicks, typing, keys, and scrolling |
| Browser Use BU-30B-A3B Preview | Visible viewport text, indexed controls, and screenshot | JSON containing `memory` and an `action` array |
| DIV Compass Tiny v2 | Visible viewport text and controls identified by `ref_id`; no image input | Declared function tools, accepting native XML or structured `tool_calls` |
| DIV application | Semantic page reads and optional visual context, depending on provider and configuration | Its own mode- and tier-dependent tools, provider integration, and browser execution loop |

For the model participants, the shared benchmark loop was:

```text
Task + model-specific page observation
  -> model response
  -> adapter parses action name and arguments
  -> Playwright executes the browser operation
  -> action feedback + new page observation
  -> next model turn
```

The fixture server independently checked the resulting page state. A model's
claim that it was finished was not itself evidence of task success.

## Fara: visual page interaction

In this benchmark, Fara read the page through screenshots. It was not given
the DOM text, an accessibility tree, or an indexed list of controls. The task
instruction and action feedback were still supplied as text, so "screenshot
only" describes its **page observation**, not every message in the conversation.

The adapter used the pinned Microsoft identity, instructions, and
`computer_use` schema saved in `fara-reference.json`. A typical action has this
shape; the coordinates below are illustrative, not a recorded episode:

```xml
<tool_call>{"name":"computer_use","arguments":{"action":"left_click","coordinate":[500,500]}}</tool_call>
```

Coordinates use the reference's normalized 1000-by-1000 space. The browser
bridge converts them to the actual viewport dimensions before dispatching the
mouse event. Text entry, keyboard shortcuts, and scrolling are separate
computer-use operations. Following an action, the model receives updated
visual feedback; the message history retains the latest three screenshots.

The model can also emit prose before an action. That does not establish a
separate thinking-mode setting: the Fara requests did not send a dedicated
thinking on/off parameter. They used the reference prompt and action format.

This remained a Playwright implementation of the computer-use interface. It
was not a complete desktop environment or proof of identical behavior to
every Fara reference deployment. Browser chrome, key handling, coordinate
conversion, and the executor's supported operations remain part of the setup.

## Browser Use: indexed controls, images, and JSON actions

The Browser Use participant received visible text and a custom control list,
with entries indexed as `[1]`, `[2]`, and so on, together with a screenshot.
Those indices referred to the current observation's browser element handles.

The benchmark supplied its own short system prompt explicitly describing
"flash mode". It requested a brief `memory` field and an action array:

```json
{"memory":"The target is visible; click it.","action":[{"click":{"index":3}}]}
```

This is an illustrative format example. The advertised operations were
`click`, `input`, `dropdown_options`, `select_dropdown`, `send_keys`, `scroll`,
and `done`. The adapter translated them into its local browser operations.
For example, `select_dropdown` selected the option by its exact label, and
`input` used Playwright's field replacement operation.

Although the prompt requested one action per turn, the parser could extract
action batches. The runner counted attempted actions and handled batches
invalidated by navigation or an ending action. The format parser also accepted
structured tool calls as a fallback.

The full Browser Use framework's prompt assembly, DOM serialization, memory
management, and execution machinery were not imported. The short prompt,
custom browser-state representation, and local operation mappings are
therefore material parts of this benchmark condition. No separate Browser Use
thinking-mode parameter was sent; the prompt's flash-mode instruction should
be documented directly rather than described as a verified internal switch.

## Compass: text observations and function calls

The evaluated model was `webbrain-one/webbrain-compass-tiny-v2`, the merged
BF16 model based on MiniCPM5-2B. Here, "benchmark adapter" means interface
code; it should not be confused with a LoRA weight adapter or with DIV's
site-specific guidance modules.

Compass received a short benchmark-specific system message and a textual
page representation. The benchmark called this an accessibility tree, but
the implementation was a smaller representation: visible viewport text plus
a flat list of selected visible controls, their labels, values, selected
context, and native select options. It did not use DIV's semantic tree
builder.

The advertised tools were:

- `get_accessibility_tree()`
- `click_ax(ref_id)`
- `set_field(ref_id, text)`
- `select_option(ref_id, text)`
- `scroll(pixels)`
- `done(summary)`

The model received these as function schemas through the chat-completions
request. Its included chat template supplied the model-facing serialization.
The response parser accepted structured `tool_calls` and native function XML,
including CDATA parameter values. An illustrative native call is:

```xml
<function name="set_field"><param name="ref_id">ref_3</param><param name="text">Example</param></function>
```

The browser bridge resolved `ref_id` to a handle from the current observation
and performed the operation. References were regenerated from the visible
control order on each observation; they did not have DIV's persistent
element-reference semantics. Fresh observations were automatically returned
after actions. Calling `get_accessibility_tree` itself returned a short
acknowledgment, followed by that same observation mechanism.

The initial Compass condition explicitly disabled thinking. The later
thinking-enabled condition used the same frozen adapter with an external
`enable_thinking: true` override. The serving parser separated reasoning from
action content. Enabling thinking did not replace the tool catalog, prompt,
page representation, or execution loop with DIV's application runtime.

The saved model card documents native XML and specific chat-template/history
requirements, including dictionary-valued tool-call arguments when applying
the native template. That requirement concerns the rendered model input;
an OpenAI-compatible transport may encode arguments differently on the wire.
Transport parsing and template rendering must be checked together before
claiming complete conversation-format compatibility.

## DIV: the application around the model

DIV is the browser application and agent runtime. Compass is one model
that can be used within it. The application also supports other model
providers, so DIV as a whole is not synonymous with Compass or a single
observation modality.

The repository's agent loop selects prompts and tools according to
conversation mode (`ask`, `act`, `dev`) and provider tier (`compact`, `mid`,
`full`). It calls the provider, interprets tool calls, dispatches them through
its browser integration, and feeds results back into the conversation.

Its primary semantic interaction path uses the application's accessibility
tree and reference registry. The tree exposes roles, accessible names,
hierarchy, and state, with targeted subtree reads and continuation metadata
for larger outputs. Live elements retain their references within a document
route; scoped identifiers prevent references from an older document or route
silently aliasing new elements.

The runtime also has its own tool-result handling, mutation verification,
completion checks, permissions, and recovery behavior. Visual context may be
attached when the selected provider or configured vision helper supports it.
That optional application capability does not mean the benchmark Compass
participant received screenshots.

The current repository's local WebGPU preset points to **Compass Tiny v2.1**.
That is a different model identifier and deployment path from the BF16
**Compass Tiny v2** evaluated in this benchmark. This note does not establish
equivalence between those releases or between their runtimes.

### Concrete differences verified in the current code

| Area | Frozen Compass benchmark adapter | Current DIV application |
|---|---|---|
| System prompt | Short local-test instruction | Mode- and tier-specific prompts and runtime context |
| Page state | Viewport text and a flat visible-control list | Semantic tree with hierarchy, state, subtree reads, and pagination |
| Reference lifetime | Reassigned from current visible order | Persistent element registry within a document route, with scoped IDs |
| Page-read arguments | No advertised arguments | Filters, depth, size, subtree, and continuation arguments |
| Field entry | `set_field(ref_id, text)` mapped to `fill` | Also exposes clear/submit behavior and exact-value verification semantics |
| Scroll | Signed `pixels` mapped to viewport wheel input | Direction/amount and optional targeting of nested panes |
| Completion | `done(summary)` ends the model loop; fixture grading is separate | Application completion contracts, including explicit outcomes in relevant modes |
| Observation timing | Fresh page representation automatically follows actions | Application-managed reads, feedback, and optional visual observations |

These are differences against the inspected application snapshot. Establishing
which ones differ from Compass's actual training inputs requires the pinned
training/reference schemas and traces, not just the current application code.

## What these findings establish

Separate model-specific adapters existed, and the benchmark executed their
parsed actions in a real browser. They preserved important distinctions:
Fara's visual page observation, Browser Use's indexed JSON actions, and
Compass's textual function-call interface.

However, accepting the right XML or JSON syntax does not establish full
compatibility. That also requires agreement on tool names and arguments,
system instructions, observation formatting, reference lifetime, history
serialization, reasoning delimiters, and tool-result semantics. Parser and
mock-browser checks establish only the behavior they exercise.

Consequently, capability findings from this setup concern the combination of
model, adapter, and task environment. A potential interface mismatch is not
proof that it caused a particular failure, and syntactic compatibility is not
proof that it could not have affected behavior. Running the base MiniCPM model
through the same adapter controls the adapter between those conditions; it
does not establish that the adapter matches Compass's training environment.

## Source evidence

Benchmark sources are in the private handoff workspace; their absolute links
below are local provenance references and may be unavailable on another
machine. DIV references point to the inspected repository checkout.

- [Benchmark prompts, tool schemas, parsers, and request settings](C:/Users/esoku/Downloads/llm-tiny-v2-handoff-20260913T020813127Z/test/llm-tiny-v2/lib/adapters.mjs)
- [Benchmark page observations, action execution, and message history](C:/Users/esoku/Downloads/llm-tiny-v2-handoff-20260913T020813127Z/test/llm-tiny-v2/lib/browser.mjs)
- [Benchmark runner and independent scoring](C:/Users/esoku/Downloads/llm-tiny-v2-handoff-20260913T020813127Z/test/llm-tiny-v2/run.mjs)
- [Pinned Fara prompt and tool reference](C:/Users/esoku/Downloads/llm-tiny-v2-handoff-20260913T020813127Z/test/llm-tiny-v2/lib/fara-reference.json)
- [Saved Compass model card](C:/Users/esoku/Downloads/llm-tiny-v2-handoff-20260913T020813127Z/coordinator/minicpm/sources/compass-README.md)
- [External thinking-condition configuration](C:/Users/esoku/Downloads/llm-tiny-v2-handoff-20260913T020813127Z/coordinator/thinking/config.mjs)
- [DIV application tools and prompts](G:/esoku/Documents/webbrain3/src/chrome/src/agent/tools.js)
- [DIV agent loop](G:/esoku/Documents/webbrain3/src/chrome/src/agent/agent.js)
- [DIV accessibility tree and reference registry](G:/esoku/Documents/webbrain3/src/chrome/src/content/accessibility-tree.js)
- [DIV text tool-call parser](G:/esoku/Documents/webbrain3/src/chrome/src/agent/tool-call-parser.js)
- [DIV WebGPU provider and model identifiers](G:/esoku/Documents/webbrain3/src/chrome/src/providers/webgpu.js)

This documentation change does not modify the frozen benchmark, reinterpret
individual episode outcomes, or start any inference.
