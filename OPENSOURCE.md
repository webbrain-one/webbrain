# DIV — Open-Source Rebuild & Relicensing Note

DIV is an open-source AI browser agent for Chrome, Firefox, and Microsoft Edge,
distributed under the MIT License.

## What DIV is

DIV is a browser extension that puts an AI agent in a side panel next to your
tabs. Ask it about the page you're on, or hand it a task and let it click, type,
and navigate its way through. It runs on the model you choose — a local
llama.cpp or Ollama server, a frontier cloud API, or the managed default that
needs no setup at all.

This repository is a DIV rebrand of the open-source WebBrain extension
([github.com/webbrain-one/webbrain](https://github.com/webbrain-one/webbrain)):
the engine logic is preserved byte-for-byte, and only the visible product name
was changed (WebBrain -> DIV). Engine identifiers, the functional hostnames and
paths of `webbrain.one`, the bundled Xapian/libzim WebAssembly runtime, and the
managed `WebBrain Compass` LLM all keep their original spelling so behaviour is
identical to the upstream extension.

## How it works

- **Perception.** A content script inspects the page's accessibility tree and DOM
  to build a compact "guide" the agent uses to locate and interact with
  elements — clicks, form fields, text, images, and more.
- **Orchestration.** A background agent handles planning, tool calls, and session
  state, streaming structured **trace events** to a frontend the user controls in
  real time (see `docs/trace-format-compatibility.md`).
- **Model routing.** The same agent talks to a local inference server (Ollama,
  llama.cpp), a frontier cloud API (OpenAI, Anthropic, Gemini, DeepSeek, …), or
  the extension's managed default, `WebBrain Compass`.
- **Export + reproducibility.** Every step, tool, and output is emitted as
  structured JSON (an OpenAI-style session, downloadable as a ChatGPT log), so a
  run is inspectable, resumable, and reusable.

## License

DIV is licensed under the MIT License (see `LICENSE`). Upstream WebBrain was
distributed under the GNU General Public License v3.0-or-later, which permits
relicensing; this fork reuses the engine as-is while keeping the attribution to
Emre Sokullu. The appended note in `LICENSE` documents the relicensing.
