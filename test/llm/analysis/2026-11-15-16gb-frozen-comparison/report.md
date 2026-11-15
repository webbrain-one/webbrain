# 16 GB model comparison: archived May 23 frozen protocol

All three models receive identical archived May 23 messages, tool schemas, temperature 0.15 and 4096-token output budget; only model changes.

| Model | Tool calls / 100 | Schema-valid / emitted | Sonnet agreement / 100 | Sonnet tool agreement / 92 | Expected tool / 100 | Exact action / 100 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen 3.5 9B | 90 | 90 / 90 | 70 | 64 | 35 | 15 |
| Gemma 4 26B-A4B | 87 | 87 / 87 | 71 | 65 | 30 | 13 |
| LFM 2.5 24B-A2B Q4_K_XL | 95 | 94 / 95 | 69 | 65 | 28 | 6 |

- Qwen and Gemma reuse May 23 local responses; LFM is a new local Q4_K_XL run.
- Backends, quantizations, hardware and model-side templates differ. Historical thinking settings are unverified.
- Sonnet agreement compares tool names, including shared no-tool answers. Ideal tool-name counts include exact matches.
- Schema validity uses only the archived advertised JSON schemas; it does not apply newer runtime policies or default normalization.
- Historical validity checks use saved parsed calls because the old files do not retain full raw API responses.
- Only the first action is graded; browser tools are not executed. Response times are not compared.

LFM 2.5 24B-A2B Q4_K_XL: 95 native first calls, 0 content-parsed calls, 100 responses with visible reasoning evidence, 0 output-length limits.
