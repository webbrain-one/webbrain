# LFM 2.5 24B, Gemma 4 26B and Qwen 3.5 9B

All three models receive the exact 100 archived May 23 requests: the same
35,242-character system prompt, 41 tool definitions, per-case user messages,
temperature 0.15 and 4,096-token output budget. Only the requested model changes.
The new run replays saved requests instead of rebuilding user messages with the
current payload builder. All 200 historical Qwen/Gemma request bodies were
verified against the corresponding archived Sonnet request.

Qwen and Gemma reuse May 23 local inference. LFM was tested locally on November
15 at the user-provided server, using the active **UD-Q4_K_XL** GGUF checkpoint.
The user confirmed this quantization after the server advertised Q4 rather than
Q8. Server metadata, chat template, request bodies and complete API responses
are retained. The model's template always prefixes generation with `<think>`,
and all 100 scored responses contain reasoning evidence. There is no
thinking-disabling override. Historical thinking settings are unverified.

The comparison uses the May 23 ideal actions archived in
`test/llm/analysis/2026-10-03-nex-n25/rubrics.json`; it does not read today's
mutable expected actions. `comparison.json`, `report.md`, and
`evidence-audit.json` contain the scores, caveats, source paths and hashes.

LFM completed 100/100 requests with zero errors, 95 native first tool calls,
94 schema-valid first calls, zero content-parsed fallback calls, and zero
output-length limits. Three separate preflight cases are excluded from scoring.

Sonnet agreement is 70/100 for Qwen, 71/100 for Gemma and 69/100 for LFM.
Restricting the comparison to the 92 cases where Sonnet called a tool gives
64/92, 65/92 and 65/92 respectively. The two-point overall Gemma/LFM difference
therefore comes from shared no-tool responses, not fewer matching tool choices
on the 92 tooled reference cases. Agreement is not ground-truth correctness.

Expected-tool matches are 35, 30 and 28 out of 100; exact tool-and-argument
matches are 15, 13 and 6. Exact matching preserves URL spellings, defaults and
extra arguments. For example, LFM's missing trailing slash in case 003 counts
as an exact mismatch. Case 001 is a more substantial defect:
`https://about:addons` instead of `about:addons`. Its one schema defect is case
092, `press_keys({key: "m"})`, outside the advertised enum. All models are
graded on their first action only; browser tools are not executed.

The server's model metadata reports 23,971,587,712 parameters and 14,868,650,496
bytes of model weights. These are model metadata, not a measurement of total
VRAM use on a 16 GB GPU. Backends, quantizations and serving dates differ.
Response times are deliberately excluded from the comparison report.

## Reproduction

```powershell
node test/llm/run-lfm25-24b-frozen.mjs --stage prepare
node test/llm/run-lfm25-24b-frozen.mjs --stage preflight
node test/llm/run-lfm25-24b-frozen.mjs --stage full
node test/llm/run-lfm25-24b-frozen.mjs --stage report
```

`prepare` and `report` run offline against committed evidence. Inference stages
require the user-provided server and refuse to overwrite existing case files;
use a fresh results destination for another inference campaign. The runner
performs no browser actions. No blog source or generated blog page is created
by this campaign.
