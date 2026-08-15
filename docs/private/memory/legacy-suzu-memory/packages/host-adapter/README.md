# @suzu-memory/host-adapter

面向 Codex、Claude Code、OpenClaw 和其他聊天运行时的通用记忆生命周期适配层。它不依赖任何具体聊天平台、Hook 名称或模型 SDK；宿主只需把自己的消息与最终回复映射到统一入口。

## 生命周期

```text
收到用户消息
→ beforeReply：记录上一轮反馈线索、按宿主决定召回、返回原始记忆上下文
→ 宿主把 memoryContext.content 放入本轮模型上下文
→ 模型产生最终回复
→ afterReply：幂等归档用户与 Agent 两条原始事件、绑定召回轨迹与最终回复
→ onIdle / onSessionEnd：按同一会话重建正式窗口、处理待归档事件，再运行维护
```

适配层不判断“一句话是否需要长期记忆”。宿主可传入 `recall.enabled = false`，例如当前对话上下文已经足够理解“吃了”时跳过召回。跳过时会清除该会话旧的召回头，避免把当前回复错误绑定到上一轮记忆。

如果宿主不想自己编写判断逻辑，可以显式启用可选的记忆介入策略。策略先处理明确的历史问句和当前上下文短回答，只有模糊输入才调用结构化 LLM；模型失败时保守执行普通召回，不中断聊天。该策略仍属于宿主层，不会改变长期记忆内核。

## 创建适配器

`memory` 可以是 `MemoryService`，也可以是 `createHttpMemoryClient()` 返回的 HTTP 客户端。

```js
import { createChatHostMemoryAdapter } from "@suzu-memory/host-adapter";

const adapter = createChatHostMemoryAdapter({
  memory,
  // 稳定标识一个接入实例，不要只填会与其他设备重复的产品名。
  hostId: "claude-code:desktop-a",
  identity: {
    spaceId: "companion-demo",
    primaryUserId: "user",
    primaryUserName: "User",
    companionId: "companion-demo",
    companionName: "Companion",
  },
});
```

## 可选的自动介入策略

```js
import {
  createChatHostMemoryAdapter,
  createMemoryInterventionPolicy,
} from "@suzu-memory/host-adapter";
import {
  createProvidersFromMemoryConfig,
  loadMemoryConfig,
} from "@suzu-memory/config";

const config = loadMemoryConfig("./suzu-memory.json");
const providers = createProvidersFromMemoryConfig(config);
const interventionPolicy = createMemoryInterventionPolicy({
  generator: providers.interventionGenerator,
});

const adapter = createChatHostMemoryAdapter({
  memory,
  hostId: "claude-code:desktop-a",
  identity,
  interventionPolicy,
});

const prepared = await adapter.beforeReply({
  sessionId: hostSessionId,
  turnId: hostTurnId,
  userText: userMessage.text,
  recentMessages: recentLiveContext,
  recall: { mode: "auto" },
});
```

`providers.intervention` 可以单独配置便宜的小模型；省略时复用 `providers.generation`。两者都使用同一个 OpenAI-compatible / DashScope 结构化生成契约，因此可以接远程 LLM，也可以接提供兼容接口的本地运行时。

策略结果为 `skip` 或 `recall`，并返回原因、独立检索 Query、置信度、模型、请求 ID 和用量信封。宿主显式传入 `recall.enabled = true/false` 时优先级最高，不会调用自动策略。当前 `reflect` 深入回想仍是独立的后续能力，不能把一次普通召回冒充成多步反思。

## 回复前召回

```js
const prepared = await adapter.beforeReply({
  sessionId: hostSessionId,
  turnId: hostTurnId,
  userText: userMessage.text,
  userOccurredAt: userMessage.createdAt,
  recall: {
    enabled: shouldRecall,
    reason: shouldRecall ? "" : "current-context-is-sufficient",
  },
});

// 宿主自行决定放进 system、developer、context block 或其他位置。
const memoryContext = prepared.memoryContext.content;
```

返回值同时包含稳定 `traceId`、结构化片段和完整检索结果。适配层不添加“你想起了……”等宿主文案，避免替不同模型猜测提示词格式。

返回值中的 `sessionId` 保留宿主原值；`runtimeSessionId` 是由 `hostId + sessionId` 确定性生成的内部作用域。召回头、回复使用和下一轮反馈只使用后者，因此两个宿主都叫 `session-1` 时不会互相覆盖。

## 回复后归档

```js
await adapter.afterReply({
  sessionId: hostSessionId,
  turnId: hostTurnId,
  retrievalTraceId: prepared.memoryContext.traceId,
  userMessage: {
    id: userMessage.id,
    text: userMessage.text,
    occurredAt: userMessage.createdAt,
  },
  assistantMessage: {
    id: finalResponse.id,
    text: finalResponse.text,
    occurredAt: finalResponse.createdAt,
  },
});
```

事件 ID 根据宿主、会话、轮次、角色和消息 ID 确定性生成。同一轮重试会复用事件；同一个 ID 携带不同正文时由事件协议拒绝，不会静默覆盖历史。

如果模型轮次失败且不会产生最终回复，调用：

```js
await adapter.abortReply({ sessionId: hostSessionId });
```

## 用户反馈

下一条真实用户消息会在 `beforeReply` 中作为上一轮回复的原始反馈证据进入待分析区，但不会自动改变事实、记忆权重或关系边。

宿主拥有明确的人工反馈按钮或命令时，也可以直接记录已有反馈类型：

```js
await adapter.recordFeedback({
  traceId,
  signal: "corrected", // used | helpful | irrelevant | incorrect | missed | corrected
  targetMemoryIds: [memoryId],
  note: "用户明确纠正了这条记忆。",
});
```

## 空闲维护

```js
await adapter.onIdle({
  sessionId: hostSessionId,
  lane: "all",
});
```

适配层会读取该宿主和该会话的 `pending` / `archived` 原始事件，以统一的窗口规划器生成不重叠核心窗口：前文最多 10 条、后文最多 20 条只用于代词和未完成事项的理解，不能作为新候选或来源证据。

在同一进程中，`afterReply()` 已见过的会话可以省略 `sessionId`；为保证重启后的行为也一致，后台 Hook、Cron 或会话结束回调应显式传入它。适配层不会自行创建定时器、后台进程或 Cron。由 Codex、Claude Code 或其他宿主在自己的空闲、会话结束或显式维护时机调用。

一次空闲维护中，单个会话的可恢复归档故障不会阻断其他会话或后续维护；结果会保留该会话的诊断，并以 `completed-with-failures` 如实上报。下次空闲维护会继续领取仍为 `pending` 的原始事件。

## 并发边界

不同宿主和不同会话可以并行。同一宿主的同一 `sessionId` 按普通聊天轮次串行：一次 `beforeReply` 对应一次最终 `afterReply` 或 `abortReply`。如果宿主允许同一会话并发生成，应为各分支使用不同的宿主会话 ID。

## 单轮包装器

宿主也可以使用 `executeChatTurn` 自动保证成功后归档、失败后清除召回头。它只调用宿主传入的 `generateReply`，不依赖或代理任何模型 SDK：

```js
const result = await executeChatTurn({
  adapter,
  sessionId,
  turnId,
  userMessage,
  recall: { enabled: true },
  generateReply: ({ userMessage, memoryContext }) => host.generate({
    userMessage,
    longTermMemory: memoryContext.content,
  }),
});
```
