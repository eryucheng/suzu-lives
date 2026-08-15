# Suzu Memory

面向持续陪伴型 Agent 的本地优先长期记忆引擎。

Suzu Memory 将对话和活动作为可追溯事件写入本地 SQLite，在后台逐步形成带有主体、时间、证据与关系的长期记忆网络。Agent 在回复前只取回眼前问题真正需要的少量上下文，而不是把整段聊天记录或一份会不断膨胀的摘要重新塞回提示词。

Apache-2.0 · Node.js >= 22.5.0 · SQLite · 可配置 OpenAI-compatible / DashScope Provider

## 为什么是陪伴型记忆

长期相处的记忆不是文档分块检索。

- “某次连续加班”是具体经历，不等于“喜欢加班”或稳定习惯；
- “暂时不想社交”后来变成“愿意恢复联系”需要保留新旧状态与变化过程；
- “我”“Agent”“第三方”和“双方关系”不能混成同一个主体；
- 记忆被想起后可以更容易被再次联想，但原始事实、原话和历史证据不能被重新改写；
- 用户说起很久以前的一件具体事时，系统应能回到相应证据，而不是只猜测一个笼统主题。

Suzu Memory 因此把原始证据、经历事件、稳定状态、关系结构与检索轨迹分开管理，并允许它们在同一张记忆图中关联。

## 它认识人的 12 个维度

事件层记录“发生过什么”；持续认识层记录“一个主体在一段时间内是怎样的、相信什么、在意什么、与谁处于怎样的关系”。当前代码将后者分为十二个维度：

| 身份与生平 | 观念 | 偏好 | 习惯 |
| --- | --- | --- | --- |
| 气质与应对倾向 | 价值与优先级 | 目标与未完事项 | 能力与熟练度 |
| 关系认识 | 情绪联结 | 自我认识 | 现实条件 |

它们不是十二个会被随意贴上的标签：一次经历会先作为事件保存；只有具备相应证据、主体、适用范围和时间信息时，才会成为持续认识。每条持续认识都可保留当前与历史状态、来源证据和变化链。

## 核心能力

| 能力 | 作用 |
| --- | --- |
| 证据优先写入 | 对话以追加式事件归档；每条长期记忆可追溯到原始消息、分片和来源。 |
| 多重时间 | 区分事件发生、Agent 获知、系统记录、状态生效和失效时间。 |
| 主体与世界边界 | 区分用户、Agent、第三方、共同关系与不同现实/角色扮演世界，避免记忆串位。 |
| 状态演化 | 偏好、观念、习惯、目标、能力、关系和条件等状态可被补充、纠正或取代，同时保留历史链。 |
| 图式长期记忆 | 主题、事件簇、人物和关系可重叠关联；一条具体经历可以支持多个上层记忆。 |
| 混合召回 | 结合语义向量、BM25、实体、时间、状态、证据展开与图传播，再经过主体/世界/时间门禁。 |
| 有界可塑性 | 自然衰退只影响被联想到的概率；原始证据与最低可达性保留。外部反馈学习默认处于影子或审核模式。 |
| 可审计维护 | 提取、Embedding、结构化、失败重试、人工审核、备份与恢复都有持久化记录。 |

## 工作方式

```text
对话 / 活动事件
       │
       ▼
本地校验、幂等写入、分片与原始证据归档
       │
       ├── 零模型即时整理
       └── 异步语义维护与 Embedding
                     │
                     ▼
        事件 · 状态 · 人物 · 关系 · 主题图
                     │
用户新消息 ──► 混合检索、门禁与证据展开 ──► 少量可注入上下文
```

聊天宿主在回复前调用检索，在最终回复确定后归档本轮双方消息，并在空闲或会话结束时运行维护。完整的宿主接入时序见 [通用聊天宿主接入](examples/chat-host/README.md)。

## 快速开始

先准备 Node.js `>=22.5.0`，然后在仓库根目录执行：

```powershell
npm install
Copy-Item .\suzu-memory.example.json .\suzu-memory.local.json
```

编辑 `suzu-memory.local.json` 中的 Provider 地址、模型名和 `agentId`，再按配置中的 `apiKeyEnv` 设置密钥环境变量：

```powershell
$env:SUZU_MEMORY_GENERATION_API_KEY = "..."
$env:SUZU_MEMORY_EMBEDDING_API_KEY = "..."
```

运行带有虚构对话的最小完整示例：

```powershell
node .\examples\basic-host\basic-host.mjs --config .\suzu-memory.local.json
```

它会依次导入事件、完成维护、建立向量索引，并输出可注入的长期记忆上下文和检索轨迹。详细说明见 [最小宿主示例](examples/basic-host/README.md)。

## 接入已有 Agent

将现有模型调用包在下面四个生命周期入口外即可：

| 宿主时机 | 调用 |
| --- | --- |
| 用户消息已确定、模型尚未生成 | `beforeReply`：取回长期记忆上下文 |
| 最终可见回复已确定 | `afterReply`：归档完整双方回合 |
| 生成失败或被取消 | `abortReply`：清理本轮检索头 |
| 空闲或会话结束 | `onIdle` / `onSessionEnd`：处理积压事件与维护队列 |

最小调用形态如下：

```js
const result = await executeChatTurn({
  adapter,
  sessionId: host.sessionId,
  turnId: host.turnId,
  userMessage: host.userMessage,
  recall: { mode: "auto" },
  generateReply: async ({ userMessage, memoryContext }) => host.generate({
    userMessage,
    longTermMemory: memoryContext.content,
  }),
});
```

Codex、Claude Code、OpenClaw 和自定义 Runtime 的具体 Hook 名称不同，但映射关系相同。可直接参考 [chat-host 示例](examples/chat-host/README.md)。

## CLI、维护与审核

初始化一个本地 Agent 作用域：

```powershell
npm exec -- suzu-memory init --config .\suzu-memory.local.json
npm exec -- suzu-memory status --config .\suzu-memory.local.json
```

导入事件、处理输入队列、运行维护并检索：

```powershell
npm exec -- suzu-memory ingest .\events.jsonl --config .\suzu-memory.local.json
npm exec -- suzu-memory process-events --config .\suzu-memory.local.json
npm exec -- suzu-memory maintenance --lane all --config .\suzu-memory.local.json
npm exec -- suzu-memory search "上次提到的旅行计划原定在什么时候？" --config .\suzu-memory.local.json
```

`worker` 可由系统计划任务显式调用一次“输入处理 + 维护”；只有加上 `--continuous` 才会以前台循环方式常驻。若处理过程被中断，`recover-events` 可以回收过期租约或恢复已确认停止的旧 Worker 批次。

启动本地 HTTP API 与审核台：

```powershell
npm exec -- suzu-memory-server --config .\suzu-memory.local.json
```

默认访问地址为 `http://127.0.0.1:37779/console/`。审核台可查看候选、证据、输入批次、维护异常和备份健康，并接受、驳回或撤销可疑的状态/关系提案。

## 评测

ZH-4O：**86.52%**（924 / 1,068）

- 作答模型：DeepSeek V4 Flash
- Embedding：DashScope `text-embedding-v4`

运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-zh4o.ps1
```

见 [评测说明](docs/benchmark-status.md)。

## 文档

- [架构](docs/architecture.md)：数据模型、写入、维护、召回和关系图；
- [当前实现状态](docs/current-status.md)：默认策略与明确边界；
- [陪伴事件协议](docs/companion-event-protocol.md)：事件信封、身份/世界边界、分片与修订语义；
- [评测说明](docs/benchmark-status.md)：ZH-4O 结果与运行方式；
- [评测包说明](packages/evaluation/README.md)：开发与回归入口；
- [最小宿主示例](examples/basic-host/README.md) 与 [通用聊天宿主接入](examples/chat-host/README.md)。

## 数据、Provider 与隐私

- 长期记忆库、原始证据、审计轨迹和备份默认保存在本地 SQLite / 数据目录；
- 生成模型和 Embedding Provider 由本地配置决定，启用对应维护功能时才会向该 Provider 发送所需文本；
- `*.local.json`、API Key、真实聊天、数据库、缓存、备份和运行产物均已被 `.gitignore` 排除；
- 不要将真实聊天记录或本地配置提交到仓库。

## 开发

```powershell
npm run check:syntax
npm test
```

CI 使用 Node.js 22 运行同一组语法检查与工作区测试。

## 许可证

[Apache License 2.0](LICENSE) · 作者：儿玉诚也
