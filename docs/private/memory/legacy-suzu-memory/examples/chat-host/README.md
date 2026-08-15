# 通用聊天宿主接入

这个示例展示 Codex、Claude Code、OpenClaw 或自定义聊天程序如何把自己的模型调用包在 Suzu Memory 生命周期外面。它不导入任何厂商 SDK，也不假设某个平台一定有某个 Hook。

核心调用见 [`chat-turn.mjs`](chat-turn.mjs)：

```js
const result = await executeChatTurn({
  adapter,
  sessionId: host.sessionId,
  turnId: host.turnId,
  userMessage: host.userMessage,
  recall: {
    enabled: host.shouldRecall,
    reason: host.shouldRecall ? "" : "current-context-is-sufficient",
  },
  generateReply: async ({ userMessage, memoryContext }) => {
    return host.generate({
      userMessage,
      // 由宿主映射到自己的 system/developer/context 结构。
      longTermMemory: memoryContext.content,
    });
  },
});
```

推荐映射：

| 宿主阶段 | 适配器入口 |
| --- | --- |
| 用户消息已确定、模型尚未生成 | `beforeReply` |
| 最终可见回复已确定 | `afterReply` |
| 生成失败或取消 | `abortReply` |
| 空闲或会话结束 | `onIdle` / `onSessionEnd` |

对于 Claude Code 插件或 Hook，应在能够向当前轮次增加上下文的入口调用 `beforeReply`，在能够取得最终回复的入口调用 `afterReply`。对于 Codex 或普通 Agent Runtime，则在自己的模型调用包装器前后调用同样的方法。具体 Hook 名称属于宿主版本，不写死在这个独立包里。

如果宿主已经有自己的召回门禁，继续传入 `recall.enabled` 即可。如果希望使用仓库提供的兼容策略，则在创建适配器时注入 `createMemoryInterventionPolicy(...)`，并把调用改为：

```js
const result = await executeChatTurn({
  adapter,
  sessionId: host.sessionId,
  turnId: host.turnId,
  userMessage: host.userMessage,
  recentMessages: host.recentMessages,
  recall: { mode: "auto" },
  generateReply: host.generateReply,
});
```

`recentMessages` 必须是当前用户消息之前、宿主已经放在 live context 中的最近消息。策略判断的是“是否还需要外部长期记忆”，不是“这句话是否值得保存”。省略 `providers.intervention` 时复用主 `generation` LLM；需要单独的小模型时再为它配置独立的 OpenAI-compatible / DashScope 连接。
