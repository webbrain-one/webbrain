# WebBrain 与 Claude Chrome 扩展对比

本文比较了本地的 WebBrain 代码库与 `../webbrain-claude`（一个去混淆后的 Claude Chrome 扩展代码树）。重点比较架构、模型可调用工具以及特定网站的适配器行为。

## 已检查的源代码

WebBrain：

- `docs/architecture.md`
- `docs/adding-a-tool.md`
- `docs/site-adapters.md`
- `docs/accessibility-tree-and-refs.md`
- `docs/webbrain-tool-tiers.xlsx`
- `src/chrome/ARCHITECTURE.md`
- `src/chrome/src/agent/tools.js`
- `src/chrome/src/agent/skills.js`
- `src/chrome/src/agent/adapters.js`
- `src/chrome/skills/freeskillz-xyz.md`
- 相关 Firefox 文件中需要保持一致的部分

Claude Chrome：

- `../webbrain-claude/manifest.json`
- `../webbrain-claude/settings.html`
- `../webbrain-claude/settings.js`
- `../webbrain-claude/assets/service-worker.js`
- `../webbrain-claude/assets/mcpPermissions.js`
- `../webbrain-claude/assets/PermissionManager.js`
- `../webbrain-claude/assets/sidepanel.js`
- `../webbrain-claude/assets/accessibility-tree.js`

Claude 代码树部分经过打包/压缩。以下工具名称是根据 `toAnthropicSchema()` 定义、原生消息分发和侧面板快速命令提示恢复的。

## 架构

| 领域 | WebBrain | Claude Chrome 扩展 |
|---|---|---|
| 浏览器支持 | 两套镜像扩展构建：Chrome/Edge MV3 和 Firefox MV2。 | 此代码树仅支持 Chrome MV3。 |
| 代理位置 | 扩展在 `agent.js` 中拥有完整的代理循环；提供者为本地扩展模块。 | 两条路径：侧面板中的标准 Anthropic 工具调用循环，以及 Service Worker 中的原生主机/MCP 桥接。 |
| LLM 提供商模型 | 提供商抽象支持 OpenAI 兼容、Anthropic、本地 llama.cpp/LM Studio/Ollama 风格端点以及提供商设置。 | 主要为 Anthropic Messages API；侧面板快速模式在配置时指向 `http://localhost:4000`，原生主机名称则针对 Claude Desktop / Claude Code 集成。 |
| 工具分发 | `getToolsForMode()` 从 `tools.js` 返回 OpenAI 风格的函数模式，可选择由已启用的技能工具扩展。`agent.js` 将工具分发给内容脚本、Chrome API、CDP、网络辅助程序或技能执行器。 | MCP 风格的模式位于 `mcpPermissions.js` 中。侧面板按名称执行工具调用。快速模式使用紧凑的命令 DSL（不含 Anthropic 工具），然后将命令转换为合成的工具使用/结果。 |
| 页面读取 | 首选无障碍树工具，具有稳定的 `ref_id` 以及散文/页面源代码/PDF 读取器。 | 无障碍树读取器也存在，使用 `window.__wbElementMap` / `ref_` ID，但主要的浏览器操作工具更侧重于坐标/计算机操作。 |
| 受信任的浏览器事件 | Chrome 使用 CDP 实现受信任的鼠标/键盘事件、截图、封闭的 shadow-root 访问以及某些文件上传路径。Firefox 使用合成事件。 | Chrome 使用 `debugger`/CDP 实现计算机操作、截图、JavaScript 执行、上传、控制台/网络跟踪和缩放截图。 |
| 对话控制 | 询问/执行模式、先计划后执行、草稿板、进度记录、定时任务/恢复、可选追踪。 | 权限模式、通过 `update_plan` 进行计划审批、域名转换提示、标签组、压缩、原生主机/MCP 状态。 |
| 动态扩展模型 | 用户/导入的技能可以注入提示文本并声明 `webbrain-tools` 运行时工具。 | 在去混淆后的代码树中，原生/MCP 和快捷方式是可见的扩展点；未找到等效的用户可编辑 Markdown 工具清单。 |

## WebBrain 工具面

当前本地源代码中的静态核心工具：

- Chrome：57 个核心工具。
- Firefox：48 个核心工具。
- Chrome 独有核心工具：`shadow_dom_query`，以及可逆/诊断 Dev 工具 `inject_css`、`remove_injected_css`、`patch_element`、`revert_patch`、`read_console`、`inspect_network_requests`、`inspect_event_listeners` 和 `highlight_element`。
- `execute_js` 为两者共有：Chrome Dev 使用 CDP 求值，Firefox Dev 使用 MV2 内容脚本求值器。
- 动态技能工具可以在运行时添加更多模式，不计入上述数量。

询问模式核心工具：

```text
get_accessibility_tree, read_page, read_pdf,
get_window_info, get_interactive_elements, scroll, extract_data,
get_selection, done, wait_for_stable,
fetch_url, research_url, list_downloads
```

Chrome 静态核心工具列表（所有模式与层级的并集）：

```text
get_accessibility_tree, click_ax, type_ax, set_field, hover, drag_drop,
read_page, read_pdf, read_page_source, get_window_info, resize_window,
get_interactive_elements, click, type_text, press_keys, scroll, navigate,
go_back, go_forward, extract_data, inspect_element_styles, wait_for_element,
inject_css, remove_injected_css, patch_element, revert_patch, execute_js,
read_console, inspect_network_requests, inspect_event_listeners,
highlight_element, wait_for_stable, schedule_resume, schedule_task, get_selection, new_tab,
done, clarify, get_shadow_dom, shadow_dom_query, get_frames, iframe_read,
iframe_click, iframe_type, fetch_url, research_url, list_downloads,
read_downloaded_file, download_resource_from_page, download_files,
upload_file, scratchpad_write, progress_update, progress_read,
verify_form, download_social_media, solve_captcha
```

Firefox 不包含 Chrome 独有的 Dev 工具和 `shadow_dom_query`；其余核心工具（包括仅限 Dev 的 `execute_js`）两者共有。

### WebBrain 工具族

| 族 | 工具 |
|---|---|
| AX 优先的 DOM 控制 | `get_accessibility_tree`、`click_ax`、`type_ax`、`set_field`、`hover`、`drag_drop` |
| 传统的 DOM 回退 | `get_interactive_elements`、`click`、`type_text`、`press_keys`、`scroll`、`wait_for_element`、`wait_for_stable` |
| 导航和标签页 | `navigate`、`go_back`、`go_forward`、`new_tab` |
| 读取/提取 | `read_page`、`read_pdf`、`read_page_source`、`extract_data`、`inspect_element_styles`、`get_selection` |
| Dev 编辑与诊断 | `inject_css`、`remove_injected_css`、`patch_element`、`revert_patch`、`execute_js`、`read_console`、`inspect_network_requests`、`inspect_event_listeners`、`highlight_element` |
| Shadow DOM 和框架 | `get_shadow_dom`、`shadow_dom_query`（Chrome）、`get_frames`、`iframe_read`、`iframe_click`、`iframe_type` |
| 网络和文件 | `fetch_url`、`research_url`、`list_downloads`、`read_downloaded_file`、`download_resource_from_page`、`download_files`、`upload_file`（Chrome） |
| 长时间运行的工作 | `schedule_resume`、`schedule_task`、`scratchpad_write`、`progress_update`、`progress_read` |
| 安全/工作流 | `verify_form`、`clarify`、`done`、`solve_captcha` |
| 媒体 | `download_social_media`，以及启用时的动态技能工具 |

### WebBrain 动态技能工具

WebBrain 有两种在技能 Markdown 代码块中声明的工具类：

- `kind: "http"`：只读的 HTTPS GET/POST 工具，根据其清单 `modes` 在询问和执行模式下可用。
- `kind: "httpDownloadJob"`：仅执行模式的 HTTPS POST 作业工具，用于创建作业、轮询状态、获取文件、通过浏览器下载保存并清理。

预置的 `FreeSkillz.xyz` 技能提供：

```text
read_youtube_transcript
resolve_public_media
download_public_media
```

这些不是 `/allow-api` 变更。它们在技能导入/启用时被信任，使用 `credentials: "omit"`，并且应将第三方结果标记为不可信。

## Claude Chrome 工具面

恢复的 MCP/工具模式：

```text
computer, javascript_tool, file_upload, find, form_input, get_page_text,
gif_creator, navigate, read_console_messages, read_network_requests,
read_page, resize_window, tabs_context, tabs_create, turn_answer_start,
update_plan, upload_image, tabs_context_mcp, tabs_create_mcp, tabs_close_mcp,
shortcuts_list, shortcuts_execute
```

最大的设计差异在于 Claude 将许多浏览器操作合并到 `computer` 中，并带有一个 `action` 枚举：

```text
left_click, right_click, type, screenshot, wait, scroll, key,
left_click_drag, double_click, triple_click, zoom, scroll_to, hover
```

侧面板快速模式有单独的命令 DSL：

```text
ST tabId        选择标签页
NT url          打开新标签页
LT              列出标签页
C x y           点击
RC x y          右键点击
DC x y          双击
TC x y          三击
H x y           悬停
T text          输入文本
K keys          按下按键
S dir amt x y   滚动
D x1 y1 x2 y2   拖拽
Z x1 y1 x2 y2   缩放截图区域
N url           导航、后退或前进
J code          执行 JavaScript
W               等待页面稳定
```

快速模式发送 `Anthropic tools: []`，解析这些文本命令，本地执行，然后附加合成的 `tool_use` / `tool_result` 消息并附带新截图。

### Claude 工具族

| 族 | 工具 |
|---|---|
| 浏览器/计算机操作 | `computer`、`navigate`、`resize_window` |
| 页面读取/搜索 | `read_page`、`get_page_text`、`find` |
| DOM/表单/文件操作 | `form_input`、`file_upload`、`upload_image`、`javascript_tool` |
| 调试 | `read_console_messages`、`read_network_requests` |
| 标签页和 MCP 标签组 | `tabs_context`、`tabs_create`、`tabs_context_mcp`、`tabs_create_mcp`、`tabs_close_mcp` |
| 工作流和权限 | `update_plan`、`turn_answer_start` |
| 复用/导出 | `gif_creator`、`shortcuts_list`、`shortcuts_execute` |

## 工具差异

| 能力 | WebBrain | Claude Chrome |
|---|---|---|
| 工具粒度 | 许多细粒度工具：独立的 AX 点击/输入/设置字段、网络、下载、调度器、iframe、PDF、源代码、进度工具。 | 较少的高级工具；浏览器输入主要通过一个 `computer` 工具加 action 枚举。 |
| 主要读取路径 | `get_accessibility_tree` 是首选的首次读取方式，返回带有分页/自动降级行为的稳定引用。 | `read_page` 也返回无障碍树，但以截图驱动的坐标控制更为核心，尤其是在快速模式下。 |
| 自然语言元素查找 | 没有独立的模型驱动的 `find`；模型通常读取 AX 树并选择引用。 | 有 `find`，它在无障碍树上执行小模型调用并返回匹配的引用。 |
| 页面文本 | `read_page` 面向散文/文章；`get_accessibility_tree` 面向 UI。 | 将 `read_page` 作为 AX 树，`get_page_text` 作为原始/文章文本。 |
| PDF 阅读 | `read_pdf` 直接提取 PDF 文本。 | 未找到等效功能。 |
| 原始源代码读取 | `read_page_source` 公开服务器返回的 HTML 和资源 URL。 | 未找到等效功能。 |
| 网络请求 | `fetch_url` / `research_url`，带有 WebBrain 特定的 API 变更规则和用于可变方法的 `/allow-api`。 | 未恢复通用请求工具。通过 `read_network_requests` 存在调试网络日志。 |
| 控制台/网络检查 | WebBrain 核心工具列表中没有专用的控制台日志读取器。存在用于 API 观察的网络快捷方式，但没有面向模型的请求日志读取器。 | 专用的 `read_console_messages` 和 `read_network_requests`。 |
| 下载 | 多个浏览器下载/文件工具加上动态下载作业技能工具。 | `downloads` 权限存在，`gif_creator` 可以下载导出内容，但未找到通用的下载管理器等效功能。 |
| 媒体下载 | 首选 `download_public_media` 技能；浏览器回退 `download_social_media`。 | 未找到公共媒体下载等效功能。 |
| 文件上传 | Chrome 有基于 downloadId/路径的 `upload_file` 流程；Firefox 没有。 | `file_upload` 直接在文件输入上设置本地绝对路径；`upload_image` 通过引用或坐标上传捕获/用户图像。 |
| 调度器 | `schedule_resume` 和 `schedule_task`。 | 存在定时任务 UI/提示字符串，但在可见工具列表中未恢复模型可调用的调度器模式。 |
| 验证码 | 配置 CapSolver 后的 `solve_captcha`。 | 明确的安全提示要求尊重验证码，绝不绕过；未恢复求解工具。 |
| 持久代理记忆 | `scratchpad_write`、`progress_update`、`progress_read`。 | 存在对话压缩；未恢复等效的草稿板/进度工具。 |
| 表单安全 | 重要表单使用 `verify_form`。 | `form_input` 可以设置值；未恢复专用的表单验证工具。 |
| Iframe | 专用的 `get_frames`、`iframe_read`、`iframe_click`、`iframe_type`。 | 未恢复专用的 iframe 工具；操作可能通过坐标/JS 在允许的地方进行。 |
| 快捷方式/工作流 | 自定义技能是 Markdown 加可选的工具清单。 | `shortcuts_list` / `shortcuts_execute` 公开保存的快捷方式/工作流。 |
| GIF/视频工作流 | WebBrain Chrome 中存在斜杠驱动的录制，但不是以模型可调用的工具形式。 | `gif_creator` 是模型可调用的，可以录制/导出浏览器自动化会话为 GIF。 |

## 特定网站的适配器

### WebBrain

WebBrain 拥有真实的站点适配器系统：

- 适配器文件位于 `src/chrome/src/agent/adapters.js` 和 `src/firefox/src/agent/adapters.js`。
- `getActiveAdapter(url)` 返回第一个匹配的适配器。
- 一次仅触发一个适配器。
- 适配器注释放入第一条用户消息中。
- 如果导航在对话中途移动到不同的匹配适配器，WebBrain 会注入一条新的 `[Site context changed ...]` 用户消息。
- 当适配器启用时，`UNIVERSAL_PREAMBLE` 被添加到系统提示中。它涵盖 Cookie/同意横幅、付费墙和 PDF 标签页行为。
- 金融适配器包含高风险措辞，必须放在 `finance-generic` 之前。
- Chrome 和 Firefox 的适配器更改应保持镜像同步。

`listAdapters()` 当前的适配器清单：

```text
github, gitlab, stackoverflow, hackernews, gmail, google-docs,
google-calendar, slack, notion, jira, twitter, linkedin, reddit, youtube,
medium, substack, wordpress, amazon, aws, gcp, cloudflare, vercel, nytimes,
wsj, ft, bloomberg, economist, washingtonpost, stripe, coinbase, robinhood,
tradingview, finance-generic, airbnb, booking, expedia, google-maps,
google-flights, kayak, opentable, ebay, walmart, target, etsy, sahibinden,
trendyol, apple, outlook, google-sheets, trello, instagram, tiktok, facebook,
leetcode, hackerrank, greenhouse, workday, discord, whatsapp-web, telegram,
mastodon
```

值得注意的适配器行为：

- 适配器编码页面形状指导，而非脆弱的选择器。
- WordPress 对 `/wp-admin` 和 `/wp-login.php` 是主机无关的。
- Mastodon 使用大型已知主机集加上保守的 URL 匹配，以避免声明网络上每个通用的 `/@user` 路径。
- 金融优先级很重要：除非维护排除项/顺序，广泛的金融匹配可能会遮蔽特定的适配器。

### Claude Chrome

去混淆后的 Claude 代码树有一个设置 UI 声称具有"站点适配器"：

- `settings.html` 公开了一个"站点适配器"开关。
- `settings.js` 读取和写入 `useSiteAdapters`。

然而，在被检查的 Claude 代码树中，未找到支持的适配器注册表、`getActiveAdapter` 等效功能、通用前导注入或站点特定指导注入路径。搜索 WebBrain 风格的适配器标记只找到了设置标签/存储路径。

Claude 最接近的等效功能不是网站适配器：

- 域名权限模式和域名转换提示。
- 托管策略/域名阻止处理。
- 标签上下文提醒中的域名技能元数据。
- UI 包中其他位置的 MCP/Gmail/Google 风格集成标签。

因此，实际的适配器差异是：

- WebBrain 将特定网站的提示增强作为浏览器代理的一级功能。
- 在这个去混淆后的代码树中，Claude Chrome 似乎依赖截图、`find`、域名权限和标签/域名上下文，而非每个站点的适配器笔记。

## 值得借鉴的想法

对 WebBrain 可能有用的 Claude 想法：

- 一个 `find` 工具，使用小型/快速模型在 AX 树上返回模糊元素描述的候选引用。
- 面向模型的控制台和网络请求读取器，用于调试 Web 应用。
- 如果需要模型可调用的录制/导出功能，则添加 GIF/工作流导出工具。
- 快捷方式/工作流列表和执行原语，如果 WebBrain 想要一个独立于 Markdown 技能的可重用工作流层。
- 通过捕获的截图/图像 ID 直接上传图像，如果侧面板图像附件工作流发展的话。

应避免直接复制的想法：

- 只有设置界面的"站点适配器"表面，没有支持的注册表和注入路径。
- 如果 WebBrain 希望保留当前细粒度、可审计的工具语义，则将太多确定性的浏览器操作合并到一个 `computer` 模式中。
- 在稳定的 AX 引用可用时，将截图/坐标控制作为主要路径。

## 文档后续

如果此比较成为面向用户的文档：

- 在发布前从 `src/chrome/src/agent/tools.js` 和 `src/firefox/src/agent/tools.js` 更新工具计数。
- 重新运行 `listAdapters()` 以避免适配器清单过时。
- 将 Claude 细节视为本地逆向工程结果，而非上游产品承诺。
- 如果 Claude 代码树更新，重新检查 `useSiteAdapters` 是否获得了支持的适配器注册表。
