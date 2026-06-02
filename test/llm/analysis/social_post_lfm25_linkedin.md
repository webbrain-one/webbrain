Liquid LFM 2.5-8B-A1B: how does it perform?

Liquid AI just shipped LFM 2.5-8B-A1B — a sparse Mixture-of-Experts built for on-device deployment. 8.3B total params, only 1.5B active per token. 24 layers (18 gated short-conv "LIV" blocks + 6 GQA), 32 experts with top-4 routing, 131k context, 38T pretraining tokens plus RL with tool use as a first-class objective.

We added it to our browser-agent tool-calling benchmark — 100 prompts, scored against Claude Sonnet 4.6's picks.

The small-model class results:

▸ Gemma 4-E2B — 2.3B eff / 5.1B stored — 63% match vs Sonnet — 76% tool-call rate
▸ Liquid LFM 2.5-8B-A1B — 1.5B active / 8.3B stored — 40% — 83%
▸ Qwen 3.5-0.8B (dense) — 0.8B — 37% — 90%
▸ Qwen 3.5-2B (dense) — 2.0B — 36% — 89%

LFM 2.5 beats both small Qwens and lands within reach of Gemma 4-E2B — solid debut for a brand-new model in its first browser-tool benchmark.

But for the small-model distillation slot, we're sticking with Gemma 4-E2B. Two reasons:

1. Performance — a 23-point gap on Sonnet-match (63% vs 40%) is not close.

2. Licensing. Gemma 4 just moved to plain Apache 2.0 — no revenue thresholds, no usage caveats. LFM 2.5 ships under the LFM Open License v1.0, which is Apache-2.0-derived but adds one clause: commercial rights terminate once your annual revenue passes $10M USD. Makes complete sense for a young lab without Google-scale backing — calibrated to let hobbyists and pre-revenue startups use it freely while monetizing the enterprise tail. But if you're a startup deciding what to build on, that $10M cliff is a future-self problem worth thinking about now.

Full write-up → https://www.webbrain.one/blog/liquid-lfm25-tool-calling
