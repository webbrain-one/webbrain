# 智能体工具

DIV 将**模型层级**与**对话模式**分开。

- **层级**（`compact`、`mid`、`full`）是按提供商设置的，控制模型可见的常规浏览器
  智能体工具数量。
- **模式**（`ask`、`act`、`dev`）按对话选择，控制用户允许的任务类型。

| 模式 | 允许的操作 |
|---|---|
| **Ask** | 只读。不点击、不输入、不导航、不下载。 |
| **Act** | 所选层级的常规浏览器工具。 |
| **Dev** | 需要 Mid 或 Full 提供商。附加源码/样式/调试工具（Mid 层级 Dev 还包含更深的 DOM/frame 检查）。Compact 层级的 Dev 会在发送 LLM 请求前被阻止。 |

| 层级 | 目标模型类别 | 常规工具范围 |
|---|---|---|
| `compact` | 极小的本地模型 | 最短提示 + 精简的常规 Act 工具集。无调度、iframe、下载资源或高级 DOM/UI 回退。 |
| `mid` | 有能力的本地模型 | 常见任务工具：下载、调度、iframe 工具、表单校验。不含 Full 独有的高级回退。 |
| `full` | 前沿/云端或大型本地模型 | 全部工具，包括 hover、drag-drop、frames 和 shadow DOM。 |

层级默认值与解析规则记录在
[提供商与模型](providers-and-models.md#提示工具层级和模式)。

## 完整读取 Gmail 会话

Gmail 会话的第一个无障碍结果会提供活动会话可信的
`conversationRootRefId`。完整读取必须仅对该锚定子树使用
`filter:"all"`、`maxDepth:15`，并逐次原样复用 `continuationArgs`，直到
`hasMore:false`。文档根节点的第 2 页及后续页面会进入无关的收件箱行，
不能算作会话覆盖。还必须由 **Collapse all** 单独确认 Gmail 已展开整个会话。

## 工具矩阵

图例：**是** = 可用 · **-** = 不可用 · **C** = 仅 Chrome ·
**Dev** = Dev 模式附加（Mid/Full 提供商；不含 Compact）。

| 工具 | Ask | Compact | Mid | Full | Dev |
|------|:---:|:-------:|:---:|:----:|:---:|
| `get_accessibility_tree` | 是 | 是 | 是 | 是 | - |
| `read_page` | 是 | 是 | 是 | 是 | - |
| `read_pdf` | 是 | 否 | 是 | 是 | - |
| `list_webmcp_tools` | C | 否 | C | C | - |
| `execute_webmcp_tool` | 否 | 否 | C | C | - |
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
| `promote_iframe` | 否 | 否 | 是 | 是 | - |
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
| `upload_file` | 否 | 否 | 是 | 是 | - |
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

`promote_iframe` 是 Mid/Full 层级的常规 Act 工具，不是 Dev 专属附加工具。
使用 Mid 或 Full 提供商的 Dev 会话会从所选 Act 层级继承它。独立页面工作流和
安全检查请参阅 [iframe 定位](accessibility-tree-and-refs.md#iframe-定位)。

> **Shadow DOM 注意：** 可访问性树仅遍历 light DOM。在大量使用 Web 组件的页面
> （Stripe、Salesforce、Shopify）上，请先使用 `get_interactive_elements`；在
> Full Act 或 Dev 模式下使用 `get_shadow_dom` / `shadow_dom_query` 做定向读取。

## 不在表中的工具

**技能工具。** 已加载的技能可为当前运行追加工具 schema。例如内置的
FreeSkillz.xyz 技能可暴露 `read_youtube_transcript` 以及 `resolve_public_media` /
`download_public_media`。这些工具未硬编码：技能加载前（或被移除后）它们并不存在。
即使所属技能已加载，Ask 模式仍会过滤变更类和下载类工具。参见[技能](skills.md)。

**WebMCP（实验性，默认启用）。** 上表中的 `list_webmcp_tools` /
`execute_webmcp_tool` 行仅在设置 → Bridge 中启用**实验性 WebMCP** 时适用。
该设置默认开启；关闭时，这些工具及其提示引导不会包含在模型请求中。诸如
`readOnly` 之类的 WebMCP 注解是页面自行声明的提示，而非安全边界。每次调用都需要
Act 或 Dev 模式、逐次的新确认，以及常规的「能力 × 注册帧来源」权限。WebMCP 目前
需要支持它的 Chrome 构建/页面配置；Firefox 不暴露这些工具。

## Dev 模式页面编辑与诊断

Dev 工具仅在 Dev 模式暴露，且 Compact 层级提供商无法使用 Dev。Chrome 的可逆编辑
工具返回 patch ID：`inject_css` 对应 `remove_injected_css`，`patch_element` 对应
`revert_patch`。

- **`inject_css` / `remove_injected_css`** 通过 `patchId` 应用与撤销临时 CSS。每个
  patch 唯一且绑定到确切的页面文档，其元数据保存在 session storage 中，因此
  service worker 重启不会丢失撤销句柄。导航会使旧句柄失效，而不是让它影响替换后的
  页面。
- **`patch_element` / `revert_patch`** 以精确的前后值修改内联样式、类和属性。在创建
  撤销记录前会规范化浏览器等价的样式名和 HTML 属性名，相互矛盾的设置/移除操作会被
  拒绝，可执行的 URL 属性会拒绝 `javascript:` 值（包括表单 `action`）。
  `highlight_element` 提供临时的指针透明目标覆盖层；由于它插入活动 DOM，因此使用
  临时 Dev patch 权限。
- **`execute_js`** 在页面主世界中执行异步 JavaScript 函数体。Chrome 使用 CDP
  `Runtime.evaluate`，限制 15 秒；Firefox 使用其 MV2 内容脚本求值器。该工具受主机
  权限限制，并需要一次新的提交确认。
- **`read_console`、`inspect_network_requests`、`inspect_event_listeners`** 在
  Chrome 上提供有界诊断。捕获在流式或非流式 Dev 运行前开始，在标签页离开 Dev 模式或
  其对话被清除时停止；离开 Dev 会清空所有仍在捕获的标签页（即使面板已切换标签页），
  移除处理器和缓冲区，并禁用相应的 CDP 域。监听器检查会短暂添加并还原一个内部目标
  属性，在收集祖先节点时会跟随开放的 shadow host，因此使用与临时 Dev patch 相同的
  主机权限。网络头和正文默认省略，敏感头名称（包括常见的 API/订阅密钥变体）在缓冲前
  会被脱敏，页面派生的诊断输出按不可信内容处理。

## 另请参阅

- [添加工具](adding-a-tool.md) — 新增或修改工具的检查清单
- [可访问性树与引用](accessibility-tree-and-refs.md)
- [安全模型](security-model.md) 与[提示注入防御](prompt-injection-defense.md)
