<p align="center">
  <img src="assets/logo-mark.png" alt="WebBrain 标志" width="92">
</p>

<h1 align="center">WebBrain</h1>

<p align="center">
  开源 AI 浏览器智能体：与网页对话、自动化浏览器任务，并使用你选择的 LLM 运行多步骤工作流。
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="从 Chrome 应用商店安装 WebBrain"></a>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="从 Firefox 浏览器附加组件安装 WebBrain"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="从 Microsoft Edge 加载项安装 WebBrain"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="https://webbrain.one">官网</a> ·
  <a href="LICENSE">MIT 许可证</a>
</p>

![Claude Chrome vs WebBrain](assets/webbrain-vs-claude-chrome.gif)

## 功能特性

- **页面读取** — 从任意页面提取文本、链接、表单、表格和交互元素
- **浏览器操作** — 点击、输入、滚动、导航以及与页面元素交互
- **Ask / Act / Dev 模式** — 默认只读；按需执行常规浏览器操作；Dev 提供页面检查、可逆编辑与诊断工具
- **Act 前规划** — Act 与 Dev 模式可以生成结构化计划，展示给你审批，然后在工具运行前将已批准的计划固定到草稿板
- **多步骤智能体** — 通过工具调用循环自主执行任务（可配置，默认 130 步）
- **从限制处继续** — 当智能体达到步数限制时，点击「继续」即可接着运行
- **多 LLM 提供商** — 支持本地与云端模型：
  - **WebBrain Cloud 1.0**（云端，默认）— 内置托管云选项，无需本地配置
  - **llama.cpp**（本地）— 无需 API 密钥。同时支持 **Ollama**、**LM Studio**、**Jan**、**vLLM** 和 **SGLang**
  - **OpenAI**（GPT-5.5 等）
  - **Anthropic Claude**（原生 API）
  - **Google Gemini**、**Mistral AI**、**DeepSeek**、**xAI Grok**、**Groq**
  - **MiniMax**、**阿里云（通义千问 Qwen）**
  - **Cloudflare Workers AI**、**Nvidia NIM**
  - **OpenRouter**（默认模型：`openrouter/free`；可访问 100+ 模型）
- **引导向导** — 首次启动的演练，涵盖 Act 模式安全性与提供商配置
- **侧边栏 UI** — 与浏览并存的简洁聊天界面
- **按标签页对话** — 每个标签页拥有独立的聊天历史
- **流式输出** — 所有提供商的实时令牌流式传输
- **智能上下文** — 令牌感知的自动压缩（当对话接近模型上下文窗口时汇总较早的轮次，并显示「上下文已自动压缩」提示）、工具结果限制以及紧急溢出恢复
- **浏览器历史控制** — Act 模式可以使用原生 `go_back` / `go_forward` 历史工具，而不是受 CSP 影响的页面 JavaScript
- **API 快捷提示** — 重复点击触发相同 XHR/fetch 请求时，可显示匹配的 `fetch_url` 建议，同时保留 UI 优先和 `/allow-api` 变更策略
- **复制支持** — 代码块与完整消息上的复制按钮
- **页面检查横幅** — 智能体与页面交互时的可视化指示
- **停止按钮** — 随时中止运行中的智能体
- **确定性 Act 模式** — Act 模式对浏览器控制决策使用温度 `0.15`；Ask 模式使用 `0.3`，专用的视觉截图描述使用 `0`

## 快速开始

### Chrome

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. 打开 Chrome → `chrome://extensions/`
2. 启用 **开发者模式**（右上角）
3. 点击 **加载已解压的扩展程序** → 选择 `webbrain/src/chrome` 文件夹

### Firefox

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. 打开 Firefox → `about:debugging#/runtime/this-firefox`
2. 点击 **临时载入附加组件**
3. 进入 `src/firefox/` 并选择 `manifest.json`

> **注意：** 临时附加组件会在 Firefox 重启后被移除。如需永久安装，扩展需通过 [addons.mozilla.org](https://addons.mozilla.org) 签名。

### 启动本地 LLM（默认）

```bash
# 使用 llama.cpp
llama-server -m your-model.gguf --port 8080

# 或使用 Ollama（OpenAI 兼容）
ollama serve
# 然后在设置中将 base URL 设为 http://localhost:11434/v1

# 或使用 Jan（OpenAI 兼容）
# 启动 Jan 的本地 API 服务器，并使用 http://localhost:1337/v1

# 或使用 vLLM / SGLang（OpenAI 兼容）
vllm serve your-model --port 8000
python -m sglang.launch_server --model-path your-model --port 30000
```

> **上下文窗口：** 为保证智能体可靠运行，请加载至少具有 **16k 令牌上下文窗口** 的本地模型（可用最小值）。8k 在启用 **压缩模式** 时可工作（设置 → 每个提供商的 Prompt tier）；4k 太小，无法容纳系统提示 + 工具模式。WebBrain 会在接近窗口时自动压缩对话。本地提供商默认 16k，除非你在设置中指定大小。**测试连接** / **加载模型** 会为 **llama.cpp**、**Ollama** 和 **LM Studio** 在后端报告时自动检测真实窗口（llama.cpp `/props`、Ollama `/api/ps` 然后 `/api/show` 的 `num_ctx`、LM Studio `/api/v0/models`）。检测会刷新默认 16k；仅在来自实时/运行时上下文时才会缩小更大的手动覆盖（llama.cpp `/props`、Ollama `/api/ps`、LM Studio 已加载上下文）。其他本地后端（Jan、vLLM、SGLang、LocalAI）保留手动/默认值。

### 使用方法

点击 WebBrain 图标 → 侧边栏打开。输入消息，例如：

- “总结这个页面”
- “找出所有关于定价的链接”
- “在搜索框中填入 'AI agents' 并点击搜索”
- “导航到 github.com 并查找热门仓库”

## 配置

点击齿轮图标或前往扩展的选项页面进行配置：

**显示设置：**
- 详细模式 — 显示完整的工具调用 JSON（默认关闭）
- 截图回退 — 当 DOM 读取失败时使用截图
- 最大智能体步数 — 可配置的步数限制（5-200，默认 60）
- Act 前规划 — 可选择在浏览器工具运行前生成并审阅结构化的 Act 模式计划（默认关闭）

**提供商：**

在设置中选择提供商时会预填 Base URL。本地服务使用下方默认端口。

| 提供商 | API 密钥 | 默认模型 |
|--------|----------|----------|
| llama.cpp (`:8080`) | 无需 | （你加载的模型） |
| Ollama (`:11434/v1`) | 无需 | （你加载的模型） |
| LM Studio (`:1234/v1`) | 无需 | （你加载的模型） |
| Jan (`:1337/v1`) | 无需 | （你加载的模型） |
| vLLM (`:8000/v1`) | 可选 | （你提供服务的模型） |
| SGLang (`:30000/v1`) | 可选 | （你提供服务的模型） |
| LocalAI (`:8080/v1`) | 可选 | （你加载的模型） |
| OpenAI | 必需 | gpt-5.5 |
| Anthropic Claude | 必需 | claude-sonnet-4-6 |
| Google Gemini | 必需 | gemini-3.1-flash |
| Cloudflare Workers AI | 必需（+ Account ID） | @cf/zai-org/glm-5.2 |
| Mistral AI | 必需 | mistral-large-latest |
| DeepSeek | 必需 | deepseek-v4-flash |
| xAI Grok | 必需 | grok-4.3 |
| Nvidia NIM | 必需 | meta/llama-3.1-8b-instruct |
| Groq | 必需 | llama-3.3-70b-versatile |
| MiniMax | 必需 | minimax-m2.7 |
| 阿里云（通义千问 Qwen） | 必需 | qwen-max |
| OpenRouter | 必需 | openrouter/free |

## 架构

```
src/chrome/                        src/firefox/
├── manifest.json (MV3)            ├── manifest.json (MV2)
├── src/                           ├── src/
│   ├── background.js              │   ├── background.js (+ background.html)
│   ├── agent/                     │   ├── agent/
│   ├── content/                   │   ├── content/
│   ├── providers/                 │   ├── providers/
│   ├── network/                   │   ├── network/
│   ├── trace/                     │   ├── trace/
│   ├── ui/                        │   └── ui/
│   └── offscreen/                 ├── styles/
├── styles/                        ├── icons/
└── icons/                         └── LICENSE

web/
├── index.html
├── privacy.html
└── vercel.json
```

关键区别：Chrome 使用 Manifest V3（service worker、`chrome.scripting`、`sidePanel` API），Firefox 使用 Manifest V2（背景页、`browser.tabs.executeScript`、`sidebar_action`）。

更深入的文档位于 [`docs/`](docs/)：[架构](docs/architecture.md)、[站点适配器](docs/site-adapters.md)、[提供商与模型](docs/providers-and-models.md)、[安全模型](docs/security-model.md)、[提示注入防御](docs/prompt-injection-defense.md)、[隐私与数据流](docs/privacy-and-data-flow.md)、[可访问性树与引用](docs/accessibility-tree-and-refs.md)、[本地化](docs/localization.md)、[添加工具](docs/adding-a-tool.md) 以及 [测试场景](docs/test-scenarios.md)。

## 智能体工具

WebBrain 将模型层级与对话模式分开：

- **层级**（`compact`、`mid`、`full`）控制模型可见的常规浏览器工具数量。
- **模式**（`ask`、`act`、`dev`）控制用户允许的任务类型。Ask 为只读。Act 暴露所选层级的常规工具。Dev 需要 Mid/Full 提供商，并附加源码/样式/调试工具（Mid 层级 Dev 还包含更深的 DOM/frame 检查）。

图例：**是** = 可用 · **-** = 不可用 · **C** = 仅 Chrome · **Dev** = Dev 模式附加（Mid/Full 提供商；不含 Compact）。

| 工具 | Ask | Compact | Mid | Full | Dev |
|------|:---:|:-------:|:---:|:----:|:---:|
| `get_accessibility_tree` | 是 | 是 | 是 | 是 | - |
| `read_page` | 是 | 是 | 是 | 是 | - |
| `read_pdf` | 是 | 否 | 是 | 是 | - |
| `read_page_source` | 否 | 否 | 否 | 否 | 是 |
| `get_window_info` | 是 | 是 | 是 | 是 | - |
| `get_interactive_elements` | 是 | 否 | 是 | 是 | - |
| `scroll` | 是 | 是 | 是 | 是 | - |
| `extract_data` | 是 | 是 | 是 | 是 | - |
| `inspect_element_styles` | 否 | 否 | 否 | 否 | 是 |
| `wait_for_stable` | 是 | 否 | 是 | 是 | - |
| `get_selection` | 是 | 是 | 是 | 是 | - |
| `done` | 是 | 是 | 是 | 是 | - |
| `clarify` | 否 | 是 | 是 | 是 | - |
| `fetch_url` | 是 | 是 | 是 | 是 | - |
| `research_url` | 是 | 否 | 是 | 是 | - |
| `list_downloads` | 是 | 否 | 是 | 是 | - |
| `click_ax` | 否 | 是 | 是 | 是 | - |
| `type_ax` | 否 | 是 | 是 | 是 | - |
| `set_field` | 否 | 是 | 是 | 是 | - |
| `resize_window` | 否 | 否 | 否 | 是 | - |
| `click` | 否 | 是 | 是 | 是 | - |
| `type_text` | 否 | 是 | 是 | 是 | - |
| `press_keys` | 否 | 是 | 是 | 是 | - |
| `navigate` | 否 | 是 | 是 | 是 | - |
| `wait_for_element` | 否 | 是 | 是 | 是 | - |
| `new_tab` | 否 | 是 | 是 | 是 | - |
| `scratchpad_write` | 否 | 是 | 是 | 是 | - |
| `progress_update` | 否 | 是 | 是 | 是 | - |
| `progress_read` | 否 | 是 | 是 | 是 | - |
| `download_social_media` | 否 | 否 | 是 | 是 | - |
| `solve_captcha` | 否 | 否 | 是 | 是 | - |
| `go_back` | 否 | 否 | 是 | 是 | - |
| `go_forward` | 否 | 否 | 是 | 是 | - |
| `schedule_resume` | 否 | 否 | 是 | 是 | - |
| `schedule_task` | 否 | 否 | 是 | 是 | - |
| `iframe_read` | 否 | 否 | 是 | 是 | - |
| `iframe_click` | 否 | 否 | 是 | 是 | - |
| `iframe_type` | 否 | 否 | 是 | 是 | - |
| `read_downloaded_file` | 否 | 否 | 是 | 是 | - |
| `download_files` | 否 | 否 | 是 | 是 | - |
| `download_resource_from_page` | 否 | 否 | 是 | 是 | - |
| `upload_file` | 否 | 否 | C | C | - |
| `verify_form` | 否 | 否 | 是 | 是 | - |
| `hover` | 否 | 否 | 否 | 是 | - |
| `drag_drop` | 否 | 否 | 否 | 是 | - |
| `get_shadow_dom` | 否 | 否 | 否 | 是 | 是 |
| `shadow_dom_query` | 否 | 否 | 否 | C | C |
| `get_frames` | 否 | 否 | 否 | 是 | 是 |
| `inject_css` | 否 | 否 | 否 | 否 | C |
| `remove_injected_css` | 否 | 否 | 否 | 否 | C |
| `patch_element` | 否 | 否 | 否 | 否 | C |
| `revert_patch` | 否 | 否 | 否 | 否 | C |
| `execute_js` | 否 | 否 | 否 | 否 | 是 |
| `read_console` | 否 | 否 | 否 | 否 | C |
| `inspect_network_requests` | 否 | 否 | 否 | 否 | C |
| `inspect_event_listeners` | 否 | 否 | 否 | 否 | C |
| `highlight_element` | 否 | 否 | 否 | 否 | C |

已加载的技能可为当前运行追加工具 schema。例如内置 FreeSkillz.xyz 可暴露 `read_youtube_transcript`（YouTube 字幕）以及 `resolve_public_media` / `download_public_media`（公开媒体 URL）。这些技能工具未硬编码在上表中：技能加载前（或被移除后）不存在。即使所属技能已加载，Ask 仍会过滤变更/下载类工具。

Dev 工具仅在 Dev 模式暴露，且 Compact 层级提供商无法使用 Dev。Chrome 的可逆编辑工具返回 patch ID：`inject_css` 对应 `remove_injected_css`，`patch_element` 对应 `revert_patch`。

### Dev 模式页面编辑与诊断

- `inject_css` / `remove_injected_css` 通过 `patchId` 应用与撤销临时 CSS。每个 patch 唯一且绑定到确切文档；导航会使旧句柄失效。
- `patch_element` / `revert_patch` 以精确前后值修改内联样式、类与属性。`highlight_element` 提供临时目标覆盖层。
- `execute_js` 在页面主世界执行异步 JavaScript 函数体。Chrome 使用 CDP `Runtime.evaluate`（15 秒限制）；Firefox 使用 MV2 内容脚本求值器。需主机权限与新的提交确认。
- `read_console`、`inspect_network_requests`、`inspect_event_listeners` 在 Chrome 上提供有界诊断。默认省略网络头/正文；敏感头会脱敏；页面派生输出按不可信内容处理。

**Compact 层级**：精简工具集 + 更短系统提示，面向小型本地模型。**Mid 层级**：常见任务工具、iframe、下载、调度与表单校验。**Full 层级**：hover、drag-drop、frames 与 shadow DOM。在设置中按提供商启用层级。

> **Shadow DOM 注意：** 可访问性树仅遍历 light DOM。在大量使用 Web 组件的页面（Stripe、Salesforce、Shopify）上，请先使用 `get_interactive_elements`；在 Full Act 或 Dev 模式下使用 `get_shadow_dom` / `shadow_dom_query` 做定向读取。

## LM Studio 插件

`fetch_url` 和 `research_url` 工具也作为独立的
[LM Studio](https://lmstudio.ai) 插件提供，位于
[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools)，面向
希望在 LM Studio 聊天中使用网页获取工具调用、又不想
运行完整浏览器扩展的用户。纯 Node，无需无头浏览器。

```bash
lms clone webbrain/web-tools
```

源代码：[`lmstudio-plugin/`](./lmstudio-plugin/)。

## 斜杠命令

WebBrain 接受作为输入框某行开头的斜杠命令。在面板内输入 `/help` 可查看完整用法和参数说明。输入规范命令并加一个空格后，自动补全会显示该命令可用的参数。

| 命令 | 作用 |
|---------|--------------|
| `/help` | 显示可用命令列表 |
| `/schedule [提示词]` | 创建计划任务，并可预填提示词 |
| `/schedule --list` | 显示计划任务 |
| `/progress` | 显示当前进度记录 |
| `/scratchpad` | 显示当前草稿板 |
| `/scratchpad --append <文本>` | 将文本追加到当前草稿板 |
| `/scratchpad --clear` | 清除当前草稿板 |
| `/memory` | 显示已保存的用户记忆 |
| `/memory --add <文本>` | 将用户偏好保存到记忆 |
| `/memory --forget <id>` | 按 ID 删除一条记忆 |
| `/allow-api` | **按对话的 API 变更覆盖。** 解除 UI 优先限制，使智能体在 UI 失败时可通过 `fetch_url` 使用 POST/PUT/PATCH/DELETE。激活时显示徽章；在 `/reset` 时清除。 |
| `/compact` | 强制压缩当前对话上下文 |
| `/verbose` | 切换详细/压缩工具显示（与工具栏按钮相同） |
| `/reset` | 清除对话与所有按对话的标志 |
| `/screenshot [--full-page]` | 捕获可见标签页；使用 `--full-page` 捕获完整页面（仅 Chrome） |
| `/record [--full-screen] [--transcribe]` | 录制当前标签页；使用 `--full-screen` 录制屏幕或窗口（仅 Chrome），使用 `--transcribe` 保存转录 |
| `/export [--traces]` | 将对话下载为 Markdown；使用 `--traces` 导出工具链 |
| `/profile` | 无需打开设置即可切换资料自动填充开/关 |
| `/vision` | 在当前提供商上切换视觉模式（截图理解） |
| `/ask` | 发送前切换到提问模式 |
| `/dev` | 发送前切换到 Dev 模式 |
| `/plan` | 以规划意图切换到提问模式 |

默认的 UI 优先规则之所以存在，是因为 API 操作是不可见的（你看不到发送了什么内容），通常需要你可能尚未配置的独立认证令牌，并且其影响范围可能比一次可见的误点击大得多。只有当你已为某项特定工作权衡决定接受该取舍时，才使用 `/allow-api`。

## 键盘快捷键

Chrome 侧边面板快捷键在 WebBrain 侧边面板获得焦点时生效。

| 快捷键 | 作用 |
|----------|--------------|
| `Ctrl+/` 或 `Cmd+/` | 聚焦输入框 |
| `Ctrl+Shift+A` 或 `Cmd+Shift+A` | 切换到 Ask 模式 |
| `Ctrl+Shift+X` 或 `Cmd+Shift+X` | 切换到 Act 模式 |
| `Ctrl+Shift+D` 或 `Cmd+Shift+D` | 切换到 Dev 模式 |
| `Escape` | 停止当前运行，除非它只是关闭斜杠命令自动补全 |
| `Escape` 两次 | 从 WebBrain 或浏览器页面停止当前录制 |

## 已知问题

- **Firefox 明显弱于 Chrome。** Firefox 没有通过 `chrome.debugger` 提供的 Chrome DevTools Protocol 等价物，因此 Firefox 构建中缺少若干 Chrome 独有功能：
  - 点击/输入通过内容脚本路径（`document.querySelector` + `el.click()`）而非 CDP `Input.dispatchMouseEvent`。这意味着 **无 shadow-DOM 穿透**、**无真正可信的鼠标事件**（某些 React/Vue 处理器不会触发）、**无封闭 shadow root 遍历**，以及 **无 `resolveSelector` 重试预算**。
  - **无 SPA 导航感知的重试扩展。**
  - **无跨后台重启的对话持久化。**
  - **无 CDP 截图。** 自动截图改用 `tabs.captureVisibleTab`，仅对活动标签页有效，且质量略低。
  - **读取/提取工具无封闭 shadow root 支持。**
  - 站点适配器、视觉检测、循环检测、自动截图循环以及可选的压缩提示/工具集 *确实* 已镜像到 Firefox。
- **Firefox 中的 SPA 导航检测。** 某些单页应用在客户端导航后可能不会触发内容脚本重新注入。
- **Firefox 临时附加组件** — Firefox 在开发期间要求扩展作为临时附加组件加载，重启后会被移除。

## 更新内容

完整版本历史见 [CHANGELOG.md](./CHANGELOG.md)。近期亮点包括 Act 前规划、原生浏览器历史工具、重复点击 API 快捷提示、WebBrain Cloud 1.0、计划任务、压缩模式改进以及原生 PDF 读取。

## 添加新提供商

1. 在 `src/providers/` 中创建一个扩展 `BaseLLMProvider` 的新类
2. 实现 `chat()`，并可选实现 `chatStream()`
3. 在 `src/providers/manager.js` 中注册

所有提供商都归一化为通用响应格式：
```js
{ content: string, toolCalls: Array|null, usage: Object|null }
```

## Star History

<a href="https://www.star-history.com/?repos=webbrain-one%2Fwebbrain&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&legend=top-left" />
 </picture>
</a>


## 引用

如果您在研究或项目中使用 WebBrain，请引用:

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {WebBrain: 开源 AI 浏览器智能体，用于与网页对话},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## 许可证

MIT — 由 [Emre Sokullu](https://emresokullu.com) 构建
