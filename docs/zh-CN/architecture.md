# WebBrain 架构

> 版本 18.0.0

## 概述

WebBrain 是一个浏览器扩展，让 LLM 能够控制用户当前活动的浏览器标签页。用户在侧面板中输入自然语言指令，自主代理循环调用 LLM，执行工具调用（点击、输入、导航、读取页面状态等），将结果反馈给 LLM，并重复此过程直到任务完成。

有两个构建版本共享几乎相同的代码：
- **Chrome** — Manifest V3，Service Worker，基于 CDP 的受信任事件
- **Firefox** — Manifest V2，后台页面，仅合成事件

本文档涵盖共享架构，并指出两个构建版本的分歧之处。

---

## 分层架构

```
┌─────────────────────────────────────────────────────┐
│                   侧面板（UI）                        │
│  sidepanel.js  ·  settings.js  ·  traces.js          │
│  locale: i18n.js / locales/*.js                      │
└──────────────┬──────────────────────────────────────┘
               │ chrome.runtime.sendMessage({action, ...})
               ▼
┌─────────────────────────────────────────────────────┐
│             后台脚本 / Service Worker                │
│                                                      │
│  background.js        — 消息路由器                    │
│    └─ agent.js        — 代理循环 + executeTool()     │
│         ├─ tools.js   — 工具模式 + 系统提示           │
│         ├─ planner.js — 先计划后行动的 JSON 规划器    │
│         ├─ adapters.js— 站点特定指南                  │
│         ├─ permission-gate.js — 能力授权              │
│         ├─ credential-fields.js — 秘密检测            │
│         ├─ captcha-solver.js — CapSolver 集成        │
│         ├─ loop-bucket.js — URL 族循环分桶            │
│         └─ pdf-tools.js — PDF 文本提取                │
│    ├─ providers/       — LLM 提供商抽象层             │
│    ├─ network/         — fetch_url, 下载             │
│    ├─ trace/           — 可选的 IndexedDB 记录器      │
│    └─ recorder/        — 标签页录制编排               │
│                                                      │
│  仅 Chrome：                                          │
│    ├─ cdp/             — Chrome 开发者工具协议        │
│    └─ offscreen/       — fetch 代理 + 标签页录制      │
└──────┬──────────────────────────────────────────────┘
       │ chrome.scripting.executeScript / CDP
       ▼
┌─────────────────────────────────────────────────────┐
│                内容脚本（注入）                        │
│                                                      │
│  accessibility-tree.js  — AX 树构建器 + ref_ids      │
│  content.js             — DOM 读取器、点击器、输入器  │
│  agent-visual-indicator.js — 脉冲边框 + 停止按钮      │
└─────────────────────────────────────────────────────┘
```

### 侧面板（`src/ui/sidepanel.js`）

聊天 UI。通过 `chrome.runtime.sendMessage`（Firefox 上为 `browser.runtime.sendMessage`）与后台脚本通信。支持三种对话模式：

- **Ask 模式** — 仅语义/只读工具（`tools.js` 中的 `ASK_ONLY_TOOLS`）。代理可以读取、分析和总结，但从不点击、输入或导航。Ask 故意排除了开发者/调试读取工具，如 `read_page_source`、`inspect_element_styles` 和 `clarify` 工具；普通的澄清就是普通聊天。
- **Act 模式** — 所选提供商层级的标准浏览器代理工具。代理可以在浏览器中执行实际操作。
- **Dev 模式** — 用于页面调试和 HTML/CSS 检查的操作模式。Dev 需要 Mid 或 Full 提供商层级，使用所选 Act 提示层级，然后附加 Dev 提示附录并暴露 Dev 附加组件，如源码/样式工具。Compact 层级的提供商无法进入 Dev 模式。

模型分层与模式分离：`compact | mid | full` 控制模型看到多少普通工具，而 `ask | act | dev` 控制用户允许的任务类型。

用户输入消息，面板发送 `{action: 'chat', text, mode, tabId}` 到后台，然后监听运行期间流式返回的 `agent_update` 事件。面板逐步渲染工具调用、结果、计划审查卡片、澄清提示和最终答案。

### 后台脚本（`src/chrome/src/background.js`）

中央消息路由器。在 Chrome 上为 Service Worker（MV3）；在 Firefox 上为持久化后台页面（MV2）。职责：

1. **路由消息** 在侧面板、内容脚本和代理之间
2. **管理代理生命周期**：`chat` / `chat_stream` / `continue` / `abort` / `clear_conversation`
3. **管理提供商配置**：加载、保存、测试、切换活动提供商
4. **管理侧面板可见性**：每个窗口的"WebBrain"标签组控制面板启用的位置
5. **使用 `webRequest` 观察同标签页的 XHR/fetch 请求**，以便循环检测可以在重复 UI 点击触发相同后台请求时建议精确的 `fetch_url` 快捷方式
6. **暴露 Claude OAuth**、标签页录制、CAPTCHA 和其他子功能作为消息处理器

### 内容脚本（`src/chrome/src/content/`）

注入到每个页面（`<all_urls>`）。两个文件按顺序加载：

1. **`accessibility-tree.js`** — 暴露 `window.__generateAccessibilityTree()`（DOM 遍历器，生成扁平的缩进文本树）、`window.__wb_ax_lookup()`（ref_id → Element 解析器）和 `window.__wbElementMap`（基于 WeakRef 的注册表）。在 `content.js` 之前加载，以便 AX 处理器就绪。
2. **`content.js`** — DOM 读取器、交互元素发现、点击/输入/按键/滚动实现，以及 iframe/框架支持。所有内容脚本分发的工具处理器。

---

## 完整轮次流程

```
用户输入 "创建一个产品 'namaz'，价格 500 元，每 2 个月重复"
```

### 步骤 1：侧面板 → 后台
```
sidepanel.js → chrome.runtime.sendMessage({
  action: 'chat',
  text: 'create a product ...',
  mode: 'act',
  tabId: 42
})
```

### 步骤 2：后台 → 代理
```
background.js handleMessage('chat')
  → agent.processMessage(tabId, text, onUpdate, mode)
```

### 步骤 3：丰富首条用户消息
```
_enrichUserMessageWithCurrentPage(tabId, messages, userMessage)

  1. 通过 chrome.tabs.get(tabId) 收集 URL + 标题
  2. 如果此标签页设置了 /allow-api → 注入 [USER OVERRIDE] 前言
  3. 如果站点适配器已启用 → getActiveAdapter(url) → 注入适配器笔记
  4. 如果提供商支持视觉（或配置了专用视觉模型）：
     a. 通过 CDP 截取视口截图
     b. （可选）子调用专用视觉模型生成文本描述
     c. 将 image_url 块或视觉描述附加到首条用户消息
  5. 返回丰富后的用户消息
```

### 步骤 4：先计划后行动（Plan-before-Act）门控

手动操作模式（Act 或 Dev）在工具循环之前使用 `planner.js` 的结构化 JSON 提示调用活动提供商一次。关闭模式使用紧凑意图模式；尝试和严格模式使用完整计划模式。未设置的存储默认为尝试模式，显式关闭保持关闭。规划器看到用户任务、经过清理的 URL/标题和简短的最新历史摘要；页面上下文作为不可信数据包裹，图像块被丢弃。

如果规划器返回有效的 JSON，侧面板收到 `agent_update: plan_review` 并渲染可编辑的审查卡片。批准将已批准的方案固定到草稿板，使其在上下文压缩中存活。拒绝、超时或用户中止会在任何浏览器工具执行之前停止运行。在尝试模式下，JSON 经一次修复仍无效时，仅将本轮切换到 Ask 提示和只读工具目录；严格模式仍会在工具之前停止。定时运行可以设置 `autoApprovePlanReview` 并固定方案而不显示卡片。

### 步骤 5：主代理循环
```
while (steps < maxSteps) {
  // 5a. 调用 LLM
  const tier = provider.promptTier;
  const result = await provider.chat(messages, {
    tools: getToolsForMode(mode, { tier }),
    temperature: mode === 'ask' ? 0.3 : 0.15,
    maxTokens: 4096,
  })

  // 5b. 解析响应
  if (result.toolCalls) {
    // 5c. 执行工具批次
    for (const tc of result.toolCalls) {
      const toolResult = await executeTool(tabId, name, args)

      // 5d. 循环检测
      const loop = _checkLoop(tabId, name, args, toolResult)
      if (loop.kind === 'stop') → return loop.message

      // 5e. 自动截图（如果模式允许）
      if (_shouldAutoScreenshot(name)) {
        通过 CDP 截取截图 → 附加 image_url 块
      }

      messages.push({ role: 'tool', content: toolResult })
    }
  } else {
    // 5f. 仅文本响应 → 最终答案
    return result.content
  }
}
```

### 步骤 6：工具执行

`executeTool(tabId, name, args, onUpdate)` 按名称分发：

| 工具组 | 处理器 | 运行位置 |
|---|---|---|
| `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`, `hover` | 内容脚本消息 | 注入的页面上下文 |
| `click`, `type_text`, `press_keys`, `scroll`, `read_page` 等 | 内容脚本消息 | 注入的页面上下文 |
| `navigate`, `new_tab`, `go_back`, `go_forward` | `chrome.tabs` / `browser.tabs` API | 后台脚本 |
| `fetch_url`, `research_url`, `list_downloads` 等 | `network-tools.js` | Service Worker |
| 已启用的技能工具 | `skills.js` 注册表 + `executeHttpSkillTool()` | Service Worker |
| `done` | agent.js — 捕获验证截图 + 页面状态探测 | Service Worker + CDP |
| `clarify` | agent.js — 暂停等待用户输入 | Service Worker |
| `solve_captcha` | captcha-solver.js | Service Worker + CapSolver API |
| `read_pdf` | pdf-tools.js | Service Worker |
| `scratchpad_write` | agent.js — 内存中固定的笔记 | Service Worker |
| `read_page_source`, `inspect_element_styles` | agent/内容辅助 | 仅 Dev 的源码/样式检查 |
| `get_shadow_dom`, `shadow_dom_query`, `get_frames` | 内容/CDP 辅助 | Full Act 高级回退；Dev 模式下也添加到 Mid |

### 步骤 6a：技能与动态工具暴露

技能（`skills.js`）会规范每个技能，并为规划器和保留工具 `load_skill` 生成同一个 `{id, name, summary, intents}` 路由目录。可选的 `webbrain-skill` 块最多声明 6 个唯一的小写意图标识符，每个不超过 40 个字符，并符合 `[a-z0-9][a-z0-9_-]*`。这些意图是与语言无关的语义路由提示，不是必须逐字匹配的关键词或子字符串；未声明意图的技能不会被自动推断标签。

每次运行开始时都不包含完整技能说明或技能工具。目录只暴露 ID、名称、摘要和意图。技能只能根据用户请求或可信的对话上下文激活，不能根据页面、文档、邮件或工具结果中的指令激活。Ask 只看到明确兼容 Ask 的技能，Dev 继承 Act 的可用性，Compact 则没有目录、加载器或技能工具。

技能激活后，仅在当前运行中添加：
- 提示指令：`buildCustomSkillsPrompt()` 在将技能文本附加到系统提示之前，剥离围栏的 `webbrain-tools` 块。
- 工具暴露：`buildSkillToolDefinitions()` 读取清单并在 LLM 调用时附加声明的工具模式，尊重模式和层级。

当前技能工具支持 `kind: "http"` 用于只读 HTTPS GET/POST 集成，以及 `kind: "httpDownloadJob"` 用于短生命周期的 HTTPS POST 任务。

对于单个媒体下载，规划器可以在执行前选择 FreeSkillz。如果模型仍调用 `download_social_media`，而某个尚未激活且符合条件的技能拥有 `download_public_media`，代理会激活该技能并要求用专用工具重试。在信息流或个人资料页上，FreeSkillz 必须先检查截图或可见链接，以取得准确的帖子或 Reels 永久链接。只有 FreeSkillz 确实失败或技能不可用时，才允许浏览器回退。代理路径不会保存分离的或无法验证已混流的 MSE 音视频缓冲区，也不会给出 ffmpeg 或登录建议；已经合并的直接文件仍是有效结果。

### 步骤 7：结果返回 UI

代理对每个事件调用 `onUpdate(type, data)`：
- `tool_call` — 工具名称 + 参数
- `tool_result` — 工具名称 + 结果 JSON
- `text` / `text_delta` — 助手响应令牌
- `warning` — 循环检测、导航警告
- `clarify` — 待处理的用户问题
- `plan_review` — 在 Act 工具运行前等待批准的结构化方案
- `error` — 运行错误

---

## 关键子系统

### 先计划后行动（`planner.js`）

可选的行动模式规划门控，启用后在首次浏览器工具调用之前运行。生成结构化的 JSON 方案，包含摘要、具体步骤、记忆策略、调度提示、风险、行动模式和 `skill_ids`。规划器只收到当前模式和层级可用的技能目录；返回的 ID 会按目录校验，并且仅在方案获批后、执行模型首次调用前激活。意图匹配依靠模型的多语言语义理解，不使用字面关键词匹配器或额外的嵌入调用。

每个新轨迹记录都会保存 `webbrainVersion`。`/export` 包含当前清单版本；`/export --traces` 标注导出版本以及每一轮的记录版本，旧轨迹则标为版本不可用。轨迹页面的 JSON 导出增加 `exportedByWebBrainVersion`，同时保留向后兼容的 `webbrain-trace/1` 模式。

### 定时任务（`scheduler.js`）

调度器允许代理使用 `alarms` API 将工作推迟到未来的浏览器会话。

**任务类型：** `resume`（稍后继续当前对话）、`task`（独立的用户编写提示）。

**生命周期：** 待处理 → 运行中 → 已完成 / 失败 / 已取消 / 已暂停。

**目标：** `current_tab`（同一标签页）、`url`（打开/重用 URL 的标签页）。

**调度：** `once`（单次）、`recurring`（间隔重复）。

### 站点适配器（`adapters.js`）

58+ 个适配器注入站点特定的指南。每次只有一个触发。参见 `docs/site-adapters.md`。

### 无障碍树（`accessibility-tree.js`）

主要页面交互路径。生成扁平的缩进文本树，带有稳定的 `ref_id`。参见 `docs/accessibility-tree-and-refs.md`。

### CDP 客户端（`cdp-client.js`）— 仅 Chrome

封装 `chrome.debugger`，用于受信任事件、截图和 shadow DOM 查询。

### 提供商系统（`providers/`）

将 LLM 后端抽象在 `BaseLLMProvider` 接口之后。`promptTier` 驱动行动提示和工具子集。

### 循环检测（`agent.js`）

三个独立的检测器：通用重复、坐标点击、导航。

### 上下文管理（`agent.js`）

消息数量 > 50、原始字符 > 80,000 或令牌预算超过上下文窗口 75% 时自动压缩。溢出时紧急裁剪到最后 6 条消息。

### 对话持久化（仅 Chrome）

MV3 Service Worker 将会话持久化到 `chrome.storage.session`。

---

## Chrome 与 Firefox 主要差异

| 领域 | Chrome（MV3） | Firefox（MV2） |
|---|---|---|
| 后台 | Service Worker（临时） | 后台页面（持久化） |
| 事件 | CDP 受信任（`isTrusted=true`） | 合成事件（`isTrusted=false`） |
| 截图 | CDP `Page.captureScreenshot` | `browser.tabs.captureVisibleTab()` |
| 对话持久化 | `chrome.storage.session` | 仅内存 |
| 离屏文档 | 有（fetch 代理 + 录制器） | 不可用 |
| 轨迹记录器 | IndexedDB（可选） | IndexedDB（可选）— 相同的 `trace/recorder.js` |
| 重复提交防护 | 有 | 不可用 |
| `execute_js` | 通过 CDP `Runtime.evaluate` 在 Dev 模式中调用 | 通过 MV2 内容脚本求值器在 Dev 模式中调用 |
| Shadow DOM 穿透 | CDP 用于封闭 root；`shadow_dom_query` 仅 Chrome | 仅开放 root |
| 本地主机 CORS | 离屏代理回退 | 服务器必须设置 CORS 头 |
| API 快捷观察器 | `chrome.webRequest` URL/方法缓冲 | `browser.webRequest` URL/方法缓冲 |
| 斜杠驱动的标签页/屏幕录制 | `chrome.tabCapture` / `getDisplayMedia()` + 离屏 | 不可用 |
| 侧面板 | `sidePanel` API（MV3） | `sidebar_action`（MV2） |
| 文件上传 | CDP 驱动 | 手动分发 |

---

## 目录结构

```
src/
├── chrome/           # Chromium 构建版本（MV3）
│   ├── manifest.json
│   ├── skills/       # 打包的默认技能
│   └── src/
│       ├── agent/    # agent.js, tools.js, skills.js, adapters.js, scheduler.js, ...
│       ├── cdp/      # CDP 客户端（仅 Chrome）
│       ├── content/  # accessibility-tree.js, content.js, ...
│       ├── network/  # network-tools.js
│       ├── offscreen/# Fetch 代理 + 斜杠驱动的录制器（仅 Chrome）
│       ├── providers/# BaseLLMProvider + 实现
│       ├── recorder/ # 录制编排
│       ├── trace/    # IndexedDB 记录器
│       └── ui/       # sidepanel, settings, traces, i18n
├── firefox/          # Firefox 构建版本（MV2）
│   ├── manifest.json
│   ├── skills/       # 打包的默认技能
│   └── src/          # 相同结构，减去 cdp/, offscreen/, recorder/
└── vendor/           # 第三方库（pdfjs, katex）
```

---

## 安全模型

完整详情请参见 `docs/security-model.md`。要点：
- 扩展以 `<all_urls>` + `debugger` 权限运行
- 无额外认证：代理即为用户的浏览器会话
- Ask 为只读；Act 和 Dev 为操作模式
- 先计划后行动可以要求人工批准
- `/allow-api` 标志门控破坏性 HTTP 方法
- 工具结果限制为 8 KB
- strictSecretMode 防止在摘要中引用凭据
- 轨迹数据仅在本地（IndexedDB）
- 金融适配器注入额外的确认指导
