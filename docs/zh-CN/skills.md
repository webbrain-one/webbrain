# 技能

技能是可信的指令文本 —— 可选地带有自己的工具清单 —— DIV **只在相关时**才会
将其加载到运行中。可在设置 → 技能中管理：导入技能文本或 URL，或移除任何内置技能。

## 加载机制

Mid 和 Full 运行会收到一个小型的可用技能目录：ID、名称、摘要和可选的规范语义意图。
只有在通过 `load_skill` 为当前运行激活该技能后，完整指令才会追加到系统提示中。
**Compact 层级完全禁用技能** —— 没有加载器、没有技能提示、没有技能工具。

导入的技能会复制到浏览器本地存储中。

## 元数据

可选的围栏 `webbrain-skill` JSON 块可以声明：

| 字段 | 含义 |
|---|---|
| `summary` | 最多 200 个字符 |
| `modes` | `ask`、`act` 和/或 `dev` |
| `intents` | 最多六个规范意图，例如 `verification_code` 或 `public_media_download` |

意图是给 LLM 的跨语言*语义*提示，而非字面关键词匹配。没有元数据的技能会将第一段
正文推断为摘要，不会推断出意图，并默认为 Act/Dev。

DIV 也会识别导入的
[Agent Skills `SKILL.md`](https://agentskills.io/specification) 中必需的
`name` 和 `description` YAML frontmatter。名称和描述会写入路由目录，而在加载
Markdown 正文前会移除 frontmatter。在设置中输入的名称及 `webbrain-skill` 块仍有
更高优先级。

这仅属于指令兼容。DIV 只导入一个文本文档；它不会获取打包的 `scripts/`、
`references/` 或 `assets/`，不会执行技能代码，也不会把 Agent Skills 的
`allowed-tools` 字段当作 DIV 权限或工具清单。DIV HTTP 工具仍应使用
`webbrain-tools`。DIV 只识别有效 frontmatter 之后 Markdown 正文中的
`webbrain-skill` 和 `webbrain-tools` 围栏；frontmatter 内形似围栏的文本不能授予
路由资格或注册工具。

## 技能工具

技能可以通过围栏 `webbrain-tools` JSON 清单暴露只读 HTTP 工具，或短生命周期的
下载任务工具。

**导入技能就是其所声明 HTTPS 端点的信任边界。** 下载任务类技能工具仍然在 Act 模式
下运行，并在保存文件前经过常规的下载权限关卡。来自第三方内容的工具结果应标记为
`resultPolicy: "untrusted"`，以便被包装为数据而非指令。

技能 HTTP 工具会拒绝重定向（包括浏览器的不透明重定向），因此清单必须使用不会返回
3xx 的最终 HTTPS 主机。

技能工具不属于静态的[工具矩阵](agent-tools.md#工具矩阵)：技能加载前或被移除后，
其工具并不存在。

## 内置技能

打包的技能 markdown 位于 `skills/`，并在 `PACKAGED_SKILL_SOURCES`
（`agent/skills.js`）中注册。设置 → 技能会列出全部打包技能；仅以下默认技能会被
预先启用。

### 默认启用

四者都可以在设置 → 技能中移除。已移除的默认技能不会被静默恢复，预激活也不会恢复它。

#### FreeSkillz.xyz

可通过其技能清单暴露 `read_youtube_transcript`、`fetch_nytimes_article`、
`resolve_public_media` 和 `download_public_media`。在 NYTimes / The Athletic 标签页
上，它会为当前运行预先激活，使结构化的阻塞 `pageGate` 可以直接路由到无凭证的文章
回退方案。

公共视频下载支持 Bluesky 和 Mastodon。FreeSkillz 在服务器上将 Bluesky 的 HLS
流合成为一个含音频的 MP4 文件；Mastodon 状态永久链接适用于不同的公开实例。
在信息流或个人资料页上，先识别可见目标并取得准确的帖子或状态永久链接。

#### OTP / 验证码助手

仅在相关请求时加载，且不声明任何外部网络工具。在 Mid 和 Full 中，它只增加一个受限的
内部读取工具，用于已经打开并登录的受支持网页邮箱标签页。`inspect` 不会修改邮箱，且仍可
在 Ask 中使用。由于打开邮件可能把它标记为已读，`open_message` 只允许在 Act/Dev 中运行，
并要求对邮箱主机授予普通点击权限；它只会创建一个临时的非活动副本，完整读取所有有界续页
（无法完成时安全失败），然后关闭副本。模型只会收到不透明的邮件引用，
不会收到标签页目录、邮箱 URL 或可访问性引用。Compact 不提供技能或跨标签页工具。
在活动的运行标签页上，它仍优先使用选中文本或有界的可访问性树子树，排除短信/原生应用
访问，并遵守严格秘密处理规则。

使用时，限定范围的页面内容和验证码会包含在发往你所配置 LLM 提供商的正常请求中。
如果启用了**记录追踪**，原始工具结果和模型响应也会本地存储，直到这些追踪被删除。

#### Humanizer（人性化改写）

改写 DIV 为你撰写的正文，例如邮件回复或帖子，使其读起来像真人所写。它不声明
任何网络工具，也不新增工具。

在网页邮箱标签页（Gmail、Outlook、Yahoo、Proton、Fastmail、Zoho、Yandex）上，它会
为当前运行预激活，因此回复无需额外的 `load_skill` 调用即可被人性化。预激活依赖站点
适配器匹配，因此在设置中关闭**站点适配器**后它不会生效，此时该技能与在其他站点一样
通过目录加载。在其他站点，当请求涉及起草或改写文本时，它按正常目录加载。它只返回最终文本；除非你主动询问，否则
不会说明改动了什么。

在任意页面选中文本后，浮窗和右键菜单里都会出现 **Humanize** 项。它会在任意站点预激活
该技能，并且同一段选中文本会话的后续轮次也会保留它。预设的阅读类操作——Summarize、
Explain、Quiz me、Proofread、Translate——以及在选区输入框中输入的自由问题不会预激活，
因为它们没有以结构化方式表明写作请求。这样路由是因为选中文本的运行完全不携带工具：技能
目录对它不可见，运行开始时没有加载的技能之后也无法再加载。

它只改写面向真人读者的正文。引用内容、地址、验证码、价格、表单字段值，以及你逐字提供
的措辞都保持不变。

#### WordPress REST API

仅在 Mid/Full 的相关 Act/Dev 内容任务中按需加载，不新增工具或身份验证机制。
Compact 仍禁用技能，只使用适配器中的简短指引。对于文章、页面、支持 REST 的自定义
内容类型及分类，确认所需字段、登录会话和 API 修改权限可用后，优先使用 API。
若仅缺少权限，只请求一次 `/allow-api`；已有授权无需重复请求。Ask 模式不执行修改。

保留已有记录 ID，新内容先创建为草稿，核实内容及分类 ID 后，仅按用户要求发布同一
记录。写入结果不确定时，先核实再重试。`fetch_url` 返回的 nonce 和后续 `X-WP-Nonce`
请求头可能进入模型对话及已启用的跟踪记录。因此，严格秘密处理开启时使用界面路径，
不主动要求关闭该设置。API 不适用时，先尝试现有的代码、文本或 Classic 编辑器；
安装插件仍需明确授权。详见[技能配方](../../src/chrome/skills/wordpress-rest-api.md)。

#### CMS 内容配方（API 优先）

九项彼此独立、仅含指令的技能覆盖 **Ghost、Drupal、Joomla、Webflow、Shopify、
Wix、Strapi、Contentful 和 Sanity**。它们在 Mid/Full 的 Ask/Act/Dev 中都出现在
默认目录里，但只有当前内容任务选中的那一项会被加载。这些技能不新增 HTTP 工具
清单、凭据存储或 OAuth 集成。各服务的对照矩阵与测试覆盖见
[CMS API-first 边界与验证](../cms-api-first.md)（英文）。

在这类内容任务中，若目标站点、所需字段、任务范围、服务端权限和 DIV 的
API 修改授权都满足条件，DIV 会在只读的能力与身份探测之后优先使用官方 API，
无需先在编辑器中失败。API 本可用但缺少授权时，只请求一次 `/allow-api`；已有授权
直接复用，拒绝也会被尊重。Ask 保持只读，GraphQL 查询的 POST 同样受按方法的
权限校验约束。Compact 没有技能加载器，仅在受支持的 CMS 路由上获得简短的适配器
指引。

### 可选打包技能

这些技能随扩展一起提供，并在设置 → 技能中显示为可启用；默认不会预先打开。

| 技能 | 模式 | 网络工具 |
|---|---|---|
| 一次性邮箱（Mail.tm） | Act, Dev | Mail.tm HTTPS API |
| 临时文件分享（Litterbox） | Act, Dev | 使用浏览器上传工具；短时公开链接 |
| Open-Meteo 天气 | Ask, Act, Dev | 地理编码 + 预报 HTTPS |
| Open Library | Ask, Act, Dev | Open Library 搜索 HTTPS |
| Wikipedia | Ask, Act, Dev | Wikipedia REST 搜索 + Action API 摘要 HTTPS |
| 土耳其语字符恢复 | Ask, Act, Dev | 仅指令；使用普通的逐字文本输入工具 |

仅在你希望其工具与指令可用于符合条件的运行的 `load_skill` 时再启用。

## 按服务编写 API 配方

将具体操作留在各服务的技能中，例如 WordPress、Mail.tm 的临时邮箱及 API 回退流程、
Phonr 的通话授权和中断恢复。配方应说明端点发现、字段支持、身份验证、权限、凭据暴露、
结果核实、写入不确定时的处理，以及界面回退。加载技能不授予 API 修改权限；WordPress
例外也不会改变 Mail.tm 或 Phonr 自身的规则。这样无需始终将完整流程放进公共提示。

## 另请参阅

- [智能体工具](agent-tools.md) — 层级、模式和完整工具矩阵
- [隐私与数据流](privacy-and-data-flow.md)
- [CMS API-first](../cms-api-first.md) — 支持的服务、身份验证与界面回退（英文）
- [架构](architecture.md) — 轮次流程中的技能与动态工具暴露
