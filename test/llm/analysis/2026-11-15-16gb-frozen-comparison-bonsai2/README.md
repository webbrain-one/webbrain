# Four-model frozen comparison, including Ternary Bonsai 2 27B

This campaign adds Prism ML's Ternary Bonsai 2 27B to the existing Qwen 3.5 9B,
Gemma 4 26B-A4B and LFM 2.5 24B-A2B comparison. Every scored request replays
the archived May 23 Sonnet request, changing only `model`: identical messages,
41 tools, temperature 0.15 and a 4,096-token output budget. Ideal actions come
from the archived May 23 rubrics, not today's mutable `expected` directory.

The user-provided server is `http://192.168.1.51:8010`, model alias
`ternary-bonsai-2-27b`. Server metadata identifies
`Ternary-Bonsai-2-27B-PTQ1_0.gguf`, 26,895,998,464 language-model parameters,
5,935,527,936 bytes of weights, and build `b10826-c9c34bc9c`. Full server
properties and its chat template are retained alongside the results. The
model's normal thinking mode is left enabled without an effort override.

The initial server advertised 16,384 context per slot. Applying its actual
template to case 001 produced 17,366 input tokens, requiring 21,462 tokens
including the frozen output budget. The user restarted it with 32,768 tokens
per slot before inference began. `context-check.json` records the check.

Three preflight cases are separate from the 100-case scored run. During the
full run, a server restart interrupted case 018. Its failed request is kept
as `018.failed-attempt-1.json`; the identical request was repeated successfully.
Case 079 exceeded the initial HTTP deadline, was archived separately, and was
repeated successfully with a longer client deadline. The prompt, tool list,
sampling request and 4,096-token output budget stayed unchanged.
The first 22 successful cases were retained when the user requested four-way
concurrency. The remaining cases run with four workers, matching the server's
four slots. Completed responses are never rerun to select better answers.
The original and resumed metadata files identify each run segment, and newer
case records identify their corresponding metadata file.

Qwen and Gemma retain their May 23 local inference. Liquid and Bonsai use
November 15 local inference. Backends, quantizations, concurrency, templates
and hardware differ. Historical thinking settings are unverified. Response
times are deliberately excluded from the comparison.

## Completed results

All 100 scored Bonsai responses succeeded: 96 native first calls, all 96
schema-valid, no content-parsing fallbacks, reasoning evidence in 100/100
responses and no output-length limits. Both failed transport cases were
successfully retested. The two original failed attempts remain separate from
the 100 quality-scored responses.

| Model | Sonnet agreement / 100 | Expected tool / 100 | Exact action / 100 |
| --- | ---: | ---: | ---: |
| Qwen 3.5 9B | 70 | 35 | 15 |
| Gemma 4 26B-A4B | 71 | 30 | 13 |
| LFM 2.5 24B-A2B | 69 | 28 | 6 |
| Ternary Bonsai 2 27B | 77 | 34 | 17 |

On the 92 cases where Sonnet called a tool, Bonsai agrees 73 times, compared
with 65 for Gemma and Liquid and 64 for Qwen. This is first-action agreement,
not completed browser tasks or a controlled uncompressed-versus-ternary test.

Run the offline report after all 100 successful Bonsai responses are present:

```powershell
node test/llm/run-lfm25-24b-frozen.mjs --candidate bonsai --stage report
```

Inference commands:

```powershell
node test/llm/run-lfm25-24b-frozen.mjs --candidate bonsai --base http://192.168.1.51:8010 --stage preflight
node test/llm/run-lfm25-24b-frozen.mjs --candidate bonsai --base http://192.168.1.51:8010 --stage full --concurrency 4
node test/llm/run-lfm25-24b-frozen.mjs --candidate bonsai --base http://192.168.1.51:8010 --stage full --concurrency 4 --timeout 600000 --resume
```

`--resume` preserves successful responses and retries only missing or failed
cases, retaining failed attempts separately. It checks model identity,
quantization, chat template and server sampling defaults before resuming.
Browser tools are never executed; only the first proposed action is graded.

[Model and packing documentation](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf).
