# 离线 RAG 与紧急语料库

DIV 的离线检索增强生成（RAG）流水线允许扩展在没有任何网络连接的情况下，使用本地存储的参考材料回答问题。它建立在末日模式（Apocalypse Mode）的 Wikipedia 存档之上，并新增了紧急语料库（Emergency Box）文本集合——一份涵盖医疗、生存、教育和通信领域公共领域参考文档的精选合集。

独立 WebGPU 聊天没有工具。检索到的段落会先注入提示；所选 WebGPU 文本模型（默认
Compass Tiny v2.1，或 Ternary Bonsai 2 预设）根据这些证据作答，或说明无法回答。切换文本模型
只会改变本地答案生成引擎；检索、证据预算和本地引用流程保持不变。

## 新增功能

- **紧急语料库文本集。** 一份经过验证的约 502 MB ZIP 文件，包含约 570 份公共领域纯文本文档（约 304 MB 源文本），从 `webbrain-one/emergency-box-corpus` 仓库分发。文档为多种语言的 PDF 衍生参考资料。已安装的 Emergency Box PDF 是单独的阅读架，**不**走这条 RAG 检索路径。
- **两套检索引擎，不是一套。** Wikipedia 使用已安装的 Kiwix/ZIM **标题索引**（`title-only`），并在档案带有 Xapian 索引时使用已 vendored 的 GPL 全文 worker。Emergency Box 使用随语料库 ZIP 分发的预构建 SQLite **FTS5 BM25** 索引。Wikipedia 不是 FTS5。
- **语义向量搜索（仅 Emergency Box）。** 可选的 int8 量化多语言 E5 模型（`Xenova/multilingual-e5-small`，约 140 MB 下载），在同样预计算并随 ZIP 分发的段落嵌入上提供余弦相似度搜索。
- **E5 重排序。** 当预构建向量索引对某个源不可用时，可使用同一 E5 模型在设备上对 BM25 候选结果进行重排序。E5 缺失或超时会回退到 BM25，并报告为 `lexical-fallback`（聊天中显示为 “keyword fallback”）。
- **倒数排名融合。** 词汇和语义结果通过倒数排名融合进行合并，然后进行多样化处理以限制冗余（最多 8 个段落，每个文档最多 2 个）。设备端 WebGPU 聊天还会把注入证据限制在约 1,800 个 token，以便本地模型写完答案。
- **本地引用阅读器。** Wikipedia 引用打开 `wikipedia-reader.html`。Emergency Box 段落引用在重新校验纯文本文档后打开 `emergency-text.html`。当对应的 Emergency Box PDF 已安装时，同一条引用还会链接到 `emergency-pdf.html`。没有任何引用会导航到在线网页。
- **RAG 就绪仪表板。** 折叠在末日模式「应急箱」下的 4 格状态网格，以及侧面板中的同一网格，独立显示 Wikipedia 搜索、紧急库搜索、语义排序和本地答案生成。语料库与语义模型的安装在这里，不在 PDF 书架上。
- **源和语言过滤器。** 复选框将检索限制在已安装的源和语言。过滤器在会话之间保持。独立聊天还会按查询路由：在同时选中两个源时，百科类问题只搜 Wikipedia；个人健康和急救问题可以使用两者。
- **事务性语料库更新。** 先前的语料库保持活跃，直到每个文档校验和与索引都得到验证。原子激活意味着失败的更新永远不会让你失去可用的语料库。

## 独立查询如何作答

1. **规范化查询。** 去掉问句前缀，再删除多语言停用词（来自 [ranks.nl](https://www.ranks.nl/stopwords)，打包在 `offline-query-stopwords.js`）。只剩停用词的查询不会回退到原始句子。
2. **为本轮选择来源。** 路由不跨轮次粘滞。在同时选中 Wikipedia 和 Emergency Box 时，百科类问题只搜 Wikipedia。个人健康和急救问题在两者就绪时会同时搜索。在历史条目之后出现的代词追问（例如 “fix it”），如果新消息有自己的区分性词语，不会复用上一轮主题。
3. **搜索。** Wikipedia 在档案有 Xapian 索引时走全文 worker，否则走 ZIM 标题索引。Emergency Box 在文本包为 `ready` 时始终使用 FTS5；当模型和索引可用时再使用 E5 向量。
4. **融合与预算。** 命中结果经融合、去冗余后作为不可信证据封装。WebGPU 生成有上限（当前为 2048 个新 token）。如果模型把预算花在推理上，DIV 会用更短的证据提示重试，而不是编造答案。
5. **本地引用。** 每个保留的段落都有稳定标记（`[WB-E-…]` 或 Wikipedia 对应标记）和本地阅读器 URL。仅当目录中的对应 PDF 已安装时，Emergency Box 引用才会附加 **Open PDF** 链接。

## 技术架构

### 架构

```
agent.js（service worker）
  → offline-retrieval-offscreen.js（MV3 代理）
    → offscreen/offline-rag-host.js（offscreen 文档，拥有检索服务）
      → offline-rag-index.js（主线程 FTS5 + 向量客户端）
        → offline-rag-worker.js（专用 Web Worker，拥有 SQLite Wasm + OPFS SAH 池）
```

Wikipedia 搜索不经过 SQLite。有 Xapian 索引时走 vendored worker，否则使用末日模式中已安装的 ZIM 标题索引，然后进入同一套融合与引用桥接。

Offscreen 文档还托管 E5 重排序 worker（`offline-reranker-worker.js`）。分层代理模式的存在是因为 Chrome MV3 service worker 无法持有 OPFS 同步访问句柄。

### 核心模块

| 模块 | 用途 |
| --- | --- |
| `offline-rag.js` | 浏览器无关的基础原语：分块、分词、引用标记、证据组装、倒数排名融合、多样性选择 |
| `offline-rag-index.js` | FTS5 模式定义、向量索引二进制格式（`WBVE5Q8`）、查询构建器、结果归一化 |
| `offline-rag-worker.js` | 拥有 SQLite Wasm 运行时和 OPFS SAH 池的专用 Web Worker。处理索引构建、FTS5 搜索、int8 向量上的暴力余弦相似度计算 |
| `offline-rag-prompt.js` | 受信提示策略桥接：组装证据、构建带有 `readerUrl` 的引用对象，并在匹配到已安装 PDF 时附加其阅读器 URL |
| `offline-retrieval.js` | 编排 Wikipedia 标题搜索 + 紧急词汇搜索 + 紧急向量搜索 + 语义重排序，然后融合和多样化 |
| `offline-reranker.js` | E5 重排序 worker 的客户端。模型下载/暂停/停止、查询嵌入、候选重排序 |
| `offline-query-stopwords.js` | 打包的 ranks.nl 停用词表，在 Wikipedia 和 Emergency 搜索之前使用 |
| `emergency-corpus.js` | 事务性生命周期：可恢复的 HTTP Range 下载、SHA-256 验证、清单驱动的提取、OPFS 存储、Web Lock 协调 |
| `emergency-corpus-release.js` | 版本指针：当前语料库的固定 URL、SHA-256、字节数、段落数 |
| `zim-xapian.js` | 通过已 vendored 的 Xapian/libzim Wasm worker 做 Wikipedia ZIM 全文搜索 |

### 存储布局

- **OPFS**（Origin Private File System）：
  - `.webbrain-offline-rag-sahpool-v1/` — SQLite SAH 池目录
  - `webbrain-offline-rag/emergency-box-text/downloads/` 和 `installs/` — 紧急语料库文件
- **IndexedDB**（`webbrain_offline_rag`）：语料库生命周期状态、活跃版本、清单、安装 ID、索引路径、向量索引声明
- **IndexedDB**（`webbrain_emergency_box`）：已安装 PDF/资源记录，用于 **Open PDF** 引用链接
- **遗留段落向量缓存**：上限 256 MB

### FTS5 模式

FTS5 **只索引 Emergency Box 段落**。

```sql
CREATE VIRTUAL TABLE passages USING fts5(
  passage_id UNINDEXED, document_id UNINDEXED, source_id UNINDEXED,
  title, language UNINDEXED, collection, source UNINDEXED, license UNINDEXED,
  locator, body, search_terms,
  passage_sha256 UNINDEXED, token_estimate UNINDEXED, ordinal UNINDEXED,
  reader_url UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

BM25 评分权重：`body` 7、`search_terms` 1、`locator` 0.6、`collection` 2、`title` 4。

### 向量索引格式

带 `WBVE5Q8` 魔术头的自定义二进制格式：
- 4096 字节头部，包含 JSON 元数据（模型 ID、修订版、数据类型、段落数、维度）
- int8 量化的段落向量（每个 384 维）
- Float32 L2 范数用于余弦相似度
- Worker 中的暴力余弦相似度计算（251K 段落是可行的）

### 段落分块

文档被分割为 180–700 个 token 的段落（目标约 420）：
1. 按换行符分割为段落
2. 检测标题（markdown `#`、`Chapter` 等模式、编号章节、全大写行）
3. 按句子边界分割过大的段落
4. 合并相邻的小段落直至达到目标 token 数
5. 每个段落获得基于文档 + 定位符 + 内容哈希的确定性 `passageId`

### 检索模式

这些模式适用于 Emergency Box 排序。Wikipedia 在档案有索引时走 Xapian 全文，否则走标题查找。

| 模式 | 描述 |
| --- | --- |
| `hybrid-full-vector` | 直接使用预构建的 E5 向量（紧急语料库） |
| `semantic-reranked` | 对 BM25 候选使用 E5 重排序 |
| `lexical-fallback` | 仅 BM25（无 E5 模型可用或 E5 超时） |

### 优雅降级

- 无 E5：Emergency Box 回退到 BM25 词汇搜索
- 无紧急语料库：仅搜索 Wikipedia 源
- 两者都没有：报告离线搜索不可用
- Xapian Wikipedia 全文搜索：档案有索引时使用；否则回退到标题查找
- 检索为空：本地模型不得编造医疗建议

## 供应商库

所有供应商库均以 vendored 文件形式提交。不进行运行时可执行代码获取。仅模型权重和语料库数据由用户下载。

| 库 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| fflate | 0.8.3 | MIT | 流式 ZIP 解压 |
| SQLite Wasm | 3.53.0-build1 | Apache-2.0 | Emergency Box 语料库的 FTS5 全文搜索 |
| Transformers.js | 4.2.0 | Apache-2.0 | E5 推理运行时 |
| ONNX Runtime Web | 1.27.0 | MIT | WASM/GPU 推理后端 |
| E5 模型 | multilingual-e5-small q8 | Apache-2.0 | 语义嵌入（单独下载） |

## 许可证

紧急语料库、SQLite、fflate 和 Transformers.js 均采用宽松许可证，本身不会引入 copyleft 条款。尽管如此，DIV 33.0.0 及更高版本仍采用 GPL-3.0-or-later，因为发布的扩展集成了采用 GPL 许可证的 Xapian/libzim 运行时。

Xapian/libzim Wikipedia 全文运行时已 vendored，许可证为 GPL。详见 [offline-rag-licensing.md](offline-rag-licensing.md)。

## 延伸阅读

- [末日模式](apocalypse-mode.md) — Wikipedia 存档管理
- [离线 RAG 许可证](offline-rag-licensing.md) — GPL 决策记录
- [发布检查清单](offline-rag-release-checklist.md) — 验证关卡和测量
