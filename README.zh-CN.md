# WebBrain

[![Lang](https://img.shields.io/badge/Lang-English-blue)](README.md)
[![Lang](https://img.shields.io/badge/Lang-中文-red)](README.zh-CN.md)
[![Lang](https://img.shields.io/badge/Lang-Français-blueviolet)](README.fr.md)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

![Claude Chrome vs WebBrain](assets/webbrain-vs-claude-chrome.gif)

开源的 Chrome 和 Firefox AI 浏览器智能体。与任意网页对话、自动化浏览器任务，并运行多步骤的智能体工作流——由你选择的 LLM 驱动。

## 功能特性

- **页面读取** — 从任意页面提取文本、链接、表单、表格和交互元素
- **浏览器操作** — 点击、输入、滚动、导航以及与页面元素交互
- **Ask / Act 模式** — 默认只读模式，完整智能体模式需确认
- **Act 前规划** — Act 模式可以生成结构化计划，展示给你审批，然后在工具运行前将已批准的计划固定到草稿板
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
  - **OpenRouter**（默认模型：`stepfun/step-3.7-flash`；可访问 100+ 模型）
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

> **上下文窗口：** 为保证智能体可靠运行，请加载至少具有 **16k 令牌上下文窗口** 的本地模型（可用最小值）。8k 在启用 **压缩模式** 时可工作（设置 → 每个提供商的复选框）；4k 太小，无法容纳系统提示 + 工具模式。WebBrain 会在接近窗口时自动压缩对话——除非你设置了明确的上下文大小，否则它会为本地模型假设 16k，因此请给模型服务器（例如 `llama-server -c 16384`）留足空间。

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

| 提供商 | Base URL | API 密钥 | 默认模型 |
|----------|----------|---------|---------------|
| llama.cpp | `http://localhost:8080` | 无需 | （你加载的模型） |
| Ollama | `http://localhost:11434/v1` | 无需 | （你加载的模型） |
| LM Studio | `http://localhost:1234/v1` | 无需 | （你加载的模型） |
| Jan | `http://localhost:1337/v1` | 无需 | （你加载的模型） |
| vLLM | `http://localhost:8000/v1` | 可选 | （你提供服务的模型） |
| SGLang | `http://localhost:30000/v1` | 可选 | （你提供服务的模型） |
| OpenAI | `https://api.openai.com/v1` | 必需 | gpt-5.5 |
| Anthropic Claude | `https://api.anthropic.com` | 必需 | claude-sonnet-4-6 |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | 必需 | gemini-3.1-flash |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` | 必需（另需 Account ID） | @cf/zai-org/glm-5.2 |
| Mistral AI | `https://api.mistral.ai/v1` | 必需 | mistral-large-latest |
| DeepSeek | `https://api.deepseek.com/v1` | 必需 | deepseek-v4-flash |
| xAI Grok | `https://api.x.ai/v1` | 必需 | grok-4.3 |
| Nvidia NIM | `https://integrate.api.nvidia.com/v1` | 必需 | meta/llama-3.1-8b-instruct |
| Groq | `https://api.groq.com/openai/v1` | 必需 | llama-3.3-70b-versatile |
| MiniMax | `https://api.minimax.chat/v1` | 必需 | minimax-m2.7 |
| 阿里云（通义千问 Qwen） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 必需 | qwen-max |
| OpenRouter | `https://openrouter.ai/api/v1` | 必需 | stepfun/step-3.7-flash |

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

| 工具 | Ask | Act | Compact | 描述 |
|------|-----|-----|---------|-------------|
| `get_accessibility_tree` | 是 | 是 | 是 | 带持久 ref_id 的页面可访问性树的扁平缩进文本 |
| `read_page` | 是 | 是 | 是 | 提取页面文本、链接、表单（旧版纯文本回退） |
| `read_pdf` | 是 | 是 | -- | 通过内置 pdfjs-dist 从 PDF 文档提取文本 |
| `screenshot` | 是 | 是 | 是 | 捕获可见标签页（可选 `save:true` 保存到下载） |
| `full_page_screenshot` | 是 | 是 | -- | 捕获完整可滚动页面（仅 Chrome） |
| `get_interactive_elements` | 是 | 是 | -- | 列出所有可点击/交互元素（旧版，穿透 shadow DOM） |
| `get_frames` | 是 | 是 | -- | 列出页面上的所有 iframe |
| `get_shadow_dom` | 是 | 是 | -- | 读取 shadow DOM 树 |
| `scroll` | 是 | 是 | 是 | 滚动页面 |
| `extract_data` | 是 | 是 | 是 | 提取表格、标题、图片 |
| `get_selection` | 是 | 是 | 是 | 获取高亮文本 |
| `click_ax` | -- | 是 | 是 | 通过可访问性树 ref_id 点击元素（首选） |
| `type_ax` | -- | 是 | 是 | 通过 ref_id 向字段输入。支持 `lang: "tr-deasciify"` |
| `set_field` | -- | 是 | 是 | 通过 ref_id 一次性聚焦 + 清空 + 输入 + 验证。支持 `lang: "tr-deasciify"` |
| `click` | -- | 是 | 是 | 通过选择器、索引或坐标点击元素（旧版回退） |
| `type_text` | -- | 是 | 是 | 向输入字段输入。支持 `lang: "tr-deasciify"` |
| `press_keys` | -- | 是 | 是 | 按 Escape、Tab 或 Enter |
| `hover` | -- | 是 | -- | 用于悬停显示菜单的 CDP 可信悬停（仅 Chrome） |
| `drag_drop` | -- | 是 | -- | 通过 CDP 指针事件拖放（仅 Chrome） |
| `navigate` | -- | 是 | 是 | 前往某个 URL |
| `go_back` | -- | 是 | -- | 在当前标签页的浏览器历史中后退 |
| `go_forward` | -- | 是 | -- | 在当前标签页的浏览器历史中前进 |
| `new_tab` | -- | 是 | 是 | 打开新标签页 |
| `wait_for_element` | -- | 是 | 是 | 等待选择器出现 |
| `wait_for_stable` | -- | 是 | -- | 等待页面空闲（无 DOM 变化 + 无网络） |
| `upload_file` | -- | 是 | -- | 向文件输入上传文件（仅 Chrome） |
| `execute_js` | -- | 是 | -- | 运行自定义 JavaScript（**仅 Firefox** — Chrome 上被 MV3 CSP 阻止） |
| `fetch_url` | 是 | 是 | 是 | 在后台使用用户的 cookie 获取 URL |
| `research_url` | 是 | 是 | -- | 在隐藏标签页中打开 URL，等待 JS 渲染，返回内容 |
| `download_files` | -- | 是 | -- | 下载一个或多个文件（单个 url 或数组，最多 3 个并发） |
| `download_resource_from_page` | -- | 是 | -- | 从当前页面下载 `<img>`/`<video>`/blob URL |
| `download_social_media` | -- | 是 | 是 | 一次性社交媒体下载；优先 DOM/CDN，可选可见媒体视觉裁剪回退 |
| `list_downloads` | 是 | 是 | -- | 列出最近的下载，含状态与来源 URL |
| `read_downloaded_file` | -- | 是 | -- | 重新获取已下载文件的内容（文本或 base64） |
| `iframe_read` / `iframe_click` / `iframe_type` | -- | 是 | -- | 读取/点击/输入跨域 iframe 内部 |
| `record_tab` / `stop_recording` | -- | 是 | -- | 将标签页视频+音频录制为 .webm，可选 Whisper 转写（仅 Chrome） |
| `scratchpad_write` | 是 | 是 | 是 | 在上下文中固定一条在汇总后仍保留的笔记 |
| `clarify` | 是 | 是 | 是 | 暂停并向用户提问 |
| `verify_form` | -- | 是 | -- | 提交前验证表单字段 |
| `solve_captcha` | -- | 是 | 是 | 通过 CapSolver API 解决验证码（可选，需 API 密钥） |
| `done` | 是 | 是 | 是 | 标记任务完成 |

**压缩模式** 是为小型本地模型（2B-8B）设计的精简工具集 + 更短系统提示。在 Chrome 和 Firefox 构建中，它将 Act 模式的工具模式从 40+ 个削减到约 20 个，减少决策面与幻觉。在设置中按提供商启用（本地提供商上的复选框；默认关闭）。

> **Shadow DOM 注意：** 可访问性树仅遍历 light DOM。在大量使用 Web 组件的页面（Stripe、Salesforce、Shopify）上，请使用 `get_interactive_elements`（穿透开放 shadow root）或 `get_shadow_dom` / `shadow_dom_query` 进行定向读取。

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

WebBrain 接受作为输入框某行开头的斜杠命令。在面板内输入 `/help` 查看列表。

| 命令 | 作用 |
|---------|--------------|
| `/help` | 显示可用命令列表 |
| `/schedule` | 创建计划任务 |
| `/list-schedules` | 显示计划任务 |
| `/show-scratchpad` | 显示当前草稿板 |
| `/edit-scratchpad <文本>` | 将文本追加到当前草稿板 |
| `/clear-scratchpad` | 清除当前草稿板 |
| `/allow-api` | **按对话的 API 变更覆盖。** 解除 UI 优先限制，使智能体在 UI 失败时可通过 `fetch_url` 使用 POST/PUT/PATCH/DELETE。激活时显示徽章；在 `/reset` 时清除。 |
| `/compact` | 强制压缩当前对话上下文 |
| `/verbose` | 切换详细/压缩工具显示（与工具栏按钮相同） |
| `/reset` | 清除对话与所有按对话的标志 |
| `/screenshot` | 捕获可见标签页并在聊天中内联显示图像 |
| `/record` | 开始录制当前标签页 |
| `/export` | 将当前对话下载为 Markdown 文件 |
| `/profile` | 无需打开设置即可切换资料自动填充开/关 |
| `/vision` | 在当前提供商上切换视觉模式（截图理解） |
| `/ask` | 发送前切换到提问模式 |
| `/plan` | 以规划意图切换到提问模式 |

默认的 UI 优先规则之所以存在，是因为 API 操作是不可见的（你看不到发送了什么内容），通常需要你可能尚未配置的独立认证令牌，并且其影响范围可能比一次可见的误点击大得多。只有当你已为某项特定工作权衡决定接受该取舍时，才使用 `/allow-api`。

## 键盘快捷键

Chrome 侧边面板快捷键在 WebBrain 侧边面板获得焦点时生效。

| 快捷键 | 作用 |
|----------|--------------|
| `Ctrl+/` 或 `Cmd+/` | 聚焦输入框 |
| `Ctrl+Shift+A` 或 `Cmd+Shift+A` | 切换到 Ask 模式 |
| `Ctrl+Shift+X` 或 `Cmd+Shift+X` | 切换到 Act 模式 |
| `Escape` | 停止当前运行，除非它只是关闭斜杠命令自动补全 |

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

## 路线图

- [X] **对话导出/~~导入~~** — 保存~~与加载~~聊天历史（仅添加了导出，导入不再计划）
- [ ] **自定义工具定义** — 通过设置定义用户自定义工具
- [X] **键盘快捷键** — 用于打开面板、发送消息、切换模式的热键
- [X] **右键菜单集成** — 右键 → “向 WebBrain 询问此内容”
- [X] **截图/视觉工具** — 将截图发送给多模态模型以进行视觉理解
- [X] **Chrome 应用商店 / Firefox AMO** — 官方商店上架

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


## 许可证

MIT — 由 [Emre Sokullu](https://emresokullu.com) 构建
