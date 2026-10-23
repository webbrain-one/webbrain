# 本地化

---

## 工作原理

UI（侧面板、设置、追踪页面）通过 `src/chrome/src/ui/i18n.js` 中一个简单的基于键的系统进行翻译。它在 Chrome 和 Firefox 中工作方式相同。

### 架构

```
src/chrome/src/ui/
├── i18n.js                # 核心：t()、setLocale()、applyDOMTranslations()
└── locales/
    ├── en.js              # 英语 — 标准版本，始终完整
    ├── ar.js              # 阿拉伯语
    ├── bn.js              # 孟加拉语
    ├── de.js              # 德语
    ├── es.js              # 西班牙语
    ├── fa.js              # 波斯语
    ├── fr.js              # 法语
    ├── he.js              # 希伯来语
    ├── hi.js              # 印地语
    ├── id.js              # 印尼语
    ├── ja.js              # 日语
    ├── ko.js              # 韩语
    ├── ms.js              # 马来语
    ├── nl.js              # 荷兰语
    ├── pl.js              # 波兰语
    ├── pt.js              # 葡萄牙语
    ├── ru.js              # 俄语
    ├── th.js              # 泰语
    ├── tl.js              # 菲律宾语
    ├── tr.js              # 土耳其语
    ├── uk.js              # 乌克兰语
    ├── vi.js              # 越南语
    └── zh.js              # 中文
```

侧边栏的语言菜单会列出 `i18n.js` 中 `LANGUAGES` 的全部 **23** 种语言（英语和中文置顶；
其余按英文名排序）。
### 关键函数

```js
import { t, setLocale, getLocale, applyDOMTranslations, LANGUAGES } from './i18n.js';

// 翻译一个键
t('sp.btn.send')              // → "发送"
t('sp.status.connected', { model: 'gpt-5' })  // → "已连接 (gpt-5)"

// 切换语言
setLocale('tr');
applyDOMTranslations(document);  // 重新翻译当前页面

// 可用语言
LANGUAGES  // → [{ code: 'en', label: 'English' }, { code: 'tr', label: 'Türkçe' }, ...]
```

### 英语回退

如果活动语言中缺少某个键，`t()` 函数会回退到 `en.js`：

```js
export function t(key, params) {
  const dict = DICTS[currentLocale] || DICTS.en;
  let s = dict[key];
  if (s == null) s = DICTS.en[key];  // 英语回退
  if (s == null) return key;         // 最后手段：返回原始键
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
  }
  return s;
}
```

这意味着部分翻译也可以安全发布——缺失的键只会显示英语。

### DOM 翻译

HTML 元素使用 `data-i18n` 属性：

```html
<button data-i18n="sp.btn.send">发送</button>
<span data-i18n-title="sp.tooltip.help">?</span>
<input data-i18n-placeholder="sp.input.ask_placeholder">
```

`applyDOMTranslations(root)` 处理 `data-i18n`、`data-i18n-html`、`data-i18n-title`、`data-i18n-placeholder` 和 `data-i18n-aria-label`。

---

## 添加新语言

### 步骤 1：创建翻译文件

将 `src/chrome/src/ui/locales/en.js` 复制到 `src/chrome/src/ui/locales/<code>.js` 并翻译其中的值。

该文件导出一个扁平键→字符串映射：

```js
export default {
  'brand': 'DIV',
  'sp.btn.send': '发送',
  // ... 来自 en.js 的所有键
};
```

### 步骤 2：在 i18n.js 中注册

添加到导入、字典和 `LANGUAGES` 数组中：

```js
import de from './locales/de.js';

const DICTS = { en, es, fr, tr, zh, ru, uk, ar, ja, ko, id, th, ms, tl, de };

export const LANGUAGES = [
  // ... 现有条目 ...
  { code: 'de', label: 'Deutsch' },
];
```

### 步骤 3：同步到 Firefox

将语言文件复制到 `src/firefox/src/ui/locales/<code>.js`，并同样更新 `src/firefox/src/ui/i18n.js`。

### 步骤 4：测试

1. 打开侧边栏
2. 在左上角的语言菜单中选择新语言
3. 验证侧面板、设置和追踪页面是否正确渲染
4. 检查缺失的键是否优雅地回退到英语
5. 如果添加阿拉伯语或希伯来语，测试 RTL 布局

---

## 翻译提示

- **保持占位符不变**：`{model}`、`{error}`、`{count}` 必须与英语文件中的完全一致。代码会在运行时将这些替换为实际值。
- **不要翻译品牌名称**："DIV"在所有语言中都保持英文。
- **注意值中的 HTML**：某些键包含 HTML（`data-i18n-html`）。保留 HTML 结构但翻译文本内容。
- **复数形式**：系统没有复数形式。在需要时使用 `{n} 项` 风格或代码级别的复数处理。
- **工具标签**：以 `tool.` 开头的键在侧面板中用作紧凑的步骤标签。请保持简短（2–4 个词）。

### 键命名约定

| 前缀 | 区域 |
|---|---|
| `sp.` | 侧面板 UI |
| `st.` | 设置、提供商和权限页面 |
| `tr.` | 追踪页面 |
| `tool.` | 工具标签 |
| `ob.` | 引导流程 |

---

## 维护

- `en.js` 是标准真实来源。添加新键时，始终先添加到 `en.js` 中。
- 向 `en.js` 添加键后，同时添加到所有其他语言文件中。对于初始提交，使用英语值作为占位符是可以接受的。
- `en.js` 中更新的字符串应标记给翻译人员——目前没有自动同步机制。
