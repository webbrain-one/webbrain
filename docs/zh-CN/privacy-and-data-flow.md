# 隐私与数据流

---

## 哪些数据会离开浏览器

### LLM 提供商请求

用户的每条消息、当前页面内容（无障碍树、截图或提取的文本）以及工具调用历史都会在每次交互时发送给**已配置的 LLM 提供商**。

| 数据 | 发送给提供商？ | 说明 |
|---|---|---|
| 用户的聊天消息 | 是 | 这是核心功能——用户输入的内容 |
| 页面 URL + 标题 | 是 | 注入到第一条用户消息中作为上下文 |
| 页面内容（无障碍树 / 提取的文本） | 是 | 代理读取页面以便对其操作 |
| 视口截图 | 是 | 如果提供商支持视觉（或配置了专门的视觉模型） |
| 工具调用历史 | 是 | 之前的工具结果是下一次 LLM 调用的上下文 |
| 用户凭证（密码、API 密钥） | 是 | 如果用户在聊天中输入，或代理填写后出现在工具结果中 |
| 提供商 API 密钥 | 是 | 作为 HTTP 标头（Bearer token）发送到提供商的 API 端点 |

当启用**先计划后执行**时，执行模式（执行或开发）的轮次会在任何浏览器工具运行之前，向同一已配置的提供商进行一次额外的计划调用。该调用包含用户的任务、经过脱敏处理的页面 URL/标题、简短的最新对话摘要以及计划系统提示。图像块在计划调用之前被丢弃；任何截图文本描述被视为不可信的上下文。

**没有其他数据会发送给提供商。** 扩展程序不会注入跟踪、遥测或分析。

### 哪个提供商接收数据？

用户在设置中选择他们的提供商。选项包括：

- **WebBrain Cloud**：请求会经过 `api.webbrain.one`；“帮助改进 WebBrain”默认启用，在其保持启用期间，部分交互可能会被保留并用于评估、改进、微调和训练
- **用户自带的云提供商**：OpenAI、Anthropic、Google Gemini、Mistral、DeepSeek、xAI、Groq、OpenRouter 等——请求使用用户凭据直接发送给提供商，WebBrain 不会收集这些请求
- **本地提供商**：llama.cpp、Ollama、LM Studio、Jan、vLLM、SGLang、LocalAI——数据保留在用户的机器上

本地模型和用户自带 API 的请求不会被 WebBrain 收集。WebBrain Cloud
请求会被处理，并可能按照[英文文档中的详细说明](../privacy-and-data-flow.md#webbrain-cloud-improvement-data)予以保留。

---

## 哪些数据保留在浏览器中

### 对话历史

存储在浏览器会话存储中：Chrome 使用 `chrome.storage.session`，Firefox 使用 `browser.storage.session`。按标签页保存的提供商历史（`agentConv:<tabId>`）、已渲染聊天（`tabChat:<tabId>`）和分离式运行 UI 日志（`runUi:<tabId>`）可在面板/侧栏关闭、重新加载或后台重启后恢复对话及进行中的运行。UI 日志保留有限的事件窗口，并单独限制累计的流式文本，以便在重连后重建进行中的 Markdown。相关对话内容会作为请求上下文发送给已配置的提供商；这些本地副本不会另行同步到 WebBrain。

### 追踪记录器

启用时（设置 → 显示 → "记录追踪"），每次代理运行都会写入一个 IndexedDB 数据库（`webbrain_traces`）：

- **`runs` 存储**：模型、提供商、令牌总数、时间戳、用户消息、最终内容
- **`events` 存储**：每一步的 LLM 请求/响应、工具调用及其参数和结果
- **`shots` 存储**：截图 blob

追踪页面（`ui/traces.html`）仅从本地 IndexedDB 读取。导出生成一个 JSON blob 保存到用户的下载文件夹。**追踪数据永远不会离开浏览器。**

### 设置

提供商配置（API 密钥、基础 URL、模型选择）存储在 `chrome.storage.local` 中。API 密钥以明文形式保存——这是一个个人电脑工具，且存储受到浏览器沙箱保护。扩展程序没有任何机制可以泄露这些密钥。

### 用户资料

如果用户启用资料自动填充，资料文本（姓名、电子邮件、临时密码）以明文形式存储在 `chrome.storage.local` 中，并在每次交互时作为系统提示的一部分发送给 LLM 提供商。

### API 快捷方式观察器

后台脚本维护一个小的内存缓冲区，用于存储同标签页的 XHR/fetch 元数据：URL、HTTP 方法和时间戳，每个标签页最多记录最近 40 个观察到的请求。仅在循环检测发现重复点击时使用，以便代理可以建议精确的 `fetch_url` 调用而不是再次点击。请求体和响应体不会被捕获。当标签页关闭时，缓冲区被删除；除非循环警告将 URL + 方法暴露给活动的 LLM 对话，否则观察器数据不会离开浏览器。

---

## 遥测 / 分析

**无。** 扩展程序不包含任何分析 SDK、遥测、崩溃报告或使用跟踪。没有"回拨"端点。

唯一的出站 HTTP 请求是：
1. **LLM 提供商 API 调用**（到用户配置的 URL）
2. **CapSolver API 调用**（如果用户启用了验证码求解）
3. **通过 `fetch_url` / `research_url` 工具获取内容**（到代理被要求获取的 URL）
4. **技能工具调用**（到已启用技能声明的 HTTPS 端点——参见下面的"预置技能"了解默认启用的技能）
5. **斜杠驱动的标签页/屏幕录制**不产生出站流量（.webm 文件通过 `chrome.downloads.download` 保存到下载文件夹）

可选的 `webRequest` API 快捷方式观察器默认关闭，不创建出站请求；启用时，它观察页面已发出的请求的重放元数据，以便诊断重复的 UI 变更。

### 预置技能

一个内置的"FreeSkillz.xyz"技能（`skills/freeskillz-xyz.md`）在首次运行时被植入设置 → 技能中，默认启用，可以在那里删除。它声明了 `read_youtube_transcript`、`resolve_public_media` 和 `download_public_media` 工具。当模型调用这些工具之一时，WebBrain 仅将当前或模型提供的 URL，以及声明的选项（如转录语言、媒体类型、最大高度或文件名提示）通过 HTTPS 发送到声明的 `https://freeskillz.xyz` 端点——这是由扩展程序开发者运营的第一方服务，与用户配置的 LLM 提供商分开。转录工具仅限于 YouTube/youtu.be URL，而媒体工具仅限于技能清单中声明的公共媒体主机。只读的转录和解析器工具不需要 `/allow-api`；`download_public_media` 仅在执行模式下可用，并且需要下载权限，因为它会创建一个短期的提供商作业，通过浏览器下载 API 保存完成的文件，然后要求提供商删除该作业。这些调用不会发送页面内容、聊天历史或浏览历史（除了 URL 和声明的工具参数）。用户可以从设置 → 技能中删除此技能或任何用户导入的技能工具，以完全停止此数据流。

---

## 数据流图

### 基本聊天交互

```
用户输入消息
  │
  ▼
侧面板 → 后台 (chrome.runtime.sendMessage)
  │
  ▼
代理增强：URL + 标题 + 适配器注释 + （可选）截图
  │
  ▼
可选的先计划后执行调用：provider.chat(计划消息，无工具)
  │
  ▼
代理调用 provider.chat(messages, tools)
  ├─ 提供商 API 密钥 → HTTP 标头发送到提供商端点
  ├─ 消息 + 页面内容 → HTTP 请求体发送到提供商端点
  │
  ▼
提供商返回 → 代理执行工具调用 → 结果追加
  │
  ▼
循环直到完成 → 后台发送最终回复 → 侧面板显示
```

### 追踪记录流程（启用时）

```
代理轮次
  │
  ├─ startRun()     → IndexedDB.runs   { runId, model, userMessage, ... }
  ├─ recordLLMRequest()  → IndexedDB.events  { runId, seq, kind:'llm_request', ... }
  ├─ recordLLMResponse() → IndexedDB.events  { runId, seq, kind:'llm_response', ... }
  ├─ recordToolCall()    → IndexedDB.events  { runId, seq, kind:'tool', ... }
  ├─ recordScreenshot()  → IndexedDB.shots   { runId, seq, blob } + events 标记
  └─ endRun()       → IndexedDB.runs   （更新持续时间、令牌数、状态）
```

所有 IndexedDB 读取仅在用户打开追踪页面时发生。

### 截图流程

```
CDP 捕获 → JPEG/PNG 数据 URL
  │
  ├─ 如果配置了专门的视觉模型 → 子调用进行描述 → 文本描述
  │   → 仅描述文本被发送到主要提供商
  │
  ├─ 如果主要提供商支持视觉 → image_url 块附加到用户消息
  │   → 图像对 LLM 可见
  │
  └─ 如果不支持视觉 → 截图仍被捕获用于内部状态，但图像数据不发送给模型
```

---

## 安全边界

| 边界 | 跨越的数据 | 保护方式 |
|---|---|---|
| 浏览器 ↔ LLM 提供商 | 聊天消息、页面内容、截图 | HTTPS；用户选择了提供商 |
| 浏览器 ↔ CapSolver | 验证码令牌请求 | HTTPS；用户已选择加入 |
| 扩展程序 ↔ 屏幕外文档 | 请求代理请求 | 同一扩展程序，同一源 |
| Service Worker ↔ IndexedDB | 追踪数据 | 浏览器沙箱；永不传输 |
| Service Worker ↔ `chrome.storage.local` | API 密钥、设置 | 浏览器沙箱（明文） |

---

## 用户控制

| 设置 | 效果 |
|---|---|
| 提供商选择 | 选择哪个 LLM 接收数据，或在本地运行 |
| 提供商提示/工具层级 | 为非云提供商选择紧凑、中等或完整工具暴露 |
| 询问 / 执行 / 开发模式 | 选择只读、正常操作或开发者/页面检查模式 |
| 追踪开关 | 防止存储任何追踪数据 |
| 截图回退 | 控制页面图像是否发送给 LLM |
| 自动截图模式 | 控制视口捕获发送的频率 |
| 严格的秘密处理 | 防止凭据出现在摘要中 |
| 资料自动填充 | 控制用户资料文本是否发送给 LLM |
| 站点适配器开关 | 控制是否添加特定站点的指导 |
| `/allow-api` | 控制代理是否可以使用 API 变更 |
| CapSolver 开关 | 控制验证码数据是否发送给第三方求解器 |

---

## Firefox 差异

Firefox 没有屏幕外文档。追踪记录器和 `unlimitedStorage` 存在且与 Chrome 相同（`src/firefox/src/trace/recorder.js`）。所有数据流模式在其他方面相同，除了：

- 没有专门的视觉子调用（截图直接发送给主要提供商，如果支持视觉）
- 没有斜杠驱动的标签页/屏幕录制
- 对话、已渲染聊天和分离式运行 UI 日志使用 `browser.storage.session`，与 Chrome 的会话级持久化一致
