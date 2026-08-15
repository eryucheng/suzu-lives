# 陪伴事件协议（预览）

宿主通过追加式事件把对话、共同活动、真实动作和反馈交给 Suzu Memory。原事件不可覆盖；后续编辑或删除以独立修订记录表达。接收事件只执行本地校验和幂等追加，不调用 LLM；长期记忆分析在显式批处理中完成。

## 首版身份边界

- 一个 `spaceId` 固定一名主要用户和一名 Companion；
- 默认情况下 `spaceId` 等于配置的 `agentId`；
- `actor.role` 只能是 `user` 或 `companion`；
- 其他人物使用 `participants[].role = "other"`；
- 事件参与者不自动等于记忆主体，长期候选仍须通过证据和主体门禁。

## 事件信封

```json
{
  "protocolVersion": 1,
  "eventId": "host-stable-id",
  "spaceId": "companion-demo",
  "eventType": "conversation.turn",
  "occurredAt": "2026-08-04T12:00:00+08:00",
  "knownAt": "2026-08-04T12:00:00+08:00",
  "recordedAt": "2026-08-04T12:00:01+08:00",
  "actor": { "id": "user", "role": "user", "name": "User" },
  "participants": [
    { "id": "user", "role": "user", "name": "User" },
    { "id": "companion-demo", "role": "companion", "name": "Companion" }
  ],
  "world": { "id": "relationship", "frame": "relational" },
  "content": { "text": "我们今天一起完成了事件协议。" },
  "source": { "kind": "conversation", "locator": "host://conversation/42" },
  "metadata": {}
}
```

`knownAt` 省略时等于 `occurredAt`，`recordedAt` 省略时使用接收时间。`participants` 省略核心双方时，系统按配置补齐；不能用它引入第二名主要用户或 Companion。

## 事件类型

- `conversation.turn`
- `activity.observation`
- `agent.action`
- `tool.observation`
- `user.feedback`
- `relationship.milestone`

偏好、观念、计划、关系判断等不是宿主可直接指定的事实类型。它们继续由受约束分析链从证据中提出。

## 世界框架

- `physical`：物理世界事实；
- `relational`：这段持续关系中确实发生的共同经历；
- `fictional`：明确的虚构世界；
- `dream`：梦境；
- `hypothetical`：假设；
- `unknown`：证据不足。

`reality` 与 `world.frame` 表达不同维度。关系世界里的共同经历可以是 `reality=real`，但不能因此冒充物理世界事实。

## 幂等与批次

相同 Agent 下，同一个 `eventId` 重放相同语义内容只返回复用结果。相同 ID 携带不同内容会返回 `INPUT_EVENT_CONFLICT`。`recordedAt` 不参与语义冲突判断，因此传输重试可以有不同的记录时间。

默认情况下，单个事件正文超过 12,000 字符时会在接收阶段按段落、句末或空白边界拆分。第一片保留原 `eventId`，后续片使用保留后缀；每片的 `metadata.suzuMemoryFragment` 保存父事件 ID、片号、总片数和原文字符区间。所有片段按序拼接与接收时的规范化正文一致。批次默认只领取总计不超过 48,000 个正文字符的最早连续逻辑事件，并在 `memory_input_batches.input_character_count` 中审计实际值。同一父事件的完整片组不会被批次边界拆开；领取后会先还原成一条完整消息再送入长期提取模型。片组本身超过批次预算、片数超过事件上限、缺片或字符区间不连续时，系统不会把残缺正文送入模型：原始输入会保留并标记为 `quarantined`，同时创建 `maintenance-failure` 审核项，后续正常事件仍可继续处理。这是字符预算，不伪装成厂商 Tokenizer 的精确 Token 数；两项阈值都可以通过 `defaults.ingestion` 配置。

事件处理失败时，批次被审计为 `failed`，事件回到 `pending`，可再次处理；已完成批次不会重复领取。领取成功的批次记录 Worker 所有者与租约到期时间：进程被关闭、系统休眠或 Provider 调用中断后，下一次领取会先回收已经过期的批次。旧 Worker 不能完成已经被回收的批次。确认旧 Worker 已终止但租约尚未到期时，管理员可使用 `suzu-memory recover-events --force` 立即恢复；不要在仍有处理进程运行时强制恢复。对于直接通过 HTTP/SDK 写入事件的部署，可由系统计划任务运行 `suzu-memory worker`；它默认只执行一次，避免 HTTP Server 在未声明的情况下自行常驻调度。

## 修订、取代与撤回

- `amend`：作者修订原事件，必须提供一个使用新 `eventId` 的完整替代事件；
- `supersede`：由后续正式记录取代原事件，也必须提供替代事件；
- `retract`：撤回原事件，不允许附带替代内容。

修订本身幂等并保留目标、替代事件、原因、时间和影响范围。待处理旧事件立即退出领取；已归档来源标记为失活。若派生记忆没有其他有效来源，系统软删除该记忆并记录 mutation 与 revision effect；若仍有其他有效来源，记忆保留。仍处于待审状态的因果、人物归属或报告状态提案在接受时会重新验证来源生命周期，失活证据不能继续落地为正式结构。正在处理的事件返回 `INPUT_EVENT_REVISION_RACE`，该校验与修订写入位于同一个写事务中；需先等租约过期自动回收，或在确认旧 Worker 已终止后显式恢复，再提交修订。

## HTTP 入口

- `POST /v1/events`
- `GET /v1/events`
- `POST /v1/events/:eventId/revision`
- `GET /v1/input-batches`
- `POST /v1/input-batches/process`
- `POST /v1/input-batches/recover`
- `GET /v1/maintenance`
- `POST /v1/maintenance/run`

HTTP、SDK、CLI 和嵌入式 Service 都调用同一 Ingestion 与 Service 实现。

## 通用聊天宿主适配

`@suzu-memory/host-adapter` 为不希望直接构造事件信封的聊天宿主提供稳定生命周期：

```text
用户消息确定
→ beforeReply（可召回，也可由宿主显式跳过）
→ 宿主生成回复
→ afterReply（归档双方原始消息并绑定检索轨迹）
```

适配层生成的 `conversation.turn` 仍完整遵循本协议，事件 ID 根据宿主、会话、轮次、角色和宿主消息 ID 确定性生成。它不推测某个 Codex、Claude Code、OpenClaw 或其他运行时的具体 Hook 名称；宿主只需要把自己真实拥有的“回复前、回复后、失败、空闲”时机映射到对应入口。

`beforeReply` 的长期检索、检索轨迹和反馈绑定属于增强能力：临时失败时会返回空的 `degraded` 记忆上下文，宿主仍应继续生成回复。回复已经生成后，如果归档暂时失败，适配层会返回归档诊断而不会撤回该回复。每次 `onIdle` / `onSessionEnd` 会先回收已过期的输入租约，再从持久化事件中发现该宿主仍有待处理的会话；因此重启后不依赖旧进程的内存集合。
