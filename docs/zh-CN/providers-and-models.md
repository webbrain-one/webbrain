# 提供商与模型

---

## 提供商接口（`providers/base.js`）

每个 LLM 提供商实现 `BaseLLMProvider` 接口：

```js
class BaseLLMProvider {
  async chat(messages, options)         // → { content, toolCalls, usage }
  async *chatStream(messages, options)  // → async generator yielding { type, content }
  get supportsTools()                   // → boolean
  get supportsVision()                  // → boolean
  get promptTier()                      // → 'compact' | 'mid' | 'full'
  async testConnection()                // → { ok, error?, model? }
}
```

### 选项

```js
{
  tools: [...],            // 工具模式
  temperature: 0.3,
  maxTokens: 4096,
  stream: false,           // 使用 chatStream 而非 chat
  extraBody: {},           // 透传至 API 的额外字段
}
```

---

## 内置提供商

| 提供商 ID | 类型 | 类别 | 默认模型 | 视觉能力 |
|---|---|---|---|---|
| `llamacpp` | `llamacpp` | 本地 | （已加载模型） | 是（默认开启） |
| `ollama` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `lmstudio` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `jan` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `vllm` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `sglang` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `localai` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `openai` | `openai` | 云端 | `gpt-5.6-terra` | 模型名正则 |
| `anthropic` | `anthropic` | 云端 | `claude-sonnet-4-6` | 模型名正则 |
| `claude_subscription` | `anthropic_oauth` | 云端 | `claude-sonnet-4-6` | 是 |
| `gemini` | `openai` | 云端 | `gemini-3.1-flash` | 模型名正则 |
| `mistral` | `openai` | 云端 | `mistral-large-latest` | 模型名正则 |
| `deepseek` | `openai` | 云端 | `deepseek-v4-flash` | 模型名正则 |
| `xai`（Grok） | `openai` | 云端 | `grok-4.3` | 模型名正则 |
| `nvidia`（NIM） | `openai` | 云端 | `meta/llama-3.1-8b-instruct` | 模型名正则 |
| `groq` | `openai` | 云端 | `llama-3.3-70b-versatile` | 模型名正则 |
| `minimax` | `openai` | 云端 | `minimax-m2.7` | 模型名正则 |
| `alibaba`（Qwen） | `openai` | 云端 | `qwen-max` | 模型名正则 |
| `openrouter` | `openai` | 路由器 | `openrouter/free` | 模型名正则 |

### 本地提供商

七个本地提供商默认启用，无需 API 密钥（除非本地服务器启动时启用了认证）：

- **llama.cpp**：`http://localhost:8080` — 运行 `llama-server -m model.gguf`
- **Ollama**：`http://localhost:11434/v1` — `ollama serve`，或 `ollama launch webbrain --model <model>`
- **LM Studio**：`http://localhost:1234/v1` — LM Studio 的本地推理服务器
- **Jan**：`http://localhost:1337/v1` — Jan 的本地 OpenAI 兼容 API 服务器
- **vLLM**：`http://localhost:8000/v1` — vLLM 的 OpenAI 兼容服务器
- **SGLang**：`http://localhost:30000/v1` — SGLang 的 OpenAI 兼容服务器
- **LocalAI**：`http://localhost:8080/v1` — LocalAI 的 OpenAI 兼容服务器

以上七个均默认 `supportsVision: true`，因为 2026 年本地加载的大多数模型都是多模态的。

**上下文窗口。** 为获得可靠的智能体运行，请使用**至少 16k 令牌上下文窗口**加载本地模型 — 这是可用的最低要求。8k 在选择了 Compact 层级时可以工作；4k 太小，无法容纳系统提示 + 工具模式。智能体从 `provider.contextWindow`（`providers/base.js`）读取窗口以驱动自动压缩；当提供商配置未设置 `contextWindow` 时，本地提供商默认保守的 **16k**（云端/路由器默认 128k）。**测试连接** / **加载模型** 会为 **llama.cpp**、**Ollama** 和 **LM Studio** 在报告时自动检测（llama.cpp `GET /props` 的 `n_ctx`、Ollama `GET /api/ps` 实时上下文然后 `/api/show` 的 `num_ctx`、LM Studio `/api/v0/models` 的 `loaded_context_length`）。检测会刷新默认 16k；仅在来自实时/运行时上下文时才会缩小更大的手动覆盖（不会仅凭 Ollama `/api/show`）。Jan / vLLM / SGLang / LocalAI 尚不自动检测。仍可显式设置 `config.contextWindow`，并确保模型服务器实际以那么大的上下文启动（例如 `llama-server -c 16384`）。

### 提示/工具层级和模式

提供商层级和对话模式是独立的调节项：

- **层级**（`compact | mid | full`）是提供商设置。它控制模型接收的 Act 系统提示和普通浏览器智能体工具子集。
- **模式**（`ask | act | dev`）由用户为每个对话/消息选择。它控制请求是只读、普通浏览器操作还是开发人员/页面检查工作。

`provider.promptTier` 解析当前激活的层级。云端提供商强制为 Full。本地提供商默认为 Mid。OpenRouter/路由器提供商除非显式更改，否则默认为 Full。仍设置旧版 `useCompactPrompt` 布尔值的现有配置映射到 Compact。

| 层级 | 目标模型类别 | 普通工具面 |
|---|---|---|
| `compact` | 非常小/本地模型 | 最简提示和少量普通 Act 工具集。无调度、iframe、下载资源或高级 DOM/UI 回退工具。 |
| `mid` | 有能力的本地模型 | 平衡的提示和常见任务工具：下载、调度、iframe 工具、表单验证和 `download_resource_from_page`，同时排除 Full 独有的高级 UI/DOM 回退。 |
| `full` | 前沿/云端或大型本地模型 | 完整普通 Act 提示和高级回退，如悬停、拖放、框架和影子 DOM。 |

Ask 模式忽略提供商层级，保持只读。Act 模式使用所选层级的普通工具。Dev 模式需要 Mid 或 Full，使用所选 Act 提示，附加 `SYSTEM_PROMPT_DEV_APPENDIX`，并添加 Dev 独有的源代码/样式工具以及用于 Mid 层级调试的 Dev 扩展影子/框架检查工具。Compact Dev 在发送 LLM 请求前被阻止。

### 视觉检测

| 提供商 | 机制 |
|---|---|
| OpenAI 兼容 | 根据模型名称进行正则匹配（`gpt-4o`、`gpt-5`、`claude-3`、`claude-sonnet-4`、`gemini-2.0-flash` 等） |
| Anthropic | `claude-(3\|sonnet-4\|opus-4)` 模式 |
| llama.cpp | 显式 `supportsVision` 配置开关 |
| Ollama / LM Studio / Jan / vLLM / SGLang / LocalAI | 显式 `supportsVision` 配置开关（通过 OpenAI 提供商） |

### Anthropic 转换

当激活的提供商是 Anthropic 时，智能体会转换 OpenAI 格式的消息：

| OpenAI 格式 | Anthropic 格式 |
|---|---|
| `system` 消息 | `system` 字段（顶级） |
| `assistant` + `tool_calls` | `assistant` + `tool_use` 内容块 |
| `tool` 角色 | `user` + `tool_result` 内容块 |
| `image_url`（data URL） | `image` 源块 |

---

## ProviderManager（`providers/manager.js`）

管理提供商生命周期：

```js
const pm = new ProviderManager();

await pm.load();                    // 从 chrome.storage.local 加载
await pm.save();                    // 持久化到 chrome.storage.local
pm.getActive();                     // 获取当前激活的提供商实例
await pm.setActive('openai');       // 切换激活的提供商
await pm.updateProvider('openai', { model: 'gpt-5' }); // 更新配置
pm.getAll();                        // 所有提供商配置（用于设置界面）
await pm.testProvider('openai');    // 测试连接
```

### 配置持久化

配置存储在 `chrome.storage.local` 中的 `providers` 键下，与默认值合并。默认值提供结构（存在哪些提供商键）；存储的配置覆盖每个键的值。这使得引入新提供商条目的升级可以在用户不清空存储的情况下工作。

已弃用的提供商条目（`webbrain`、`openai_subscription`）会被过滤掉。

### 费用限额

设置界面暴露会话和总云端费用限额。智能体优先使用提供商报告的 `usage.cost`/`usage.cost_usd` 值（OpenRouter 直接报告此值）。对于仅返回令牌计数的直接云端提供商，WebBrain 根据提供商配置字段估算费用：

- `inputCostPerMillionUsd`
- `cacheReadCostPerMillionUsd`
- `cacheWriteCostPerMillionUsd`（5 分钟或未注明时长的缓存写入）
- `cacheWrite1hCostPerMillionUsd`
- `outputCostPerMillionUsd`

OpenAI 将缓存读取与写入令牌都包含在输入令牌总数中（`prompt_tokens_details.cached_tokens` / `cache_write_tokens`，或 Responses API 的 `input_tokens_details` 等价字段），因此 WebBrain 会先减去这两部分，再对剩余令牌应用常规输入费率，并用 `cacheWriteCostPerMillionUsd` 为写入计价。Anthropic 和 Bedrock 分别报告常规输入、缓存读取和缓存写入，因此这些计数会作为独立的计费类别相加；它们还可以区分 5 分钟和 1 小时缓存写入。

这些费率在提供商卡片中可编辑，因此无需修改代码即可调整自定义模型定价。未配置缓存专用费率时，它会回退到常规输入费率；未配置 1 小时写入费率时，会回退到通用缓存写入费率。如果计费的远程提供商有令牌使用量但未配置输入/输出费率，智能体会使用保守默认值（每百万令牌输入 `$3` / 输出 `$15`）。流式提供商每次请求只计入最终累计使用量快照。本地提供商不计费。

### 专用视觉提供商

用户可以配置单独的视觉提供商来处理屏幕截图描述。智能体子调用此提供商以获取视口的文本描述，然后仅将描述（而非原始图像）馈送给主规划提供商。当主提供商仅为文本时，这减少了令牌成本：

```js
const vision = await providerManager.getVisionProvider();
// 返回 OpenAICompatibleProvider 实例或 null
```

### 转录提供商

由 Tab Recorder 用于 Whisper 转录。按优先级顺序依次回退至已配置的提供商：OpenAI → Groq → LM Studio → llama.cpp。阻止列表排除已知不托管 Whisper 的提供商（Anthropic、Gemini、Mistral、DeepSeek、xAI、Nvidia）。

---

## 添加一个提供商

1. **创建提供商类**，在 `src/chrome/src/providers/<name>.js` 中实现 `BaseLLMProvider`
2. **将默认配置添加**到 `manager.js` 中的 `_defaultConfigs()`
3. **添加工厂分支**到 `_createProvider()`
4. **注册导入**到 `manager.js`
5. **在智能体中添加提供商特定的处理**（例如 Anthropic 的消息格式转换）
6. **镜像到 Firefox**（`src/firefox/src/providers/`）

### 适用于 OpenAI 兼容的提供商

如果提供商使用 OpenAI `/v1/chat/completions` API 格式，你只需添加一个默认配置条目 — `OpenAICompatibleProvider` 处理其余部分：

```js
myprovider: {
  type: 'openai',
  category: 'cloud',
  label: '我的提供商',
  providerName: 'myprovider',
  baseUrl: 'https://api.myprovider.com/v1',
  model: 'my-model',
  supportsStreamUsageOptions: false,
  apiKey: '',
  enabled: false,
},
```

视觉能力通过模型名称正则自动检测。如果提供商有已知的视觉模型集，请将它们添加到 `openai.js` 的正则表达式中。仅对接受 OpenAI 风格 `stream_options.include_usage` 的提供商设置 `supportsStreamUsageOptions: true`；当提供商在不接受该请求字段的情况下返回使用量时，请将其保持为 false。
