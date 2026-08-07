# memory-structurer

将已经通过准入策略的本批长期记忆，整理成两类彼此隔离的待审核候选：

- `episode` / `topic` 结构候选；
- 有原始来源支持的 `causes` 因果关系候选。

它不读取原始会话，不把 `utterance`、来源路径或节点元数据发给生成器，也不会自动接受候选。生成器只能提出：

- `create`：用至少两条本批记忆建立新的 episode/topic。
- `attach`：把至少一条本批记忆挂接到快照中已有的 episode/topic。

所有候选都写入 `memory_structure_proposals`，保持 `pending`，之后必须显式接受或驳回。

旧导入事件的主体归属使用独立入口 `proposeSubjectAttributionForMemory`。它一次只处理一条主体为 `unknown` 的具体记忆，只读取该记忆已经链接的来源和调用方固定的候选人物；模型可以 `abstain`，不能创造人物或来源。成功结果只进入 `memory_subject_attribution_proposals` 的 `pending` 队列，不会直接修改事件。人工接受由 `memory-core` 完成，并在应用前重验原始证据快照。

显式组批使用 `proposeSubjectAttributionsBatch`，必须提供 `memoryIds` 和 `maximumMemories`。批处理不会发现或扫描其他旧事件；单条失败与弃权分别记录，已经产生的待审提案不会因后续失败被回滚。

代码层还会执行保守门槛：成员只能来自本批 `currentMemories`，挂接目标只能来自有界快照里的 `candidateContainers`；新 episode 默认至少需要两条带发生时间的成员，新 topic 默认至少需要两个不同日期的证据。episode 的边界由成员时间计算，不采用模型虚构的时间范围。

调用方注入自己的 `generator`，接口与压缩器一致：接收 `{ input, systemPrompt, schema, schemaName }`，返回 `{ output, model, usage, requestId, durationMs, metadata }`。包内不绑定模型厂商，也不保存 API Key。

因果候选由 `proposeRelationsForBatch` 单独生成。它只读取调用方明确给出的本批节点及这些节点已经绑定的有界原始来源，不读取文件路径和来源元数据。代码要求原因和结果均来自本次快照，证据 ID 也必须来自快照并合计覆盖两个端点。时间相邻、主题相似、同次出现不会由代码转成因果。

关系生成器仍然只能写 `memory_relation_proposals` 的 `pending` 候选，不能写 `memory_edges`。当前只开放方向固定的 `causes`；`supported_by`、状态换代、时间和普通联想边继续由确定性代码维护。显式接受后才创建边，驳回只保留审计；误接受的边在没有被后续修改时可以显式撤销。召回器只在明确询问原因时读取已接受的 `causes`，普通查询不会静默带出因果链。

## 回顾性巩固

`planMemoryConsolidation` 用本批新写入的直接记忆作为触发点，只沿已有的 `associated_with`、`shares_entity`、`same_thread`、`timeline_next`、`part_of_episode` 和 `supports_topic` 关系选择有限数量的旧直接记忆。计划会记录触发节点、候选旧节点、选择理由、所用边和输入哈希；相同输入只得到同一个计划，不会反复堆积。

`runMemoryConsolidation` 认领一条计划后，分别调用可选的结构生成器和因果生成器。传给模型的快照明确标记 `triggerMemoryIds` 与 `historicalMemoryIds`，代码会再次拒绝：

- 只重组旧记忆、没有包含新记忆的候选；
- 新建结构没有同时包含新旧记忆的候选；
- 没有连接新旧两侧的因果候选；
- 越界端点、越界来源或不能覆盖两端的证据。

运行结果只引用 `pending` 提案，不会接受提案或直接改变图。空候选计划不调用模型；已完成计划再次执行时直接返回原结果；后一个生成器失败时，前一个生成器已经落下的待审提案仍会保留并记录在失败运行里。自动调度、自动批准和真实模型默认配置尚未开放。

正式压缩链路会在长期记忆落库、确定性关联图更新完成后建立计划；这个步骤不调用模型。计划的模型处理必须由调用方显式执行：

```text
suzu-lives memory-consolidate --max-runs 3
```

`--max-runs` 必填，因为每条非空计划最多会产生一次结构调用和一次因果调用。命令按最早计划开始，单条失败不会阻断本批其他计划；只输出运行 ID、状态和提案数量，不输出记忆正文。结构与因果阶段都复用当前 Agent 的一次性 Claude CLI 会话，只是使用不同专职提示词。命令不会启动后台任务，也不会自动接受任何提案。
