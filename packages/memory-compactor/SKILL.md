---
name: memory-compact
description: 通过 Suzu Lives 对当前 Agent 的 Claude 会话执行既有的定向压缩。
---

# Memory Compact

这是软件拥有的稳定入口。它只对当前 Claude 会话执行上下文压缩：保留会话 JSONL 中的摘要检查点、原始对话和压缩备份；不读取、写入或召回长期记忆数据库，也不调用 Embedding。

先检查本次计划：

`suzu-lives memory-compact --dry-run`

由 Suzu 的计划任务从当前 Agent 项目根目录触发时，可调用：

`suzu-lives memory-compact --project-root '<当前 Agent 项目目录>'`

可在软件已选会话之外显式指定 Claude JSONL：

`suzu-lives memory-compact --transcript '<会话.jsonl>' --dry-run`

只有满足既有压缩阈值时才会启动一次性 Claude 摘要；未满足时返回 `status: "skipped"`。不要把 compactor 绑定到会话事件，也不要修改压缩规则或长期记忆服务。
