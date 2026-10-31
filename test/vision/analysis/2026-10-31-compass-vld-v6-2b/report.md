# WebBrain Compass VLD v6 2B Benchmark Audit Report

Held-out browser viewport vision suite (100 cases) and compact tool routing benchmark (100 first-turn cases + 100 scenarios / 89 scored) evaluated locally on NVIDIA GeForce RTX 5060 Ti.

## 1. Vision Suite Benchmark Leaderboard (100 Frozen Screenshots)

| Model | Parameter Class | Format / Precision | Strict Passes / 100 | Mean Rubric | Mean Latency | Critical Errors | Notes |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| **WebBrain Compass VLD v6 2B** | **2B** | **BF16 GGUF (3.46 GB)** | **66** | **90.2%** | **1.87s** | **0** | **#1 All-time leader; SOTA compact browser vision** |
| **Qwen 3.5 4B** | 4B | MLX 4-bit (3.06 GB) | 55 | 83.4% | 25.92s | 0 | Former leader; general-purpose 4B |
| **WebBrain VL 2 450M** | 453M | ONNX / WebGPU (0.81 GB) | 44 | 76.2% | 2.00s | 0 | Sub-1B browser specialist |
| **Gemma 4 E4B IT** | E4B | MLX 4-bit (6.86 GB) | 41 | 81.3% | 5.96s | 0 | Partial coverage across difficulty bands |
| **Qwen 3.5 2B** | 2B | MLX 4-bit (1.75 GB) | 39 | 79.1% | 10.01s | 0 | Standard 2B baseline |
| **MiniCPM-V 4.7 1B** *(semantic)* | 1B | Q4_K_M GGUF (0.64 GB) | 37 | 68.2% | 1.30s | 0 | Evaluated with named header normalization |
| **WebBrain VL 3 450M** | 453M | BF16 (0.91 GB) | 26 | 69.3% | 3.58s | 0 | Sub-1B browser specialist checkpoint |
| **Qwen 3.5 0.8B** | 0.8B | GGUF (0.58 GB) | 20 | 41.6% | 7.35s | 0 | Sub-1B off-the-shelf baseline |
| **LFM2.5-VL-1.6B** | 1.6B | MLX (1.80 GB) | 12 | 44.4% | 0.81s | 0 | Liquid foundation baseline |
| **LFM3-VLD-2B** | 2B | Q4_K_M GGUF (1.25 GB) | 4 | 44.7% | 2.20s | 0 | Base starting point |

### WebBrain Compass VLD v6 2B Breakdown by Difficulty
- **Easy (001–020)**: 14/20 strict passes (70.0%), mean score 90.7%, latency 1.64s
- **Basic (021–040)**: 16/20 strict passes (80.0%), mean score 92.3%, latency 1.83s
- **Intermediate (041–060)**: 15/20 strict passes (75.0%), mean score 94.2%, latency 1.90s
- **Advanced (061–080)**: 10/20 strict passes (50.0%), mean score 84.2%, latency 2.00s
- **Challenging (081–100)**: 11/20 strict passes (55.0%), mean score 89.7%, latency 1.96s

### Top Category Scores
- Kanban Board: 5/5 (100.0%, 1.000 mean)
- Toast Notifications: 5/5 (100.0%, 1.000 mean)
- Search Results: 5/5 (100.0%, 0.983 mean)
- Photo Understanding: 4/5 (80.0%, 0.956 mean)
- Checkout: 4/5 (80.0%, 0.951 mean)
- Dashboard: 4/5 (80.0%, 0.950 mean)
- Chart Reading: 4/5 (80.0%, 0.950 mean)
- Data Table: 5/5 (100.0%, 0.943 mean)
- Consent Banner: 5/5 (100.0%, 0.940 mean)

---

## 2. Compact Tool Routing Benchmark Leaderboard (89 Scored Scenarios)

| Model | Parameters | Structured Calls (/100) | Strict Exact Action (/89) | Loose Tool-Family Match (/89) | Loose Rate | Anti-patterns (/89) | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **WebBrain Compass VLD v6 2B** | **2B** | **93** | **7** | **38** | **42.7%** | **0** | **0** |
| **webbrain-compass-vld-tiny-v5** | 1B | 97 | 7 | 32 | 36.0% | 8 | 1 |
| **lfm3-vld-2b** | 2B | 87 | 1 | 32 | 36.0% | 2 | 0 |
| **Spark-X2.6-4B** | 4B | 100 | 11 | 29 | 32.6% | 2 | 0 |
| **MiniCPM-V-4.7-1B** | 1B | 97 | 2 | 27 | 30.3% | 4 | 1 |
| **LFM3-1.7B** | 1.7B | 100 | 10 | 19 | 21.3% | 1 | 0 |

### Security & Prompt Injection Defense
- Prompt injection defense scenarios: 6/8 ideal/ideal_name (75%)
- Injection control: 2/2 ideal (100%)
- Unprotected injection defense: 6/8 ideal/ideal_name (75%)
- Unprotected injection control: 2/2 ideal (100%)
- Zero tool execution anti-patterns across all 89 evaluated scenarios.
