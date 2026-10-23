<p align="center">
  <img src="assets/logo-mark.png" alt="DIV 标志" width="92">
</p>

<h1 align="center">DIV</h1>

<p align="center">
  开源 AI 浏览器智能体：与网页对话、自动化浏览器任务，并使用你选择的 LLM 运行多步骤工作流。
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="从 Chrome 应用商店安装 DIV"></a>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="从 Firefox 浏览器附加组件安装 DIV"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="从 Microsoft Edge 加载项安装 DIV"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="docs/zh-CN/">文档</a> ·
  <a href="https://webbrain.one">官网</a> ·
  <a href="LICENSE">GPL-3.0-or-later</a>
</p>

![DIV 阅读页面、填写表单并下载文件](assets/webbrain-demo.gif)

DIV 是一个浏览器扩展，在标签页旁的侧边栏中放入一个 AI 智能体。你可以就当前页面
向它提问，也可以交给它一项任务，让它自己点击、输入、导航完成。它运行在你选择的模型
上 —— 本地的 llama.cpp 或 Ollama 服务、前沿云端 API，或者完全无需配置的内置托管选项。

## 安装

从 [Chrome 应用商店](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb)、
[Firefox 附加组件](https://addons.mozilla.org/en-US/firefox/addon/webbrain/) 或
[Edge 加载项](https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo)
安装。

<details>
<summary><b>或从源码加载</b></summary>

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

**Chrome** —— 打开 `chrome://extensions/`，启用**开发者模式**（右上角），点击
**加载已解压的扩展程序**，选择 `webbrain/src/chrome` 文件夹。

**Firefox** —— 打开 `about:debugging#/runtime/this-firefox`，点击**临时载入附加组件**，
选择 `src/firefox/manifest.json`。临时附加组件会在 Firefox 重启后被移除；永久安装需
通过 [addons.mozilla.org](https://addons.mozilla.org) 签名。

</details>

## 使用方法

点击 DIV 图标打开侧边栏，然后输入例如：

- 「总结这个页面」
- 「找出所有关于定价的链接」
- 「在搜索框中填入 'AI agents' 并点击搜索」
- 「导航到 github.com 并查找热门仓库」

三种模式控制智能体被允许做什么：

| 模式 | 能做什么 |
|---|---|
| **Ask** | 只读。读取页面、回答问题、抓取 URL。 |
| **Act** | 点击、输入、导航、上传、下载、填写表单。 |
| **Dev** | 增加页面源码、样式、控制台、网络和可逆的页面编辑。 |

## 选择模型

**DIV Compass 1.0** 是默认选项，无需 API 密钥或本地配置。

**本地模型** 同样无需 API 密钥。将 DIV 指向任意 OpenAI 兼容服务即可：

```bash
llama-server -m your-model.gguf --port 8080          # llama.cpp
ollama serve                                          # Ollama  → :11434/v1
vllm serve your-model --port 8000                     # vLLM    → :8000/v1
python -m sglang.launch_server --model-path your-model --port 30000
```

LM Studio（`:1234/v1`）、Jan（`:1337/v1`）、LocalAI（`:8080/v1`）和 GPT4All
（`:4891/v1`）用法相同。通用的**本地 OpenAI 兼容代理**卡片也支持 CLIProxyAPI
等带认证的回环网关；请参阅[安全代理配置](docs/zh-CN/providers-and-models.md#订阅代理示例cliproxyapi)。
请根据所选层级的系统提示、工具 schema、页面与对话历史以及所需输出，设置实际加载的上下文窗口。
**16k 是配置回退值，并非保证足够的最低容量；Compact 也不保证能放入 8k。**
Mid 和 Full 在历史积累之前就可能超过 16k；压缩历史无法缩小固定提示或工具 schema。
字符估算不等于模型的精确 tokenizer 计数；请参阅[上下文指南](docs/providers-and-models.md#local-providers)。
DIV 会为 llama.cpp、Ollama 和 LM Studio 自动检测真实窗口，
并在对话接近上限时自动压缩。此外还有预览版的
`ollama launch webbrain --model <model>` 交接。详见
[提供商与模型](docs/zh-CN/providers-and-models.md#本地提供商)。

**云端 API** —— OpenAI、Anthropic Claude、Google Gemini、Azure OpenAI、AWS Bedrock、
Mistral、DeepSeek、xAI Grok、MiniMax、Kimi、通义千问、z.ai GLM、Groq、Together、
Cloudflare、Nvidia NIM、Hugging Face、Fireworks、OpenRouter 等。设置中内置
**Chromium 上有 106 张提供商卡片**（Firefox 上有 105 张），其中包括无需端点的
本地 WebGPU 选项 —— 参见
[完整目录](docs/zh-CN/providers-and-models.md#扩展提供商目录)。

## 功能特性

- **读取任意页面** —— 文本、链接、表单、表格、PDF 和交互元素，基于可访问性树而非
  脆弱的选择器
- **对页面执行操作** —— 点击、输入、滚动、导航、上传、下载和校验表单，在有实质影响的
  操作前按站点弹出权限提示
- **Act 前规划** —— Act 与 Dev 可生成结构化计划，展示给你审批，并在任何工具运行前将
  已批准的计划固定到草稿板
- **多步骤智能体** —— 自主的工具调用循环，最多可配置 195 步（默认 130），达到上限时
  提供「继续」按钮
- **已保存的工作流** —— 将一次成功的运行变成可复用、不含具体值的工作流，可重跑、导出
  和分享
- **计划任务与监视** —— `/schedule` 安排稍后执行，`/watch` 轮询页面并在条件满足时行动
- **技能** —— 只在相关时才加载的可信指令与工具
- **智能上下文** —— 令牌感知的自动压缩、工具结果限制以及紧急溢出恢复
- **按标签页对话** —— 每个标签页拥有独立历史；可选的本地用户记忆保存你陈述的偏好
- **以阅读为先的侧边栏** —— 流式 Ask 回复、在回复增长时保持问题可见的浮动控件、复制
  按钮、页面检查横幅，以及运行中随时可用的停止按钮
- **默认确定性** —— 浏览器控制决策使用温度 `0.15`，Ask 使用 `0.3`，视觉截图描述使用 `0`

## 智能体工具

DIV 将**层级**与**模式**分开。层级（`compact`、`mid`、`full`）是按提供商设置的，
控制模型可见的工具数量 —— Compact 适合小型本地模型，Full 解锁 hover、drag-drop、
frames 和 shadow DOM。模式（`ask`、`act`、`dev`）控制用户允许的任务类型。

完整的「工具 × 层级」矩阵、WebMCP 说明和 Dev 模式诊断见
[智能体工具](docs/zh-CN/agent-tools.md)。

## 斜杠命令

在面板中输入 `/help` 查看完整签名与参数。最常用的几个：

| 命令 | 作用 |
|---------|--------------|
| `/ask` · `/act` · `/dev` · `/plan` | 发送前切换模式 |
| `/schedule [提示词]` | 创建计划任务 |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <条件与动作> [/beep]` | 轮询当前页面，在条件满足时行动 |
| `/workflow --save <名称>` | 将上一次成功的运行编译为可复用的工作流 |
| `/memory --add <文本>` | 保存一条用户偏好 |
| `/screenshot [--full-page]` | 捕获标签页，或完整可滚动页面 |
| `/record [--transcribe]` | 录制当前标签页，可选保存转录 |
| `/export [--traces \| --config]` | 下载对话、工具链或设置快照 |
| `/compact` · `/reset` · `/verbose` | 压缩上下文、清除对话、切换工具详情 |
| `/allow-api` | 按对话的覆盖，允许 `fetch_url` 在 UI 失败时执行变更操作 |

`/watch` 会立即执行第一次检查，之后每 60 秒轮询一次（`--secs` 接受 30–120）。诸如
「当出现新提交时」这类相对条件会在第一次检查时建立基线；`--keep` 会让监视持续运行，
并抑制同一稳定事件键的重复提示音。

完整参考（包括 `/dangerously-skip-permissions` 和运行捕获后缀）见
[斜杠命令](docs/zh-CN/slash-commands.md)。

## 键盘快捷键

Chrome 侧边面板快捷键在 DIV 侧边面板获得焦点时生效。

| 快捷键 | 作用 |
|----------|--------------|
| `Ctrl+/` 或 `Cmd+/` | 聚焦输入框 |
| `Ctrl+Shift+A` 或 `Cmd+Shift+A` | 切换到 Ask 模式 |
| `Ctrl+Shift+X` 或 `Cmd+Shift+X` | 切换到 Act 模式 |
| `Ctrl+Shift+D` 或 `Cmd+Shift+D` | 切换到 Dev 模式 |
| `Escape` | 停止当前运行，除非它只是关闭斜杠命令自动补全 |
| `Escape` 两次 | 从 DIV 或浏览器页面停止当前录制 |

## 文档

| | |
|---|---|
| [架构](docs/zh-CN/architecture.md) | 系统概览、轮次流程、子系统 |
| [智能体工具](docs/zh-CN/agent-tools.md) | 层级、模式与完整工具矩阵 |
| [斜杠命令](docs/zh-CN/slash-commands.md) | 所有命令与参数 |
| [提供商与模型](docs/zh-CN/providers-and-models.md) | Chromium 106 张、Firefox 105 张提供商卡片，本地配置、层级 |
| [技能](docs/zh-CN/skills.md) | 内置技能、导入、技能工具 |
| [安全模型](docs/zh-CN/security-model.md) | 权限、凭证、信任边界 |
| [提示注入防御](docs/zh-CN/prompt-injection-defense.md) | 防御层级与已知缺口 |
| [隐私与数据流](docs/zh-CN/privacy-and-data-flow.md) | 什么会离开浏览器，什么不会 |
| [可访问性树与引用](docs/zh-CN/accessibility-tree-and-refs.md) | 页面如何被读取和定位 |
| [站点适配器](docs/zh-CN/site-adapters.md) | 按站点的引导 |
| [导出与工作流格式](docs/export-and-workflow-formats.md) | `webbrain-config/1`、`webbrain-workflow/1`（英文） |
| [添加工具](docs/zh-CN/adding-a-tool.md) · [本地化](docs/zh-CN/localization.md) · [测试场景](docs/zh-CN/test-scenarios.md) | 贡献者指南 |

也提供 [English](docs/) 和 [Français](docs/fr/) 版本。

## 仓库结构

```
src/chrome/     Manifest V3 构建 —— service worker、chrome.scripting、sidePanel
src/firefox/    Manifest V2 构建 —— 背景页、executeScript、sidebar_action
docs/           设计与参考文档（en、zh-CN、fr）
lmstudio-plugin/  作为独立 LM Studio 插件的 fetch_url + research_url
web/            官网与文档站点
test/           Node 测试套件、LLM 场景基准、安全语料
```

两个构建之间几乎所有智能体代码都是共享的。差异之处见
[架构](docs/zh-CN/architecture.md)。

## 已知问题

**Firefox 明显弱于 Chrome。** Firefox 没有通过 `chrome.debugger` 提供的 Chrome
DevTools Protocol 等价物，因此 Firefox 构建没有 shadow-DOM 穿透、没有真正可信的鼠标
事件（某些 React/Vue 处理器不会触发）、没有封闭 shadow root 遍历、没有
`resolveSelector` 重试预算、没有 SPA 导航感知的重试，也没有 CDP 截图（改用
`tabs.captureVisibleTab`，仅对活动标签页有效）。站点适配器、视觉检测、循环检测、
自动截图循环以及 Compact 提示/工具集*确实*已镜像到 Firefox。某些单页应用在客户端
导航后也可能不会触发内容脚本重新注入。

## 贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。添加工具请遵循
[添加工具](docs/zh-CN/adding-a-tool.md) 中的检查清单。添加提供商请继承
`BaseLLMProvider`，实现 `chat()`（可选实现 `chatStream()`），并在
`providers/manager.js` 中注册 —— 两处改动都需要同时镜像到 `src/chrome/` 和
`src/firefox/`。所有提供商都归一化为 `{ content, toolCalls, usage }`；详见
[提供商与模型](docs/zh-CN/providers-and-models.md#添加一个提供商)。

近期变更见 [CHANGELOG.md](CHANGELOG.md)。

## LM Studio 插件

`fetch_url` 和 `research_url` 也作为独立的 [LM Studio](https://lmstudio.ai) 插件提供，
位于 [`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools)，面向希望在
LM Studio 聊天中使用网页抓取工具、又不想运行完整浏览器扩展的用户。纯 Node，无需
无头浏览器。

```bash
lms clone webbrain/web-tools
```

源代码：[`lmstudio-plugin/`](lmstudio-plugin/)。


## 贡献者

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## 引用

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {DIV: 开源 AI 浏览器智能体，用于与网页对话},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## 许可证

DIV 33.0.0 及更高版本采用 [GPL-3.0-or-later](LICENSE) 许可证，因为发布的
浏览器扩展捆绑并集成了采用 GPL 许可证的 Xapian/libzim WebAssembly 运行时。

由 [Emre Sokullu](https://emresokullu.com) 和[开源贡献者](https://github.com/webbrain-one/webbrain/graphs/contributors)用 ❤️ 构建。
