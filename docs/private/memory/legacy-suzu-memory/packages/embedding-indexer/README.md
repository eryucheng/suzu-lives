# 长期记忆向量索引

本模块负责把长期记忆库中的结构化节点和已经归档为证据节点的逐字消息增量向量化。它不读取宿主的整份原始会话文件，也不决定哪些内容应该成为结构化长期记忆。

默认索引所有 `active` 长期节点，但排除旧版未分型的 `topic_or_episode` 兼容节点。`utterance` 进入独立的情景证据索引通道，不与审核后的长期结论争夺主结论。为避免“吃了”“是的”这类短句失去语义，逐字消息的向量文档会在不改写原节点的前提下，附带一跳 `followed_by` 相邻交流作为只读检索上下文。

每个节点使用确定性的标题、正文、主体、状态与时间字段生成索引文本，并保存其 SHA-256。再次运行时只调用新增节点或正文发生变化的节点；人工编辑记忆后，核心层也会主动删除该节点的旧向量。

模块还提供可选的 `generateMemoryRetrievalContexts()`。代码先执行选择门禁：正文已经能独立说明主体、事件与时间的节点不调用模型；只有正文过短或以“这件事、他后来”等未解决指代开头的节点才生成检索上下文。低风险的短事实只调用一次提案器并经过本地 Schema 与边界门禁；存在未解决指代、主体或现实边界、状态、时间、否定关系时，再调用独立审查器检查是否新增事实或改错边界。审查通过后，派生内容以 `policyVersion + sourceHash` 单独版本化保存；它只进入 FTS 与向量索引，永远不改写记忆正文。原节点字段发生变化时，旧派生上下文自动失效并保留为审计记录。

标准 `process-events` 流水线只在长期节点归档后登记持久化维护任务，不会在同一回合生成检索上下文或向量。后续语义维护为确实需要补充检索表达的节点生成上下文，Embedding 维护再增量向量化新增或变化节点。索引报告给出 `selected`、`skipped`、`added`、`reused`、`rejected` 和 `failed`；上下文生成失败或被审查器拒绝不会伪造结果，也不会阻止原记忆归档。

当前 OpenAI 兼容 provider 支持一次提交最多 10 条文本。写入以单批事务完成；单批失败不会删除已有向量，报告会保留失败节点 ID。配置费用流水路径后，每次真实 API 调用都会追加 `memory-index-embedding` 用量事件。

CLI 示例：

```powershell
node .\packages\embedding-indexer\src\cli.mjs `
  --database="D:\path\memory.db" `
  --agent="agent-id" `
  --config="D:\path\embedding-config.json" `
  --ledger="D:\path\usage-events.jsonl"
```

`--dry-run` 只报告计划，不调用 API。`--memory-id=<id>` 可重复传入，用于小范围验证；`--rebuild` 强制重新生成所选节点。
