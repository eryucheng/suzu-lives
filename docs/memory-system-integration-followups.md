# 新记忆系统接入问题追踪

更新：2026-08-12

这份清单记录本次从真实调用链、`suzu-memory` 源码和现有会话数据库中确认的问题。它区分宿主接入、`suzu-memory` 上游实现和既有数据状态，避免把数据现象误判为页面或接口问题。

## 状态说明

- `处理中`：已定位根因，正在修改。
- `已修复`：代码已修改，并有对应的针对性验证。
- `需人工处理`：代码无法安全替代对原始数据/业务意图的判断。

## 问题清单

| 编号 | 归属 | 状态 | 已确认的问题 | 处理与验收条件 |
| --- | --- | --- | --- | --- |
| M-01 | Suzu Lives 接入 | 已修复 | 每轮对话后只调用一次 `adapter.onIdle()`；而 `suzu-memory` 单次维护有批量上限。队列超过上限时，即使没有崩溃也会残留。 | 宿主现在按联系人固定会话串行续跑，直到没有可运行任务或明确没有进展；不再有隐藏的总轮次上限。维护状态另有完整的 `runnableTaskCount`，不会被最多 500 条的可见任务列表截断。已用 11 个向量任务跨两轮验证。 |
| M-02 | Suzu Lives 接入 | 已修复 | 软件启动后没有恢复已有会话的维护队列；也没有真正的“会话结束”生命周期可调用。 | 会话读取器就绪后只扫描已有会话库；每个联系人的固定会话会恢复维护。持久会话不伪造结束事件，改为“每轮完成 + 启动恢复”。启动时队列已空也会重建一次关联图。 |
| M-03 | `suzu-memory` 上游 | 已修复 | 归档窗口把已归档事件和待处理事件一起交给只允许 claim `pending` 的处理器，处理器校验失败后会阻断后续新消息归档。 | 保留旧事件作为规划上下文，但交给处理器的核心事件只含本次待处理事件；“先归档一轮、再追加一轮”的回归验证通过。 |
| M-04 | `suzu-memory` 图谱映射 | 已修复 | 图谱只按单一 `subject_role` 连接根节点，漏掉新版 `memory_actor_roles` 中的说话者、参与者、经历者等；因此“我 / Agent / 关系”没有真正像主题一样承接小神经元。 | 图谱现在把完整角色集映射到“我 / Agent”根节点：共同经历可同时连接双方，`shared` 与双方共同参与的记忆都连接到“关系”根节点。旧主题、原有边和实体关联保持不变。 |
| M-05 | Suzu Lives 接入 + `suzu-memory` 上游 API | 已修复 | 历史导入/中断恢复完成后没有正式的“维护队列清空并重建关联图”路径。旧库有图结构，新库即使已有结构化记忆也可能长期没有边。 | `suzu-memory` 已公开全量关联图重建 API；宿主在维护真正收敛后或启动恢复的已有库上调用它，不在浏览页面时临时拼图。 |
| M-06 | Suzu Lives 接入 | 已修复 | `suzu-memory` 已有数据库备份检查与恢复能力，但宿主仅接了创建备份，未接检查/恢复。 | 审核中心已接入选择备份、检查元数据、二次确认和恢复；恢复前会自动创建安全备份，恢复后继续该联系人的维护。 |
| M-07 | 既有历史数据 | 需人工处理 | 当前工作会话保留少量失败输入批次，错误内容为历史结构化输出的 JSON 截断。它们不是当前页面或召回链造成的，不能在不知道原始意图的情况下静默重试/删除。 | 保留在审核入口可见；待以上归档修复后，再由人决定重试、忽略或删除对应历史批次。 |
| M-08 | 已核对 | 已接好 | 召回在回复前写入 trace，回复后绑定使用结果，下一条用户消息写入反馈；审核读取、决议、撤销、输入批次恢复和创建备份已有宿主 IPC 路径。 | 本次不重复造接口；后续只验证回归。 |
| M-09 | Suzu Lives 接入 | 已修复 | 工作会话的原文导入后，DeepSeek Anthropic 端点在记忆提炼的强制结构化调用上以 `Thinking mode does not support this tool_choice` 拒绝，形成一条 `long-term-extraction` 失败审核项。 | 宿主仅在记忆提炼使用 DeepSeek 官方 Anthropic 端点且未显式配置时注入 `thinking: { type: "disabled" }`；不影响普通对话模型请求。历史失败不会静默重跑，审核区会提供“重新提炼”入口，并从保留的原文重新入队。 |
| M-10 | `suzu-memory` 上游语义 + Suzu Lives 接入 | 已修复 | 结构提案原先只进入审核队列，只有“接受”后才真正创建 topic / episode；因此未审核但应可使用的主题与事件簇不会出现在记忆大脑，审核也无法对已可见结构执行真正的回退。 | topic / episode 现在先以 active 节点写入，节点和成员边均带 `structureReviewState: pending`；同一提案继续在审核区等待确认。接受会确认该标签，驳回会仅删除该提案建立的结构边，并对新建结构软删除节点，不会影响原始记忆或其他结构。 |
| M-11 | `suzu-memory` 维护链 | 已修复 | 即使未审核结构已落库，原先也要等审核通过后才排入向量与召回上下文维护，导致它只能在图中可见、不能完整参与正常使用。 | 新建的 pending topic / episode 会立即排入向量和召回上下文队列；审核通过只确认结构，审核驳回后底层 active 查询会自然排除已软删除的新建节点。 |
| M-12 | 既有工作会话数据 | 已处理 | 旧语义下“工作”会话已有 3 个 episode 和 1 个 topic 待审核提案，均没有 `result_memory_id`，导致图谱读取为 0 个 topic / episode。 | 已按 M-10 的兼容落地路径写入同一个工作会话库：4 个节点保持未审核，建立 14 条结构边；对应审核项仍为 pending，可在审核中心确认或回退。4 个节点已排入同一会话的向量和召回上下文维护队列，未执行外部模型调用。 |

## 本次处理边界

- 不自动调用外部模型重跑历史失败项；必须由审核区的“重新提炼”明确触发，原文和原失败审核记录都会保留。
- 已对工作会话的既有结构提案进行一次兼容落地，使页面能够按新语义展示并审核它们。
- 只修复调用链、数据模型映射和已有服务能力的接入。
- 历史数据的失败批次不自动删改；代码修复后由审核流程处理。

## 模型边界说明

- `memory_actor_roles` 表示“这条记忆涉及谁”，适合把小神经元接到“我 / Agent / 关系”三个大神经元。
- `memory_entities` 表示可判定为同一具体实体的跨记忆事实，仍只用于 `shares_entity`。不能把所有“用户”或所有“Agent”角色替换成实体边，否则会制造整图两两相连的假关联。
- 因此本次没有为了填充 `shares_entity` 伪造实体数据；修的是根节点连接、维护收尾和真正的关联图重建。

## 验收记录

| 验证 | 结果 |
| --- | --- |
| `apps/control-center`: `node --test test/long-term-memory-service.test.mjs test/memory-ipc.test.mjs test/preload-syntax.test.mjs test/memory-brain-view.test.mjs` | 8/8 通过。覆盖固定会话隔离、跨单批队列恢复、备份检查/恢复、IPC/预加载桥接与结构边可见性。 |
| `external/suzu-memory`: `node --test packages/maintenance/test/maintenance.test.mjs packages/host-adapter/test/host-adapter.test.mjs packages/service/test/memory-service.test.mjs packages/visualization/test/memory-visualization.test.mjs` | 53/53 通过。覆盖归档窗口续写、完整可运行队列计数、关联图重建、完整角色根节点映射。 |
| `external/suzu-memory`: `node --test packages/core/test/memory-core.test.mjs packages/service/test/memory-service.test.mjs` | 71/71 通过。覆盖未审核 topic / episode 的立即落库、审核确认/回退，以及从归档原文重新提炼长期记忆。 |
| `external/suzu-memory`: `node --test packages/core/test/memory-core.test.mjs packages/maintenance/test/maintenance.test.mjs packages/service/test/memory-service.test.mjs packages/structurer/test/memory-structurer.test.mjs` | 99/99 通过。覆盖 pending topic / episode 的立即落库、提案粒度回退、正常维护入队和从归档原文重新提炼。 |
| `apps/control-center`: `node --test test/memory-ipc.test.mjs test/memory-react.test.mjs test/memory-brain-view.test.mjs test/long-term-memory-service.test.mjs test/preload-syntax.test.mjs` | 10/10 通过。覆盖 DeepSeek 记忆提炼配置、联系人作用域、审核 IPC、预加载桥接和 React 页面接入。 |

相关改动集中在：

- `apps/control-center/electron/services/long-term-memory-service.mjs`
- `apps/control-center/electron/ipc/memory-ipc.mjs`
- `external/suzu-memory/packages/host-adapter/src/index.mjs`
- `external/suzu-memory/packages/maintenance/src/index.mjs`
- `external/suzu-memory/packages/service/src/index.mjs`
- `external/suzu-memory/packages/visualization/src/brain-layout.mjs`
