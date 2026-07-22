# 安全模型

本文档描述了 WebBrain 的安全架构 — 扩展能做什么、它信任什么、如何处理凭证，以及如何防御提示注入。

关于漏洞披露，请参见 [SECURITY.md](../SECURITY.md)。

---

## 扩展权限

### 权限列表

```json
{
  "permissions": [
    "sidePanel", "activeTab", "contextMenus", "tabs", "tabGroups",
    "scripting", "storage", "webNavigation", "webRequest", "debugger",
    "downloads", "alarms", "unlimitedStorage", "offscreen",
    "privateNetworkAccess", "tabCapture",
    "clipboardWrite", "clipboardRead"
  ],
  "host_permissions": ["<all_urls>", "http://localhost/*", "http://127.0.0.1/*", "http://*/*"]
}
```

（这是 Chrome MV3 清单。Firefox MV2 授予更窄的权限集 — `activeTab`、`menus`、`webNavigation`、`webRequest`、`storage`、`unlimitedStorage`、`tabs`、`tabGroups`、`downloads`、`alarms`、`clipboard*`、`<all_urls>` — 且没有 `debugger`/`offscreen`/`tabCapture`，请参见下方的 Firefox 差异。）

| 权限 | 风险 | 缓解措施 |
|---|---|---|
| `<all_urls>` | 内容脚本可注入任意位置 — 智能体可以读取和与用户访问的任何页面交互 | 用户必须显式切换到行动模式（Act 或 Dev）才能进行点击/输入/导航。Ask 模式为只读。智能体从不在新标签页上自动激活。 |
| `debugger` | CDP 访问提供可信事件和完整的 DOM/网络控制 | 调试器仅在智能体活跃运行时附加，并在完成/中止时分离。 |
| `webRequest` | 可观察活动页面发起的 XHR/fetch 请求的元数据 | API 变更观察器默认关闭；启用时，它仅为重复点击快捷提示和不透明的同源重放保留每个标签页的内存中有限缓冲。 |
| `downloads` | 可无需提示保存文件到用户的下载文件夹 | 只有智能体显式的下载能力工具调用（`download_files`、`download_file`、`download_resource_from_page`、`download_social_media`、下载任务技能工具）使用此权限，且每个都通过能力 × 来源权限提示进行门控。 |
| `alarms` | 可在未来的浏览器会话中唤醒定时任务 | 只有 `schedule_resume` / `schedule_task` 创建闹钟，且这些工具已门控。 |
| `offscreen` | 屏幕外文档可发起不受用户 CSP 影响的 HTTP 请求 | 仅用于本地 LLM 提供商代理和标签页录制。永不转发任意 URL。 |

### 身份认证

扩展在**用户已认证的浏览器会话内**运行。没有独立的"AI 账号" — 用户登录的每个站点（GitHub、Gmail、银行、内部工具）都可以被智能体以用户的完整权限访问，就像用户自己在点击一样。

系统提示明确告诉模型：
> "你不需要 API 令牌、OAuth 流程或'代表用户行事的权限'。浏览器会话已拥有所有这些。"

这是一个特性（它使智能体无需任何设置即可使用），但也是最重要的风险：**智能体可以做用户在浏览器中能做的任何事情**。

---

## 凭证处理

### 检测

在每次 `set_field` / `type_ax` 调用后，`credential-fields.js` 检查填充的字段是否为凭证输入。触发条件：

1. `<input type="password">`
2. `autocomplete="current-password" | "new-password" | "one-time-code"`
3. 字段名称 / id / aria-label / placeholder / 标签文本匹配 `SENSITIVE_NAME_RE`

正则表达式：`pwd|password|passwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|recovery[-_\s]?code|backup[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|client[-_\s]?secret|private[-_\s]?key|seed[-_\s]?phrase|passphrase|pin[-_\s]?code`

### 严格秘密模式

启用时（设置 →"严格秘密处理"），智能体：

- **从不引用凭证** — 无论是摘要、助手文本还是工具调用参数中 — 即使用户明确要求
- `done` 工具描述被替换为 `DONE_TOOL_STRICT`，添加了硬性禁止
- 在填充敏感字段后，`CREDENTIAL_NOTE_STRICT` 被注入到工具结果中

禁用时（默认 — 这是个人计算机工具，而非第三方部署）：

- 模型获得软性卫生指南（"除非用户要求值，否则优先使用通用表述"）
- 用户可以要求查看凭证，模型会显示它们
- `done` 工具描述仍鼓励简洁摘要

### 个人资料自动填充

用户可以在设置 → 个人资料中存储简短的个人资料（姓名、电子邮件、一次性密码）。此文本在启用时附加到系统提示中。界面中的警告：

- 以明文存储在 `chrome.storage.local` 中
- 每次轮次都作为系统提示的一部分发送给 LLM 提供商
- 不要在此处放置重要账户的密码

---

## 提示注入防御

主要威胁：恶意页面制作的内容在被智能体读取并馈送给 LLM 时，导致模型执行非预期的操作。

### 防御层级

| 层级 | 机制 |
|---|---|
| **不可信内容包装** | 页面派生的工具结果被包装在 `<untrusted_page_content>` 标记中（`_wrapUntrusted` + `UNTRUSTED_CONTENT_TOOLS`），以便模型将其视为数据而非指令。参见 [prompt-injection-defense.md](prompt-injection-defense.md)。 |
| **能力 × 来源门** | 在后果性工具运行之前（click/type/navigate/execute_js/network/download/…），智能体要求 `(capability, host)` 授权 — 允许一次 / 始终允许 / 拒绝。语言无关、确定性、人工参与（`permission-gate.js`）。 |
| **工具结果上限** | 单个工具结果截断为 8,000 字符（`_limitToolResult`）。超出部分的注入文本被静默丢弃。 |
| **Ask/Act/Dev 模式** | Ask 模式仅暴露语义只读工具。用户必须显式切换到行动模式才能进行点击/输入/导航。Act 暴露所选提供商层级的普通工具。Dev 需要 Mid/Full 层级，并添加源代码/样式/页面检查工具用于开发者调试。 |
| **分层工具暴露** | 提供商层级（`compact | mid | full`）限制较小模型的普通浏览器智能体操作面。Compact 获得最小的操作面；Mid 添加常见任务工具；Full 添加高级 UI/DOM 回退。Compact Dev 被阻止。 |
| **行动前规划** | 启用时，行动模式的运行首先生成结构化计划，并等待侧面板批准后才执行任何浏览器工具。定时运行仅通过调度器策略可自动批准计划。 |
| **技能导入边界** | 技能可通过 `webbrain-tools` 清单暴露只读 HTTP 工具和下载任务工具。导入或保持技能启用是对声明的 HTTPS 端点的信任决策；声明的技能工具使用 `credentials: "omit"` 并应将第三方结果标记为 `resultPolicy: "untrusted"`。下载任务技能工具在保存文件前仍需行动模式和正常的下载权限门。 |
| **`/allow-api`** | 每个对话的 `/allow-api` 标记，*免除*写方法网络出口（`fetch_url`/`research_url` 的 POST/PUT/PATCH/DELETE）的权限提示。不免除 GET 出口或任何其他能力。对话重置时清除。 |
| **`done()` 阻塞** | 在接受完成前，智能体探测是否有打开的对话框/表单。如果摘要声称"已创建"/"已保存"但模态框仍打开，则强制智能体继续。 |
| **重复提交防护** | 在 45 秒窗口内，每个标签页+URL 阻止对类似提交文本（create/save/submit/add/post/publish/send/confirm/sign up/log in/pay/checkout/order 等）的点击（Chrome）。 |
| **CLICK 遮挡测试** | 在点击前，解析器调用 `elementFromPoint()`。如果另一个元素视觉上位于上方，则拒绝点击。 |
| **模态范围点击** | 当对话框打开时，文本点击被限定到该子树，以免智能体点击变暗的背景元素。 |
| **通用前言** | 每个系统提示都包含关于 cookie 横幅和付费墙的指导 — 两种常见的看起来像无害页面内容的注入向量。 |
| **循环检测** | 三个独立的检测器在智能体重复相同操作或振荡时停止它。重复点击循环可能包括精确的同标签页 XHR/fetch URL+方法提示，以便智能体可以切换到 `fetch_url` 而不是永远点击。限制持续注入提示的损害。 |
| **金融适配器** | 带有 `category: 'finance'` 的适配器注入额外的确认指导和警告横幅。 |
| **严格秘密处理** | 即使模型被越狱而引用秘密，也能防止凭证泄露。 |
| **本地网络阻止** | 禁用时（默认），`fetch_url` 无法访问私有/RFC1918 地址。云元数据端点（169.254.169.254）始终被阻止。 |

### 未防御的内容

- **LLM 提供商本身**：如果提供商被攻破或恶意，它会看到所有对话内容，包括用户输入的凭证。
- **扩展唯一指纹识别**：网站可以检测到内容脚本（脉动边框、`window.__wbElementMap`、自定义事件处理器）。
- **时序信道攻击**：智能体的工具调用延迟可以从页面 JS 中观察到。

---

## `/allow-api` 标记

通过侧面板中的 `/allow-api` 斜杠命令为每个对话设置。激活时，它仅免除**写方法网络出口**的权限提示：

- `fetch_url` / `research_url` 使用 `method: POST/PUT/PATCH/DELETE`

它不免除 GET 出口、`execute_js` 或任何其他能力 — 这些仍通过能力 × 来源门。（`permission-gate.js` 中的 `isNetworkMutation` 是 `/allow-api` 所依赖的；`execute_js` 是其自身的 `Capability.EXECUTE_JS`，始终门控。）

系统提示添加了一段前言，告诉模型：
- 在任何破坏性 API 调用前以纯文本说明 URL、方法和载荷
- 默认优先使用 UI，仅在 UI 确实失败时才使用 API

循环检测 API 快捷提示不会绕过此策略。它们可以暴露页面已在调用的确切方法和 URL，包括 POST/PATCH 等，但写方法的 `fetch_url` / `research_url` 调用仍需要对话的 `/allow-api` 状态。GET 请求和非网络能力仍通过正常的能力 × 来源门。

对话重置时清除。

---

## 追踪数据隔离

追踪记录器（`trace/recorder.js`）在用户显式启用时（设置 → 显示 →"记录追踪"）写入用户机器上的 IndexedDB。数据从不离开浏览器：

- `runs` 存储：模型、提供商、令牌总数、时间戳
- `events` 存储：LLM 请求/响应、工具调用、截图元数据
- `shots` 存储：截图二进制数据

追踪页面（`ui/traces.html`）仅从本地 IndexedDB 读取。导出生成与用户在屏幕上所见相同的 JSON 数据块 — 无遥测、无网络调用。

---

## Firefox 差异

Firefox 没有 CDP（`debugger` 权限），因此：

- 无可信事件（仅合成 `el.click()`）
- 无整页截图
- 无影子 DOM 穿透（封闭根节点）
- `execute_js` 在两个版本中都是 Dev 附加工具：Firefox 使用 MV2 内容脚本求值器，Chrome 使用 CDP `Runtime.evaluate`；两者都不会在 Ask 或普通 Act 中暴露
- Chrome 的可逆 CSS/元素补丁仅限 Dev 模式，并按主机进行权限控制。控制台和网络诊断属于 Dev 只读工具。事件监听器检查会短暂添加并恢复内部目标属性，而元素高亮会插入临时覆盖层；两者都使用临时页面修改权限。所有页面派生的诊断结果都会按不可信内容封装。网络标头和正文默认不返回，敏感标头在进入缓冲区前始终会被遮蔽
- 无屏幕外文档（CORS 必须由 LLM 服务器处理）
- 无斜杠驱动的标签页/屏幕录制（Chrome 的捕获 API 和 `recorder/` 不存在）
- 无重复提交防护（时间戳 Map 已声明但未连接）

其他所有内容 — 权限门、不可信内容包装、凭证检测、循环检测、适配器系统和**追踪记录器**（它完全相同地存在于 `src/firefox/src/trace/recorder.js` 中）— 都是相同的。

---

## 报告问题

参见 [SECURITY.md](../SECURITY.md) 了解披露联系方式和政策。
