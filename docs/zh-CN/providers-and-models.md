# 提供商与模型

---

## 提供商接口（`providers/base.js`）

每个 LLM 提供商实现 `BaseLLMProvider` 接口：

```js
class BaseLLMProvider {
  async chat(messages, options)         // → { content, toolCalls, usage }
  async *chatStream(messages, options)  // → async generator yielding { type, content }
  get supportsTools()                   // → boolean
  get supportsAskStreaming()            // → boolean
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
| `webbrain_cloud` | `openai` | 云端 | `webbrain-cloud 1.0` | 是 |
| `llamacpp` | `llamacpp` | 本地 | （已加载模型） | 自动元数据 / 覆盖 |
| `ollama` | `openai` | 本地 | （已加载模型） | 通过 `/api/show` 自动检测 / 覆盖 |
| `lmstudio` | `openai` | 本地 | （已加载模型） | 自动元数据 / 覆盖 |
| `jan` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `vllm` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `sglang` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `localai` | `openai` | 本地 | （已加载模型） | 自动元数据 / 覆盖 |
| `gpt4all` | `openai` | 本地 | （已加载模型） | 是（默认开启） |
| `local_openai_proxy` | `openai` | 本地 | （必填） | 默认关闭 / 手动开关 |
| `webgpu`（Chromium） | `webgpu` | 本地 | Compass Tiny v2.1；Ternary Bonsai 2 2B Vision；实验性自定义 HF ONNX 仓库 | 仅 Bonsai Vision 预设 |
| `azure_openai` | `azure_openai` | 云端 | （部署） | 手动开关 |
| `aws_bedrock` | `aws_bedrock` | 云端 | （模型 ID） | 否 |
| `openai` | `openai` | 云端 | `gpt-5.6-terra` | 模型名正则 |
| `anthropic` | `anthropic` | 云端 | `claude-sonnet-4-6` | 模型名正则 |
| `gemini` | `openai` | 云端 | `gemini-3.1-flash` | 模型名正则 |
| `cloudflare` | `openai` | 路由器 | `@cf/zai-org/glm-5.2` | 模型名正则 |
| `mistral` | `openai` | 云端 | `mistral-large-latest` | 模型名正则 |
| `deepseek` | `openai` | 云端 | `deepseek-flash` | 模型名正则 |
| `xai`（Grok） | `openai` | 云端 | `grok-4.3` | 模型名正则 |
| `nvidia`（NIM） | `openai` | 路由器 | `meta/llama-3.1-8b-instruct` | 模型名正则 |
| `groq` | `openai` | 路由器 | `llama-3.3-70b-versatile` | 模型名正则 |
| `minimax` | `openai` | 云端 | `minimax-m2.7` | 模型名正则 |
| `kimi` | `openai` | 云端 | `kimi-k2.5` | 模型名正则 |
| `alibaba`（Qwen） | `openai` | 云端 | `qwen-max` | 模型名正则 |
| `together` | `openai` | 路由器 | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | 模型名正则 |
| `openrouter` | `openai` | 路由器 | `openrouter/free` | 模型名正则 |
| `huggingface` | `openai` | 路由器 | `zai-org/GLM-5.2` | 模型名正则 |
| `fireworks` | `openai` | 路由器 | `accounts/fireworks/models/llama-v3p3-70b-instruct` | 模型名正则 |
| `z_ai` | `openai` | 云端 | `glm-5.2` | 模型名正则 |

### 扩展提供商目录

DIV 从 OpenCode 提供商目录提交
`62e4641235d7847dadc60da37cca8a023dd54fc1` 的快照中新增了 76 张默认禁用的
提供商卡片。提供商页面在 **Chromium 上共有 106 个内置提供商**，在 **Firefox
上共有 105 个**；两者的差异是仅 Chromium 提供的本地 WebGPU 运行时。完整 ID
列表如下：

`302ai`、`abacus`、`aihubmix`、`alibaba-coding-plan`、
`alibaba-coding-plan-cn`、`azure-cognitive-services`、`bailing`、`baseten`、
`berget`、`cerebras`、`chutes`、`clarifai`、`cloudferro-sherlock`、`cohere`、
`cortecs`、`deepinfra`、`digitalocean`、`dinference`、`drun`、`evroc`、
`fastrouter`、`friendli`、`google-vertex`、`google-vertex-anthropic`、
`helicone`、`iflowcn`、`inception`、`inference`、`io-net`、`jiekou`、`kilo`、
`kimi-for-coding`、`kuae-cloud-coding-plan`、`llama`、`lucidquery`、
`meganova`、`minimax-cn-coding-plan`、`minimax-coding-plan`、`moark`、
`modelscope`、`morph`、`nano-gpt`、`nebius`、`nova`、`novita-ai`、
`ollama-cloud`、`opencode`、`opencode-go`、`ovhcloud`、`perplexity`、
`perplexity-agent`、`poe`、`privatemode-ai`、`qihang-ai`、`qiniu-ai`、
`requesty`、`scaleway`、`siliconflow`、`siliconflow-cn`、`stackit`、
`stepfun`、`submodel`、`synthetic`、`tencent-coding-plan`、`upstage`、`v0`、
`venice`、`vercel`、`vivgrid`、`vultr`、`wandb`、`xiaomi`、
`zai-coding-plan`、`zenmux`、`zhipuai`、`zhipuai-coding-plan`。

大多数提供商使用兼容 OpenAI 的 Chat Completions 协议和 Bearer API 密钥。
Azure AI Foundry 使用资源名称与 `api-key`；Google Vertex AI 使用项目、区域和
通过 `x-goog-api-key` 发送的 Google 授权密钥；`global` 区域使用
`aiplatform.googleapis.com`。Vertex Anthropic 使用 `rawPredict` /
`streamRawPredict`，并为 `us` 和 `eu` 使用对应的多区域主机；Perplexity
Agent 使用 Responses API。现有 Cloudflare 卡片还支持可选的 AI Gateway
ID；对于 `@cf/` 模型，留空时会自动使用 `default` 网关。

当 `supportsAskStreaming` 启用时，交互式 Ask 回合会流式显示回复。中断的流会
清除部分文本、仅以非流式方式重试一次，并在本次运行剩余阶段关闭流式传输。
Act、Dev、计划任务、云端运行和 Continue 仍使用非流式请求。服务返回令牌用量时，
DIV 会直接记录；若服务省略用量，则记录基于字符数的保守估算，避免流式请求绕过
已配置的成本限额。

明确不支持的条目：`github-models`（GitHub Models 于 2026 年 7 月 30 日退役）、
`github-copilot`（订阅/OAuth）、`gitlab` 和 `sap-ai-core`（需要专用认证、
部署发现或协议）。

### 本地提供商

在 Chromium 上，**WebGPU（浏览器内）** 是无端点的本地提供商。提供商页面和末日模式选择器提供两个预设：**Compass Tiny v2.1**（默认，`q4f16`，约 1.87 GB，仅文本，32k 上下文）和 **Ternary Bonsai 2 2B Vision**（约 1.45 GB，支持图片，16k 上下文），走 Transformers.js / ONNX；提供商页面还接受自定义 Hugging Face 仓库。其他 Bonsai 2 预设随扩展提供，但暂时不在选择器中显示。启用末日模式时会自动下载所选模型；缓存完成后，即使未启用末日模式也可正常使用。在显存受限的 GPU 上，可在提供商页面的 WebGPU 卡片中调低上下文窗口。Firefox 不提供该卡片。

浏览器内模型只回答问题。在侧边栏中，每个 Ask 回合只进行一次不带工具的调用：DIV 先读取当前页面、选中文本、PDF 标签页以及问题中链接的页面，再把这些文本和一个简短提示一起发送（tiny Ask，见 `docs/webgpu-models.md`）。该提供商不支持 Act 和 Dev 模式；如需在浏览器中执行操作，请选择其他提供商。

九个本地端点提供商默认启用。模型运行时无需 API 密钥（除非服务器启用了认证）；
通用代理卡片必须填写客户端密钥：

- **llama.cpp**：`http://localhost:8080` — 运行 `llama-server -m model.gguf`
- **Ollama**：`http://localhost:11434/v1` — `ollama serve`，或 `ollama launch webbrain --model <model>`
- **LM Studio**：`http://localhost:1234/v1` — LM Studio 的本地推理服务器
- **Jan**：`http://localhost:1337/v1` — Jan 的本地 OpenAI 兼容 API 服务器
- **vLLM**：`http://localhost:8000/v1` — vLLM 的 OpenAI 兼容服务器
- **SGLang**：`http://localhost:30000/v1` — SGLang 的 OpenAI 兼容服务器
- **LocalAI**：`http://localhost:8080/v1` — LocalAI 的 OpenAI 兼容服务器
- **GPT4All**：`http://localhost:4891/v1` — GPT4All 本地 API 服务器
- **本地 OpenAI 兼容代理**：`http://127.0.0.1:8317/v1` — 通用的、带认证的
  本地网关；模型和代理客户端 API 密钥均为必填。加载模型、选择模型或测试连接后，
  上下文窗口会按以下顺序自动设置：代理 `/v1/models` 中所选模型的卡片、其后 llama.cpp
  服务器的 `GET /props?model=` 实时 `n_ctx`、已知托管模型名称（上限 128k），否则使用
  **64k** 的代理默认值（此前为 16k）。名称和默认值只替换默认值，不会覆盖您手动输入的数值

#### 订阅代理示例（CLIProxyAPI）

**本地 OpenAI 兼容代理**卡片可连接单独管理的
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 实例。按照
[官方快速入门](https://help.router-for.me/introduction/quick-start)安装，或从源码执行
`go build -o cli-proxy-api ./cmd/server` 并把 `config.example.yaml` 复制为
`config.yaml`。先设置 `host: "127.0.0.1"`、`port: 8317`，并在 `api-keys` 中生成
强随机密钥。使用 `./cli-proxy-api --config ./config.yaml --codex-login` 登录
ChatGPT/Codex，或用 `--claude-login` 登录 Claude；Gemini CLI 需先安装
[官方插件](https://github.com/router-for-me/cpa-plugin-gemini-cli)：启用可信插件，在
CLIProxyAPI 官方插件商店安装 `gemini-cli`，重启代理，再使用 `--geminicli-login`
（参见[插件管理说明](https://help.router-for.me/cn/management/api#插件)）。最后运行
`./cli-proxy-api --config ./config.yaml` 启动服务。
在 DIV 中保留 `http://127.0.0.1:8317/v1`，填写同一密钥，加载并选择模型，
最后测试连接。

不要把代理暴露到局域网或公网：CLIProxyAPI 的空 host 默认监听所有网络接口，TLS
默认关闭，空 `api-keys` 列表会允许未认证请求。这是一条实验性、由社区支持的兼容
路径。代理进程在本机运行，但可能把请求上下文转发给上游账户；上游 OAuth 凭据始终
保留在 CLIProxyAPI 中。

Ollama、llama.cpp、LM Studio 和 LocalAI 默认使用 `visionMode: auto`。DIV 在
页面上下文增强前读取所选模型的原生服务器元数据，只有服务器明确报告支持图像输入时才
发送截图。元数据请求失败或格式错误时，本回合按纯文本处理，之后会重试。提供商页面中
可选择自动、强制开启或关闭。模型字段为空时，每个用户回合都会重新检测当前加载
模型的能力，以便服务端热切换立即生效；其他本地提供商保持现有的显式开关行为。

#### Ollama 启动交接（预览）

<p align="center">
  <img src="../../web/assets/webbrain-ollama-heart.png" alt="DIV 喜爱 Ollama 启动交接" width="720">
</p>

DIV 目前通过本地 OpenAI 兼容提供商支持 Ollama。新的
`ollama launch webbrain --model <model>` 交接还可以自动配置 DIV，但它尚未
集成到上游 Ollama。目前可以从
[`esokullu/ollama` 的 `codex/ollama-webbrain-launch-handoff` 分支](https://github.com/esokullu/ollama/tree/codex/ollama-webbrain-launch-handoff)
试用；我们希望 Ollama 能将其上游集成。

```bash
git clone https://github.com/esokullu/ollama.git
cd ollama
git switch codex/ollama-webbrain-launch-handoff
cmake -S . -B build -G Ninja -DOLLAMA_MLX_BACKENDS=
cmake --build build --parallel 8

OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ./ollama serve
./ollama launch webbrain --model <model>
```

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
| DeepSeek | `deepseek-flash` 系列（含已退役的 `deepseek-v4-flash` 别名及路由器日期快照，如 `deepseek-v4.1-flash-1017`）支持多模态；`deepseek-v4-pro` 与 V3 时代标识为纯文本 |
| Anthropic | `claude-(3\|sonnet-4\|opus-4)` 模式 |
| Ollama | `POST /api/show` 的 `capabilities`，并兼容旧版 `projector_info` / `.vision.` 元数据 |
| llama.cpp | `GET /props` → `modalities.vision`，支持自动 / 强制开启 / 关闭 |
| LM Studio | `GET /api/v1/models` → `capabilities.vision`；旧版本回退到 `/api/v0/models` 的 `type` |
| LocalAI | `GET /v1/models/capabilities` → `input_modalities` / `capabilities` |
| Jan / vLLM / SGLang | 显式 `supportsVision` 配置开关（通过 OpenAI 提供商） |

检测结果按提供商、精确模型和规范化基础 URL 绑定。并发检测会合并为一次请求，旧
配置的延迟响应不能修改当前设置。单独配置的视觉提供商继续使用现有的分流路径。

### Anthropic 转换

当激活的提供商是 Anthropic 时，智能体会转换 OpenAI 格式的消息：

| OpenAI 格式 | Anthropic 格式 |
|---|---|
| `system` 消息 | `system` 字段（顶级） |
| `assistant` + `tool_calls` | `assistant` + `tool_use` 内容块 |
| `tool` 角色 | `user` + `tool_result` 内容块 |
| `image_url`（data URL） | `image` 源块 |

### DeepSeek

出厂模型是 `deepseek-flash`（DeepSeek-V4.1-Flash，2026 年 10 月 17 日更新为 `-1017`
快照，API 与价格不变）。已退役的 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp`
仍由同一模型承接并按 Flash 计费；OpenRouter 等路由发布的日期快照
（`deepseek/deepseek-v4.1-flash-1017`）同样指向该模型，因此保留完整支持
（1M 上下文、384K 输出、图片输入）。其他 DeepSeek 标识（包括已退役的
`deepseek-v4-pro`）保持保守配置（64K 上下文、8K 输出、纯文本），不会继承它未必具备
的更大容量。

| 方面 | 行为 |
|---|---|
| 线路格式 | 默认 Chat Completions（`apiFormat: 'auto'`）；Responses API 需在「高级」面板显式选择 |
| 思考模式 | 顶层 `thinking` 对象 + `reasoning_effort`；关闭思考时完全省略 `reasoning_effort`。共享 UI 档位把 `minimal` 映射为 `low`、`medium`/`xhigh` 映射为 `high` |
| 思维链回传 | 跨轮回传 `reasoning_content`，因为带 `tools` 的后续请求丢弃它会返回 400 |
| 流式 | 每次请求都带 `stream_options.include_usage`；解析器忽略 DeepSeek 的 SSE `: keep-alive` 注释 |
| 结构化输出 | Chat Completions 使用 JSON Object 模式；Responses API 为规划器使用 `text.format` JSON Schema |
| 图片 | `deepseek-flash` 接受 `user` 消息中的 `image_url`（data URL 或公网 URL） |
| 计费 | 空闲时段单价按 1 USD = 7.1 CNY 折算（输入 1、缓存命中 0.02、输出 4；高峰 2 / 0.04 / 8）。缓存命中以顶层 `prompt_cache_hit_tokens` 返回，按缓存读取价计费 |
| Anthropic 端点 | `https://api.deepseek.com/anthropic` 可通过覆盖内置 `anthropic` 卡片的 base URL 使用 |

契约位于 `providers/deepseek-config.js`（纯函数与常量）与 `providers/deepseek.js`
（`DeepSeekProvider`）。共享的 `openai.js` 与 `provider-compatibility.js` 不含任何
DeepSeek 知识；`ProviderManager#_createProvider()` 会把 `deepseek` 卡片、任何指向
`api.deepseek.com` 的卡片，或显式选择 `deepseek` 兼容性预设的卡片分派给该专用类。

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
pm.getAll();                        // 所有提供商配置（用于提供商页面）
await pm.testProvider('openai');    // 测试连接
```

### 提供商搜索

提供商页面 LLM 标签页的搜索索引包括提供商 ID、标签、类型/类别、模型、Base URL、字段标签与占位符、建议项和兼容性选项。匹配卡片依次按提供商名称/ID 完全匹配、前缀匹配、子串匹配和仅字段匹配排序；同级结果保持原始提供商顺序，当前选中的提供商在类别筛选时始终可见。

### 配置持久化

配置存储在 `chrome.storage.local` 中的 `providers` 键下，与默认值合并。默认值提供结构（存在哪些提供商键）；存储的配置覆盖每个键的值。这使得引入新提供商条目的升级可以在用户不清空存储的情况下工作。

已弃用的提供商条目（`webbrain`、`openai_subscription`、`claude_subscription`）会被过滤掉。

### 费用限额

“设置 → 预算”提供会话和总云端费用限额。智能体优先使用提供商报告的 `usage.cost`/`usage.cost_usd` 值（OpenRouter 直接报告此值）。对于仅返回令牌计数的直接云端提供商，DIV 根据提供商配置字段估算费用：

- `inputCostPerMillionUsd`
- `cacheReadCostPerMillionUsd`
- `cacheWriteCostPerMillionUsd`（5 分钟或未注明时长的缓存写入）
- `cacheWrite1hCostPerMillionUsd`
- `outputCostPerMillionUsd`

OpenAI 将缓存读取与写入令牌都包含在输入令牌总数中（`prompt_tokens_details.cached_tokens` / `cache_write_tokens`，或 Responses API 的 `input_tokens_details` 等价字段），因此 DIV 会先减去这两部分，再对剩余令牌应用常规输入费率，并用 `cacheWriteCostPerMillionUsd` 为写入计价。Anthropic 和 Bedrock 分别报告常规输入、缓存读取和缓存写入，因此这些计数会作为独立的计费类别相加；它们还可以区分 5 分钟和 1 小时缓存写入。

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

视觉能力通过模型名称正则自动检测。如果提供商有已知的视觉模型集，请在 `openai.js` 的 `_modelNameSniffedVision()` 中扩展，或像 DeepSeek 那样新增厂商子类（`providers/deepseek.js`）。仅对接受 OpenAI 风格 `stream_options.include_usage` 的提供商设置 `supportsStreamUsageOptions: true`；当提供商在不接受该请求字段的情况下返回使用量时，请将其保持为 false。
