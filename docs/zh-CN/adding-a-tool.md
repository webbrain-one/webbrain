# 添加工具

本指南介绍了向 DIV 代理添加新工具的完整流程——从模式定义到执行分发再到结果处理。

---

## 概述

有两种方式添加模型可调用的工具：

- **核心工具**：产品拥有的浏览器、DOM、网络、下载、调度器或特权行为，在 DIV 源码中实现。请使用下面的完整清单。
- **技能工具**：用户可导入、可移除的 HTTP 或下载任务集成，在技能的 `webbrain-tools` 清单中声明。当工具最适合作为受信任的第三方扩展而非 DIV 核心原语时，使用此方式。

核心工具需要在三个层面进行修改：

1. **工具模式** — 在 `tools.js` 中定义名称、描述和参数
2. **工具执行** — 在 `agent.js` 的 `executeTool()` 或内容脚本中添加处理器
3. **UI 标签**（可选）— 在 `locales/*.js` 中添加本地化显示名称

大多数工具还需要同时同步到 Chrome 和 Firefox 构建版本。

---

## 选项 0：从技能中暴露工具

如果集成是一个受信任的第三方 HTTP 服务，优先使用技能工具，而非硬编码核心工具。技能工具可从设置 -> 技能中移除，并可通过编辑清单重命名或替换。只读查找使用 `kind: "http"`，创建临时任务、暴露文件 URL 并需要浏览器下载功能的服务使用 `kind: "httpDownloadJob"`。

在技能 markdown 中添加一个围栏 `webbrain-tools` JSON 块：

````markdown
# 示例技能

在以下情况下使用此技能...

```webbrain-tools
{
  "tools": [
    {
      "id": "example_lookup",
      "name": "example_lookup",
      "description": "从 Example 读取公共元数据。在下载媒体前使用此工具。",
      "kind": "http",
      "readOnly": true,
      "method": "POST",
      "endpoint": "https://api.example.com/v1/lookup",
      "defaultArgs": {},
      "activeTabUrlArg": "url",
      "inputUrlArg": "url",
      "inputUrlAllowlist": [
        { "host": "example.com", "paths": ["/"] }
      ],
      "resultPolicy": "untrusted",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "可选的 URL。省略则使用当前活动标签页。"
          }
        },
        "required": []
      }
    }
  ]
}
```
````

下载任务技能使用相同的清单围栏，但声明任务端点。端点来源必须在创建、状态、文件和清理 URL 之间保持一致：

````markdown
```webbrain-tools
{
  "tools": [
    {
      "id": "example_download_media",
      "name": "example_download_media",
      "description": "从 Example 下载公共媒体文件到浏览器下载文件夹。",
      "kind": "httpDownloadJob",
      "readOnly": false,
      "requiresDownloadPermission": true,
      "method": "POST",
      "endpoint": "https://api.example.com/v1/media/jobs",
      "job": {
        "idField": "job_id",
        "statusEndpoint": "https://api.example.com/v1/media/jobs/{job_id}",
        "fileEndpoint": "https://api.example.com/v1/media/jobs/{job_id}/file",
        "cleanupEndpoint": "https://api.example.com/v1/media/jobs/{job_id}",
        "pollIntervalMs": 1000,
        "timeoutMs": 90000
      },
      "activeTabUrlArg": "url",
      "inputUrlArg": "url",
      "resultPolicy": "untrusted",
      "modes": ["act"],
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string" },
          "filename": { "type": "string" }
        },
        "required": []
      }
    }
  ]
}
```
````

连接方式：

- `agent/skills.js` 解析已启用技能的清单，并在 LLM 调用时构建工具模式。
- 清单块会从提示指令中剥离，因此端点 JSON 不会被复制到主系统提示中。
- `agent.js` 通过 `network-tools.js` 中的 `executeHttpSkillTool()` 路由已声明的技能工具调用。
- 技能工具当前需要 HTTPS 和 `credentials: "omit"`。`kind: "http"` 工具必须是 GET 或 POST 且 `readOnly: true`。`kind: "httpDownloadJob"` 工具必须是 POST，`readOnly: false`，`requiresDownloadPermission: true`，并声明同源的状态/文件/清理端点模板，包含 `{job_id}`。

安全模型：

- 导入/启用技能是对已声明 HTTPS 端点的信任边界。导入后，已声明的技能工具可以将其声明的输入发送到该端点，无需每次调用确认。
- 下载任务技能工具仍仅为操作模式（Act 或 Dev），并在保存文件之前通过正常的下载权限检查。
- 将任何第三方/页面/文档响应标记为 `resultPolicy: "untrusted"`，以便结果包裹在 `<untrusted_page_content>` 中，在摘要过程中不会成为受信任的指令。
- 当服务应仅接收特定的公共 URL 系列时，使用 `inputUrlAllowlist`。

当工具需要超出下载、cookie、内容脚本 DOM 访问、变更权限、自定义权限检查或非 HTTP 执行的浏览器权限时，请使用核心工具。

---

## 步骤 1：定义模式

打开 `src/chrome/src/agent/tools.js` 并在 `AGENT_TOOLS` 数组中添加一个条目：

```js
{
  type: 'function',
  function: {
    name: 'my_new_tool',
    description: '该工具的用途、使用时机以及模型应期望的返回值。明确说明错误情况。',
    parameters: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: '此参数的用途。',
        },
        param2: {
          type: 'number',
          description: '另一个参数。',
        },
      },
      required: ['param1'],
    },
  },
},
```

### 模式规则

- **描述质量很重要**：LLM 通过阅读此描述来决定何时调用工具。包括：功能、相对于替代方案的优先使用时机、预期的错误以及任何副作用。
- **参数应命名良好**：模型从参数名称 + 描述推断语义。
- **使用枚举** 表示受限选择：
  ```js
  param: { type: 'string', enum: ['option1', 'option2'] }
  ```
- **必填字段**：仅列出真正必需的字段。可选字段为模型提供灵活性。
- **保持描述简洁**：最多约 2–3 句。完整的工具列表在每次 LLM 调用时都会发送。

### 工具分类

- **Ask 工具**（语义/只读，适用于所有模型）：添加到 `tools.js` 中的 `ASK_ONLY_TOOLS`。除非真正属于普通 Ask，否则不要将开发者/调试读取工具放在此处。
- **普通操作工具**：将模式添加到 `AGENT_TOOLS`，然后通过 `COMPACT_TOOL_NAMES`、`MID_TOOL_NAMES` 或 Full Act 默认值决定哪些提供商层级可以看到它。
- **仅 Dev 工具**：将不应出现在普通 Act 中的源码/样式/调试工具添加到 `DEV_ONLY_TOOL_NAMES`。
- **Dev 扩展工具**：将应保留在 Full Act 中但也应提供给 Mid 层级 Dev 的工具添加到 `DEV_EXTENDED_TOOL_NAMES`。Shadow/框架工具使用此模式。
- **导航工具**：添加到 `Agent.NAV_TOOLS`（导航时自动截图）
- **状态变更工具**：添加到 `Agent.STATE_CHANGE_TOOLS`（状态变更时自动截图）
- **易导航工具**：当成功调用应检查 URL/历史变更时，添加到 `Agent.NAV_PRONE_TOOLS`（`navigate`、`go_back`、`go_forward`、类似点击的工具）
- **URL 族工具**：如果工具接受应进行桶身份哈希以实现循环检测的 URL 参数，更新 `loop-bucket.js` 中的 `URL_FAMILY_TOOLS`

保持模式与层级分离：模式为 `ask | act | dev`；层级为 `compact | mid | full`。`getToolsForMode('dev', { tier: 'mid' })` 返回 Mid Act 工具加 Dev 附加组件。`getToolsForMode('dev', { tier: 'compact' })` 故意为空，因为 Compact Dev 在 LLM 请求之前就被阻止。

---

## 步骤 2：实现处理器

### 选项 A：内容脚本工具（DOM 交互）

在 `src/chrome/src/content/content.js` 中添加处理器：

```js
if (msg.action === 'my_new_tool') {
  const result = await myNewToolHandler(msg.args);
  sendResponse(result);
}
```

然后在 `agent.js` 的 `executeTool()` 中添加分发逻辑：

```js
if (name === 'my_new_tool') {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'my_new_tool',
      args,
    });
    return response || { success: false, error: '页面无响应' };
  } catch (e) {
    // 内容脚本可能尚未注入——注入并重试
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js'],
    });
    const response = await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'my_new_tool',
      args,
    });
    return response || { success: false, error: '注入后无响应' };
  }
}
```

### 选项 B：后台/Service Worker 工具（网络、chrome.* API）

直接在 `executeTool()` 中添加处理器：

```js
if (name === 'my_new_tool') {
  try {
    const result = await doSomething(args);
    return { success: true, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```

### 选项 C：CDP 驱动的工具（仅 Chrome）

使用 `cdpClient` 进行受信任事件 / DOM 查询：

```js
if (name === 'my_new_tool') {
  try {
    await cdpClient.attach(tabId);
    const result = await cdpClient.evaluate(tabId, `/* 在页面中运行的 JS */`);
    return { success: true, value: result?.result?.value };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```

---

## 步骤 3：结果格式

工具结果必须是 JSON 可序列化的。遵循以下约定：

```js
// 成功
{ success: true, data: ..., note: '...' }

// 错误
{ success: false, error: '关于出错的易读描述' }
```

### 特殊结果字段

这些字段在字符串化之前被剥离，并由 `_executeToolBatch` 特殊处理：

| 字段 | 类型 | 用途 |
|---|---|---|
| `_attachImage` | `string`（data URL） | 作为 `image_url` 块推送到后续用户消息中，适用于支持视觉的提供商 |
| `_attachDocument` | `object` | 作为 Anthropic `document` 内容块推送，用于原生 PDF 透传 |
| `done` | `boolean` | 通知 `_executeToolBatch` 停止循环并返回 `summary` |
| `summary` | `string` | `done: true` 时的最终答案 |

### 工具结果大小

`_limitToolResult()` 将序列化结果限制在 **8,000 字符**以内。如果工具返回大量数据（文本页面、长列表），结果将被静默截断。考虑：
- 返回带有 `truncated: true` 标志的摘要
- 支持分页（如 `get_accessibility_tree` 通过 `page` 参数实现）
- 让模型回调用以获取更多详情

---

## 步骤 4：添加 UI 标签（可选）

如果工具应在侧面板中具有人类可读的标签，请将其添加到 `src/chrome/src/ui/locales/en.js`：

```js
'tool.my_new_tool': '我的新工具',
'tool.my_new_tool.with_param': '带有 {param} 的我的新工具',
```

以及 `locales/*.js` 下的每个其他语言文件。

---

## 步骤 5：同步到 Firefox

将更改复制到 `src/firefox/src/agent/tools.js`、`src/firefox/src/agent/agent.js` 和 `src/firefox/src/content/content.js`。

某些工具故意仅限 Chrome（需要 CDP、离屏文档、标签页捕获或其他仅 Chrome 的 API）。对于这些工具，将模式添加到两个构建版本，但在 Firefox 处理器中实现明确的错误或无操作：

```js
// Firefox：不支持
if (name === 'chrome_only_tool') {
  return { success: false, error: '此工具在 Firefox 上不可用。' };
}
```

---

## 步骤 6：安全分类

每个新工具都应进行安全分类：

1. **能否读取或窃取页面数据？** → 如果读取输入值，添加凭据字段敏感性检查。
2. **能否执行破坏性变更？** → 考虑是否应通过 `/allow-api` 进行门控。
3. **能否被提示注入？** → 如果工具接受最终出现在工具调用参数中的用户提供的字符串，在工具描述中记录注入面。
4. **哪种模式/层级应暴露它？** → 仅 Ask 语义读取放入 `ASK_ONLY_TOOLS`；常见操作工具应加入能可靠使用它们的最小普通层级；仅开发者使用的源码/样式/调试工具放入仅 Dev；Mid 仅在调试期间应获得的 Full 回退工具放入 Dev 扩展。
5. **能否将重复的 UI 操作快捷为网络调用？** → 保持 UI 优先策略不变。后台 API 观察器可以在点击循环期间呈现确切的 XHR/fetch URL+方法提示，以及当同源 body/header 重放材料可用时呈现不透明的 `replayRequestId`。变更性的 `fetch_url` 调用仍需要会话的 `/allow-api` 状态，隐藏的表单令牌必须保持在重放 ID 之后，而不是暴露给模型。GET 请求和非网络能力仍使用正常的权限检查。

完整威胁模型请参见 `docs/security-model.md`。

---

## 步骤 7：测试

1. 验证工具出现在 LLM 的可用工具中（在详细调试日志中检查 `getToolsForMode()`）
2. 测试处理器运行并返回正确的结果格式
3. 测试错误处理（无效参数、页面缺失、网络故障）
4. 测试 Ask、Act 和 Dev 模式（如适用），包括 Compact/Mid/Full 层级边界
5. 在 Chrome 和 Firefox 构建版本上测试
6. 验证结果在侧面板中正确显示

---

## 检查清单

- [ ] 模式已添加到 `src/chrome/src/agent/tools.js` 的 `AGENT_TOOLS` 中
- [ ] 模式已同步到 `src/firefox/src/agent/tools.js`
- [ ] 处理器已添加到两个 `agent.js` 文件的 `executeTool()` 中
- [ ] 内容脚本处理器已添加到两个 `content.js` 文件中（如适用）
- [ ] 已添加到正确的 Ask/Act/Dev 暴露常量中（`ASK_ONLY_TOOLS`、层级集合、`DEV_ONLY_TOOL_NAMES` 或 `DEV_EXTENDED_TOOL_NAMES`）
- [ ] 当工具表面发生变化时，Compact、Mid、Full 和 Dev Compact 阻止行为已覆盖
- [ ] 已添加到 `Agent.NAV_TOOLS` / `Agent.STATE_CHANGE_TOOLS` / `Agent.NAV_PRONE_TOOLS`（如果它会导航、更改页面状态或应检查导航）
- [ ] 安全分类已记录
- [ ] 当公开工具表面或执行流程发生变化时，README / 架构文档已更新
- [ ] UI 标签已添加到 `locales/*.js`（如果需要）
- [ ] 相应系统提示中的工具描述已更新（如果模型应主动了解它）
