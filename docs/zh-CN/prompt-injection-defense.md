# 提示注入防御 — 工作原理及如何避免破坏它

DIV 的智能体在**用户已认证的浏览器会话内**运行：它可以点击、输入、导航、执行 JS 以及**以登录用户的身份**提交表单。因此，它从网页读取的任何文本都**受攻击者控制** — 恶意推文、共享文档、电子邮件、issue 评论、PDF。以下防御措施的全部意义在于：**页面内容是数据，绝非指令，且后果性操作需要人工参与。**

如果你添加了一个工具、一种读取页面的新方式，或一个新的将页面派生字节馈送给模型的途径，请先阅读本文。单元测试可以强制执行注册表的**成员资格**，但**不能**验证你对事物的分类是否正确 — 这取决于你和审查者。

代码存在于**两个构建**中（`src/firefox/...` 和 `src/chrome/...`）。请保持它们同步 — 测试套件断言纯模块在字节级别完全一致。

---

## 四个层级

1. **不可信内容包装（第 1 层）。** 携带页面派生字节的工具结果被包装在 `<untrusted_page_content id="<nonce>">…</…>` 标记中，内容中的任何字面标记均被剥离（越狱防御）。
   - 代码：`agent.js` → `_wrapUntrusted(name, content)`；`permission-gate.js` 中的 `UNTRUSTED_CONTENT_TOOLS` 集合。
2. **系统提示合约（第 2 层）。** 提示告诉模型，这些标记中的任何内容都是数据而非指令，并且只有系统提示和用户自己的聊天/`clarify` 消息是权威的。
   - 代码：`tools.js` 中的 `SYSTEM_PROMPT_ASK`、`SYSTEM_PROMPT_ACT`、`SYSTEM_PROMPT_ACT_MID`、`SYSTEM_PROMPT_ACT_COMPACT` 和 `SYSTEM_PROMPT_DEV_APPENDIX`，以及 `planner.js` 中的 `PLANNER_SYSTEM_PROMPT`（用于行动前规划的循环前调用）。
3. **能力 × 来源权限门（第 3 层）。** 在后果性工具运行之前，智能体检查 `(capability, host)` 授权，如果没有则提示用户（允许一次 / 始终允许 / 拒绝）。无文本检查，无 LLM — 人类是信任锚点。
   - 代码：`permission-gate.js`（`capabilityFor`、`requiredHosts`、`PermissionManager`）；`agent.js` 中的门循环 `_executeToolBatch`。
   - 用户控制：权限页面（审查/撤销授权 + 主开关"在后果性操作前询问"）。
4. **输出清理器（第 4 层）。** 模型输出经过 HTML 转义，只有 `[label](url)` 格式的 markdown 会变成允许列表中的（http/https/mailto）链接 — 不自动加载图像，不将裸 URL 转换为链接。
   - 代码：`ui/markdown-link.js`。

---

## 什么算作"页面派生"（即不可信）

将以下**所有**内容视为受攻击者控制：

- DOM 文本和 HTML — 包括**隐藏/屏幕外**文本、ARIA 标签、`alt`、`title` 属性、HTML 注释以及设置为不可见样式的文本。
- 屏幕截图的 **OCR / 视觉模型转录**（`desc.text`）。
- **获取/下载的文档** — PDF 提取文本、下载的文件内容、`fetch_url`/`research_url` 的响应体。
- **页面控制的 URL 和主机** — `href`/`src`、iframe 的 URL、重定向目标。（这些驱动*权限*决策，参见第 3 层。）
- **嵌入页面派生验证/探测字段的工具结果** — 例如 `done` 结果包含 `pageTitle` / `pageState`（对话框标题、实时区域文本）。非显而易见，容易遗漏 — `done` 曾因此被错误分类过一次。

模型撰写的文本（工具自身的状态字符串、智能体的 `summary`）和**用户**的消息是可信的。当工具在行动模式下可用时，`clarify` 回答也是可信的；Ask 模式将澄清作为普通对话处理，不暴露 `clarify` 工具。

---

## 贡献者规则

### 添加一个读取页面内容的工具
将其名称添加到 `permission-gate.js`（两个构建）中的 `UNTRUSTED_CONTENT_TOOLS`。穷举测试会失败，直到每个行动模式的工具都被分类。

对于动态技能工具，不要将名称添加到静态集合中。改为在技能的 `webbrain-tools` 清单中声明 `"resultPolicy": "untrusted"`；`agent.js` 在运行时查询已启用技能的注册表并应用相同的包装/摘要行为。

### 添加一个具有副作用的工具（click/type/navigate/download 等）
在 `permission-gate.js` 中进行映射：
- 将其添加到 `TOOL_CAPABILITY`（如果能力取决于参数，则在 `capabilityFor` 中处理 — 参见 `set_field`/`press_keys`/`fetch_url`）；
- 确保 `hostForCapability` / `requiredHosts` 解析出**真实目标主机**（导航/网络/下载的目标 URL；点击/输入的当前页面；iframe 工具的**框架**主机；多 URL 工具如 `download_files` 的**每个**主机）；
- 如果无法确定主机，返回 `''` / `[]` 以便门在**关闭状态下失败**（参见不带 `urlFilter` 的 iframe 情况）。

### 添加一个将页面派生字节重新注入消息的地方
某些页面派生文本通过**正常工具结果路径之外**的方式到达模型 — 它被插入到智能体自己构建的 `role:'user'` 或 `role:'tool'` 消息中。这些必须**显式**包装：

```js
const wrapped = this._wrapUntrusted('screenshot', desc.text); // nonce + 剥离
messages.push({ role: 'user', content: `[…]\n${wrapped}` });
```

> ⚠️ **散文式的"这是不可信的"标签不是边界。** 边界是 `_wrapUntrusted` 生成（以及它所做的越狱剥离）的 nonce 分隔的 `<untrusted_page_content>` 标记。始终通过 `_wrapUntrusted` 路由页面派生文本，而不仅仅是加个 `[warning]` 前缀。

已知的非工具注入点（请保持此列表更新）：
- 自动屏幕截图重新注入（视觉描述 + 可交互元素列表）；
- `_enrichUserMessageWithCurrentPage` 中的"初始视口描述"；
- 行动前规划器的消息：经过清理的页面 URL/标题和近期历史摘要以规划器的不可信页面框架发送；非文本图像块在规划器调用前被丢弃；
- PDF 透传：原始 PDF `document` 块无法进行文本包装，因此其附带的说明带有显式的不可信框架，并且攻击者控制的 `docTitle` 在插入前被清理；
- `done` 工具结果推送（在正常包装前特殊处理）。

### 不要为"可信站点"削弱边界
主开关（权限页面）**仅禁用第 3 层**（提示）。第 1、2、4 层始终保持开启 — 它们不消耗任何成本，并且正是保护用户在真正存在注入内容的可信站点上安全的部分（知名域名与安全内容*负相关*）。绝不要将第 1/2/4 层置于某个设置开关之后。

---

## 测试

- `node test/run.js` — 纯逻辑单元测试，包括：
  - **穷举守卫**：来自 `getToolsForMode('act')` 和 `getToolsForMode('dev')` 的每个模型暴露的行动工具必须被门控（`capabilityFor`）、不可信读取（`UNTRUSTED_CONTENT_TOOLS`）或在 `KNOWN_SAFE_TOOLS` 允许列表中（定义于 `test/run.js`）— 否则 CI 失败。
  - 能力映射、主机解析、`requiredHosts`、`frameHostMatches`、授权存储 / `hydrateFrom`、内容包装的越狱剥离。
  - `test/security/injection-corpus.mjs` 中的规划器提示对等性/边界检查。
- `test/manual-permissions.md` — 浏览器内检查清单（3 选项权限卡片和权限页面），单元套件无法覆盖这些内容。

**守卫检查工具是否被*列出*，而不是它们是否被*正确列出*。** 如果工具的结果携带页面派生字节，它属于 `UNTRUSTED_CONTENT_TOOLS`，即使它"只是一个状态工具"（参见 `done`）。如有疑问，请包装它 — 包装可信字段是无害的；留下未包装的页面派生字段则是一个漏洞。

---

## 已知限制（已接受）

这些是有意识的权衡，而非疏忽。

- **通用交互计入顶级页面主机，而非其所在框架。** `click({x,y})`（CDP 坐标点击）、`type_text` 和 `press_keys` 作用于任何被定位或聚焦的像素/元素 — 它们*可能*进入跨源 iframe（例如嵌入的 Stripe/PayPal 框架）。门将这些操作计入页面主机，因此对 `merchant.com` 的授权也覆盖落在嵌入的 `stripe.com` 框架中的坐标点击。
  - 接受原因：（1）选择器/文本点击**无法**到达跨源框架（同源策略阻止 `querySelector` 穿透它们），因此这仅限于坐标点击（Chrome/CDP 专用 — Firefox 点击到 `<iframe>` 元素而非进入内部）和基于焦点的输入；（2）对于合法的嵌入流程，用户授权商户页面时*期望*结账成功 — 包括其中的支付 iframe — 因此在此过程中提示提供商的主机会带来比残余风险更差的用户体验。**显式**的 `iframe_click` / `iframe_type` 工具确实会以框架主机为门控条件（`frameHostMatches`），因为此时模型有意识地指定了框架。
  - 如果你想关闭此问题：解决坐标点击的目标框架（CDP 命中测试）和按键的焦点框架，然后以该框架主机为门控条件，或在跨源时关闭失败。这项工作不简单且是 Chrome/CDP 专用的；需要真实浏览器测试。

- **`solve_captcha` 是无门控的**（在 `KNOWN_SAFE_TOOLS` 允许列表中）。它消耗 CapSolver 配额并注入一个令牌（触发小部件的 `data-callback`，在某些站点上会自动提交）。接受原因是成本有上限，后果性提交另有门控，且在用户被 CAPTCHA 阻挡时对前置操作进行提示会增加延迟。如果配额滥用成为实际关切，请重新审视。

- **`hover` 是无门控的** — 悬停会显示菜单/工具提示，不提交任何内容。它仅限完整行动模式；中阶开发模式不添加它。

- **门的任何地方均*不*使用 LLM。** 意图从不从页面或提示文本推断（这种方法曾尝试并已移除 — 它仅支持英文且有漏洞）。门是确定性的能力×来源机制，以人类为信任锚点。
