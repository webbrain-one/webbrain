# Export and saved-workflow formats

DIV can export a conversation, a recorded tool chain, Settings, or a saved
workflow. These files have different privacy and compatibility properties.

| Command or UI | File | Format | Treat as sensitive? |
|---|---|---|---|
| `/export` | `webbrain-chat-<timestamp>.md` | Conversation Markdown | Yes. It contains visible chat and system messages. |
| `/export --traces` | `webbrain-traces-<timestamp>.md` | Recorded tool-chain Markdown | Yes. It can contain user prompts, model output, tool arguments, URLs, and results. Raw system prompts are not embedded. |
| `/export --config` | `webbrain-config-<timestamp>.json` | `webbrain-config/1` | **Yes. It is plaintext and can contain API keys, profile data, and user memory.** |
| `/workflow --export <id>` | `<name>.webbrain-workflow.json` | `webbrain-workflow/1` | Review before sharing. Runtime values are omitted, but saved targets and URL scopes remain. |
| Traces page **Export JSON** | `webbrain-trace-<model>-<run-id>.json` or `webbrain-session-<session-id>.json` | `webbrain-trace/1` | Yes. It contains one recorded run or a session bundle and may include screenshots. |

All exports are created locally by the browser. Exporting a file does not upload
it.

## Conversation Markdown

`/export` serializes the messages currently rendered in the side panel:

```md
# DIV Conversation

_Exported with DIV v25.8.5_

**You:** Summarize this page.

**DIV:** ...
```

The export is intended for reading rather than round-trip import. It includes
the exporting extension version but has no schema identifier.

## Recorded tool-chain Markdown

`/export --traces` exports recorded runs associated with the current
conversation. Tracing must have been enabled when the runs occurred. Each turn
contains its recording version when available, model and status metadata, model
responses, tool calls, arguments, rendered results, the allowlisted runtime
snapshot, and privacy-safe prompt provenance. Provenance identifies the
controlled prompt variant and records character counts plus declared prompt and
tool policy revisions. It also reports whether the prompt/runtime envelope
matched the effective mode; it does not embed or fingerprint raw system-prompt
text, message text, tool schemas, or tool names. Policy revisions identify the
controlled code path and are bumped when its prompt or tool-exposure rules
change; they do not vary with private request content.

Screenshots, vision sub-calls, and internal trace notes are omitted from this
Markdown format. The export may be marked partial or truncated when the browser
cannot retrieve the complete recorded chain.

The Traces page offers a separate JSON export for one selected run. Standalone
runs retain the legacy shape:

```json
{
  "schema": "webbrain-trace/1",
  "run": {},
  "events": [],
  "exportedAt": 1784937600000,
  "exportedByWebBrainVersion": "25.8.5"
}
```

`run` and `events` are diagnostic records, not a stable automation API.
Screenshot events can include `screenshot_base64` or `screenshot_dataUrl`.
Consumers should check `schema`, tolerate additional fields, and avoid relying
on undocumented event internals.

When the selected run belongs to a conversation, the same action exports the
indexed conversation runs as one session bundle. Each entry keeps its own run
metadata and event list so parent-run lineage can be reconstructed without
changing the `webbrain-trace/1` schema:

```json
{
  "schema": "webbrain-trace/1",
  "session": { "sessionId": "conversation-7" },
  "runs": [
    { "run": {}, "events": [] }
  ],
  "exportedAt": 1784937600000,
  "exportedByWebBrainVersion": "25.8.5"
}
```

Lossless entries are redacted with the same credential-key safeguards as
standalone JSON exports. Standalone exports keep the original `run` and
`events` fields for existing consumers; session bundles use `session` and
`runs` instead. Before downloading a session bundle, the Traces page confirms
the number of included runs and warns when any run uses the sensitive debug
tier. A session export fails instead of silently producing a partial bundle if
its run or event records cannot be read.

### Convert a trace to ATIF v1.7

The dependency-free converter turns one Traces-page JSON export into the
[Agent Trajectory Interchange Format (ATIF)](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md):

```bash
node scripts/trace-to-atif.mjs webbrain-trace-model-run.json
```

By default this writes `webbrain-trace-model-run.atif.json` next to the source
file. Pass a second path to choose another destination, or `-` to write the
trajectory to standard output:

```bash
node scripts/trace-to-atif.mjs trace.json trajectory.json
node scripts/trace-to-atif.mjs trace.json -
```

Standalone exports remain one ATIF trajectory keyed by the run ID. Session
bundles become one multi-turn ATIF trajectory keyed by the session ID; runs are
ordered chronologically, step numbers stay contiguous, and each step records
its source run in `extra.webbrain_run_id`.

The converter maps user and agent messages, tool calls and observations, token
metrics, errors, model metadata, and final content. It does not upload data.
Screenshots and verbose diagnostic event kinds are counted in
`extra.omitted_event_counts` but are not copied: ATIF represents images as
files referenced alongside the trajectory, while a DIV JSON export embeds
them as data URLs or base64. The converted trajectory remains sensitive because
it still contains prompts, tool arguments, URLs, and results.

### Convert a trace to OpenTelemetry OTLP JSON

The repository includes an offline converter for sending an exported
`webbrain-trace/1` run through an OpenTelemetry-compatible observability
pipeline:

```sh
npm run trace:otlp -- webbrain-trace-example.json \
  --output webbrain-trace-example.otlp.json
```

For a legacy single-run input, the output retains the existing root span with
model-call and tool child spans. A session bundle uses one trace per persisted
session, one span per run, same-session `parentRunId` parent links, and span
events for turn/step activity. Cross-session parents are represented as span
links rather than parent spans.

The output is an
[OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)
`ExportTraceServiceRequest`. Legacy input contains one `invoke_agent DIV`
root span, child model-call and `execute_tool` spans, and lightweight lifecycle
events; session bundles contain one `invoke_agent` span per run.
The mappings follow the current
[OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md),
which are still marked development and may change.

The converter does not upload anything. To send the result to a collector, use
that collector's OTLP/HTTP traces endpoint; for example, for a trusted local
collector:

```sh
curl -H 'Content-Type: application/json' \
  --data-binary @webbrain-trace-example.otlp.json \
  http://127.0.0.1:4318/v1/traces
```

Content capture is off by default. User messages, assistant text, error
messages, tool arguments, and tool results are omitted, while operational
metadata such as model, provider, timings, token counts, tool names, and run
identifiers remains. Screenshots are never embedded in the OTLP output. Add
`--include-content` only when the destination is trusted and the trace has been
reviewed:

```sh
npm run trace:otlp -- webbrain-trace-example.json \
  --output webbrain-trace-example.otlp.json \
  --include-content
```

See [`trace-format-compatibility.md`](trace-format-compatibility.md) for the
relationship between the storage version, run format version, and export
schema, plus the reader obligations for unknown events and legacy records.

This is a post-run conversion, not live OpenTelemetry instrumentation. Child
span start times are reconstructed from the recorder's completion timestamp and
reported latency, so they should be used for diagnostics rather than
distributed context propagation.

## Settings snapshots: `webbrain-config/1`

`/export --config` creates a versioned Settings snapshot:

```json
{
  "schema": "webbrain-config/1",
  "exportedAt": "2026-07-25T00:00:00.000Z",
  "webbrainVersion": "25.8.5",
  "warning": "Contains plaintext provider API keys and other sensitive Settings data. Store securely.",
  "settings": {
    "wbLocale": "en",
    "activeProvider": "webbrain_cloud",
    "providers": {},
    "askBeforeConsequentialActions": true
  }
}
```

| Field | Meaning |
|---|---|
| `schema` | Required format identifier. Imports accept `webbrain-config/1`. |
| `exportedAt` | ISO 8601 export time. |
| `webbrainVersion` | Version of the extension that created the file. |
| `warning` | Human-readable plaintext-secret warning. |
| `settings` | Allowlisted, default-resolved portable Settings values. |

The snapshot includes provider, vision, transcription, and CapSolver API keys;
profile data; user memory; custom skills; and permission choices. It excludes
conversations, traces, schedules, usage counters, accumulated spend, and
device-bound DIV Compass or Cloud Sync identity and session data.

Import with `/import <json>` or `/import --file`. Import validates known setting
types, ignores unknown setting keys, and fills omitted known settings with the
importing version's defaults. A provider's device-bound identity is preserved
locally rather than replaced by a portable snapshot.

## Portable workflows: `webbrain-workflow/1`

A saved workflow is a normalized automation definition compiled from the latest
successful recorded run. It is not a raw trace replay.

```json
{
  "schema": "webbrain-workflow/1",
  "id": "workflow_1784937600000_example",
  "name": "Search the catalog",
  "createdAt": 1784937600000,
  "updatedAt": 1784937600000,
  "source": {
    "runId": "run_example",
    "webbrainVersion": "25.8.5"
  },
  "start": {
    "origin": "https://shop.example",
    "pathFamily": "/products"
  },
  "parameters": [
    {
      "id": "query",
      "label": "Search",
      "required": true,
      "sensitive": false,
      "type": "text"
    }
  ],
  "steps": [
    {
      "id": "step_1",
      "tool": "set_field",
      "args": {
        "text": {
          "$workflowParam": "query"
        },
        "clear": true,
        "submit": true
      },
      "target": {
        "role": "textbox",
        "label": "Search"
      },
      "scope": {
        "origin": "https://shop.example",
        "pathFamily": "/products"
      },
      "expected": {
        "kind": "tool_verified"
      }
    }
  ],
  "stats": {
    "sourceToolCount": 1,
    "compiledStepCount": 1,
    "skippedToolCount": 0
  }
}
```

| Field | Meaning |
|---|---|
| `schema` | Required format identifier. Imports accept `webbrain-workflow/1`. |
| `id`, `createdAt`, `updatedAt` | Local identity and Unix-millisecond timestamps. Import replaces these with fresh local values. |
| `name` | Display name, limited to 80 characters. |
| `source` | Diagnostic source run and recording version. The source trace itself is not embedded. |
| `start` | Required starting origin and normalized URL path family. |
| `parameters` | Runtime text inputs. Values are never stored in the definition. |
| `steps` | Replayable tools with normalized arguments, semantic targets, URL scopes, and expected postconditions. |
| `stats` | Counts from compilation; these do not control replay. |

Compilation removes historical accessibility `ref_id` values, CSS selectors,
coordinates, URL queries and fragments, and typed field values. Typed values
become `$workflowParam` references. Replay resolves semantic targets against a
fresh accessibility tree and uses the normal Act permissions, confirmation, and
verification gates.

Portable workflow files are limited to 1 MiB, 50 parameters, and 100 steps.
Export and import both normalize the definition. Import rejects unknown or
malformed step arguments, assigns a new local ID and timestamps, and never
overwrites an existing workflow. The same definition can therefore be imported
more than once and moved between the Chrome and Firefox extensions.

## Compatibility guidance

- Read `schema` before consuming JSON. A different schema string is a different
  format version.
- Use `webbrainVersion` or `source.webbrainVersion` for diagnostics, not as a
  substitute for the schema identifier.
- Tolerate additional object fields when reading exports.
- Do not edit generated files unless you are prepared for import validation to
  reject them.
- Keep unencrypted exports out of public issues, repositories, and shared
  folders until you have reviewed and redacted them.
