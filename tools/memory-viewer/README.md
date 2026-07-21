# 记忆查看器

用来检查 `memory/rag/history.jsonl`、`events.jsonl`，以及当前 RAG 最终会向 Agent 注入什么。

## 启动

双击 `start.cmd`，然后打开：

```text
http://127.0.0.1:8766
```

也可以在项目根目录运行：

```powershell
node .\tools\memory-viewer\server.mjs
```

## 两种搜索

### 纯搜索

- 直接搜索 `history.jsonl` 和 `events.jsonl`。
- 可以只查原始对话或只查事件。
- 不调用大模型，也不调用 embedding API。
- 适合确认某句话、某件事、某个日期是否已经存在于记忆库。

### 关联搜索测试

- 直接调用项目当前的 `memory/rag/retrieve.mjs`。
- 查询门槛、时间解析、BM25、向量相似度、阈值、片段整理都和真实 Hook 共用同一份代码与配置。
- 页面里的“最终注入内容”就是当前 Hook 会交给 Agent 的文本；显示“不会注入记忆”时，真实 Hook 也不会注入。
- 如果 `embedding.enabled` 为 `true`，普通关联查询通常会调用一次 embedding API。纯日期过滤或被查询门槛跳过时不会调用。

查看器只监听 `127.0.0.1`，只读取记忆文件，不会修改、重建或清空它们。
