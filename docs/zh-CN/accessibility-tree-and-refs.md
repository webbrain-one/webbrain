# 无障碍树与 ref_id 系统

无障碍树（AX）子系统是代理的主要页面交互路径。它取代了较早的基于索引的 `get_interactive_elements`，适用于几乎所有流程。

---

## 架构

按顺序加载两个内容脚本：

1. **`accessibility-tree.js`** — 树构建器与 `ref_id` 注册表
2. **`content.js`** — 使用该树的工具处理器

两者均在 `document_idle` 时注入到 `<all_urls>` 页面中。

---

## 树（`accessibility-tree.js`）

通过内部方法 `generateAccessibilityTree(...)`（由代理通过 `executeScript` 调用）构建树，并在 `window` 上安装引用解析 API（`__wbElementMap`、`__wb_ax_lookup`、`__wb_ax_release`）：

### `generateAccessibilityTree(filter, maxDepth, maxChars, ref_id, page)`

遍历 DOM 并生成扁平的缩进文本树：

```
dialog "添加产品" [ref_166]
 heading "添加产品" [ref_167]
 button "关闭" [ref_169]
 textbox "名称" [ref_170] type="text" placeholder="产品名称" value="namaz"
 combobox "计费周期" [ref_180] type="button"
```

**参数：**
| 参数 | 默认值 | 描述 |
|---|---|---|
| `filter` | `'all'` | `'all'`（整个 DOM）、`'visible'`（视口内可见节点）、`'interactive'`（仅可点击/可输入元素） |
| `maxDepth` | `15` | 树的最大遍历深度 |
| `maxChars` | — | 输出长度的硬限制（超出时自动切片，`autoDegraded:true`） |
| `ref_id` | — | 锚定到特定元素的子树，而非 `document.body` |
| `page` | — | 树被截断时分页结果的基于 1 的块编号 |

**输出格式：**
```
role "accessible name" [ref_id] href="..." type="..." placeholder="..." value="..."
```

缩进为每个树深度级别 1 个空格（跳过的通用容器不增加深度）。

### `__wb_ax_lookup(ref_id)`

将 `ref_N` 字符串解析回实时的 DOM `Element`。如果元素已从 DOM 中移除，则返回 `null`。

### `__wb_ax_suggest(ref_id, n)`

当查找失败时，返回最多 `n` 个附近仍然有效的 `ref_id`，以便错误信息可以引导模型回到正轨。

---

## ref_id 注册表（`window.__wbElementMap`）

### 工作原理

- 一个普通对象（`Object.create(null)`），以 `ref_N` 字符串为键
- 每个值是一个指向 DOM 元素的 `WeakRef`
- 一个单调递增的计数器（`window.__wbRefCounter`）分配下一个 `ref_N`
- 每次构建树时，映射表会被**部分清理**：`deref()` 返回 `null` 的条目被清除。存活的条目在多次调用间保留。

### 稳定性特性

- **在同一轮次内**：从 `get_accessibility_tree` 获取的 `ref_id` 保证在同一轮次中有效。
- **跨轮次**：只要元素在 DOM 中存活，`ref_id` 就有效。因导航或 DOM 操作而移除的元素将变得不可解析（工具返回明确的"未找到"错误，并建议重新读取树）。
- **SPA 导航后**：映射表仍然存在，但旧路由中的大多数元素已消失——它们的引用将失效。代理应在导航后重新调用 `get_accessibility_tree`。

### 为什么使用 WeakRef

如果没有 `WeakRef`，映射表将固定它索引过的每个元素，阻止垃圾回收，并在长时间运行的页面（SPA、聊天应用）上导致内存泄漏。使用 `WeakRef` 后，浏览器可以自然地 GC 已移除的元素。代价是即使元素存在，`deref()` 也可能返回 `null`（如果 GC 已运行）——但在实践中，这在单个代理轮次内（亚秒级）很少发生，且代理在导航时无论如何都会重新读取树。

---

## AX 工具

### `get_accessibility_tree`

主要的页面读取工具。返回渲染后的树字符串及元数据（`truncated`、`hasMore`、`autoDegraded`、`notice`）。

代理在几乎每一轮中都将此作为首个操作——它比截图更快、更便宜，并且适用于纯文本模型。

### `click_ax({ref_id})`

1. 通过 `__wb_ax_lookup()` 解析 `ref_id`
2. 滚动到视图中（`scrollIntoView({block: 'center'})`）
3. 聚焦元素
4. 触发 `el.click()`

返回 `{success, method, tag, rect, name, href?, navigates?, hint?}`。

在 Chrome 上，通过 CDP `Input.dispatchMouseEvent` 触发点击 → 受信任事件。在 Firefox 上，使用合成事件 `el.click()`。

### `type_ax({ref_id, text, clear})`

1. 解析 `ref_id`
2. 使用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` 绕过 React/Vue 受控组件包装器
3. 触发 `input` + `change` 事件
4. 对于 contenteditable：设置 `textContent` + 触发 `beforeinput` + `input`

拒绝不可输入的类型（checkbox、radio、submit、file），并返回明确错误。

### `set_field({ref_id, text, clear, submit})`

原子化地聚焦 +（可选清除）+ 输入 +（可选提交）。相当于 `click_ax` + `type_ax` 的一次性操作。

**支持组合框的提交**：当 `submit:true` 时，工具检测字段是否为组合框/自动完成（role=combobox、aria-autocomplete、aria-controls 指向 listbox，或页面上可见的 listbox）。如果是，则触发 `ArrowDown` → `Enter`，带有小延迟以提交高亮选项。否则回退到 `form.requestSubmit()` 或普通 `Enter` 按键。

---

## 叠加层提升

构建树时，打开的对话框、列表框、菜单和 `[aria-expanded=true]` 组合框会在树顶部的 `[open overlays]` 横幅下输出——位于页面其余内容之前。这确保通过 portal 渲染的弹窗（React、Radix、Stripe）能够通过模型看到的 3,000 字符软限制。

---

## 无障碍名称解析优先级

`getAccessibleName(el)` 遵循以下顺序：

1. `<select>` 选中选项的文本
2. `aria-label`
3. `aria-labelledby` — 连接所有引用的 id 的文本
4. `placeholder`
5. `title`
6. `alt`
7. `<label for>` 查找
8. 输入 `value`（仅 submit/button/reset——从不用于文本输入）
9. 直接文本内容
10. `innerText` 回退（适用于按钮、链接、summary）
11. 前一个兄弟文本（未标记表单字段模式："每 1 个月" → 前面的文本即为标签）
12. 直接文本回退

---

## Shadow DOM 穿透

### Chrome

CDP 客户端（`cdp-client.js`）可以通过 `Runtime.evaluate` 穿透**封闭**的 shadow root：

```js
await cdpClient.evaluate(tabId, `
  (() => {
    const host = document.querySelector('my-component');
    return host.shadowRoot ? 'open' : 'closed';
  })()
`);
```

对于更深层次的查询，`shadow_dom_query` 使用 CDP 的 `DOM.getDocument` + `DOM.querySelector` 进入封闭的 root。

工具暴露是分层的：`get_shadow_dom`、`shadow_dom_query` 和 `get_frames` 是完整行为（Full Act）的回退方案，开发者模式（Dev mode）也将其添加给中端（Mid-tier）提供商，以便页面调试运行时可以检查 Web Component 和 iframe 结构，而无需给中端正常行为（Mid normal Act）提供完整的 Full UI 回退功能。

### Firefox

只有**开放**的 shadow root（`element.shadowRoot`）可访问。封闭的 root 无法通过内容脚本读取。`execute_js` 在两个版本的开发者模式中都可用，但普通页面 JavaScript 仍无法取得封闭 root，树构建器也无法访问它。

---

## iframe 定位

`get_frames`、`iframe_read`、`iframe_click` 和 `iframe_type` 可与跨域 iframe 一起使用，因为扩展程序直接将内容脚本注入每个框架，绕过了同源策略。

树构建器默认**不会**递归进入 iframe。代理必须显式调用 `iframe_read` 或 `get_frames` 来发现和读取 iframe 内容。

---

## 常见故障模式

| 故障 | 症状 | 修复方法 |
|---|---|---|
| 元素从 DOM 中移除 | `click_ax` 返回"未找到" | 重新读取树；页面可能已重新渲染 |
| SPA 导航后引用过期 | 所有引用失效 | 代理应在 `/navigate` 或 `wait_for_stable` 后重新读取树 |
| Shadow DOM 封闭 root | 树显示 `<my-component>` 但不显示子元素 | 在 Chrome 中使用 `get_shadow_dom` + `shadow_dom_query`；Firefox 无法穿透封闭 root |
| iframe 不在树中 | 代理找不到 iframe 内容 | 调用 `get_frames`，然后使用 `iframe_read` / `iframe_click` |
| 树被截断 | `truncated: true` + `hasMore: true` | 使用 `page: nextPage` 或 `ref_id` 调用 `get_accessibility_tree` 以放大查看 |
| Portal 叠加层不可见 | 树显示组合框但不显示下拉菜单 | 叠加层已被提升到 `[open overlays]` 部分——使用 `filter: 'all'` 重新读取 |

---

## 调试

- 树输出在详细模式（侧面板切换）下可见
- 页面控制台中的 `window.__wbElementMap` 列出所有存活的引用
- `window.__wb_ax_lookup('ref_42')` 测试特定引用
- 深度详细调试日志（Shift+点击详细按钮）转储最近 200 对 LLM 请求/响应，包括 AX 工具结果
