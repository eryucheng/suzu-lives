# Memory Core

`@suzu-memory/core` 是 Suzu Memory 的长期记忆数据核心。它只负责保存、迁移、查询和关联记忆，不绑定任何宿主 Hook，也不负责让模型决定应当记住什么。

## 数据边界

- `source_records`：不可随意改写的原始证据，例如历史消息；
- `memory_nodes`：可理解和检索的记忆节点，包括原话、具体事件、事件簇、主题、事实、偏好、关系、计划和反思；
- `memory_actor_roles`：一条记忆中的主体、经历者、说话者、观察者、参与者、观念持有者和偏好持有者；
- `actor_entity_bindings`：把 `user / agent / other + actor_key` 稳定绑定到人物实体，不再把人物只当成字段值；
- `relationships` / `relationship_members`：主用户与当前 Agent 之间持续的“关系”容器及其成员；
- `memory_relationship_memberships`：记忆与关系容器的重叠归属，区分共同经历、关系状态、情绪联结、承诺和里程碑；
- `memory_sources`：记忆与原始证据之间的关系，同时保存来源权威度、可信度和证据强度；
- `memory_ingestion_decisions`：与人格记忆隔离的输入审计，保存每个候选为何被存入、复核或拒绝；
- `memory_retrieval_traces`：与人格记忆隔离的召回轨迹，只保存查询、种子、路径、注入节点和运行元数据；
- `memory_retrieval_feedback`：对一次召回追加“采用、忽略、纠正”等反馈，不覆盖原轨迹；
- `memory_reward_session_heads` / `memory_reward_observations`：把同一会话中上一轮回复与紧随其后的真实用户输入有界绑定；反馈可以先于采用分析到达并排队，不属于人格记忆；
- `memory_reward_analysis_runs`：结果、指向和贡献三个专职分析器的独立调用审计；
- `memory_reward_credit_proposals`：按实际采用记忆生成的价值信用影子提案；只保存 `eligible/pending/blocked` 建议，不自动修改任何记忆状态；
- `memory_accessibility_state`：节点长期可访问性的独立状态；不承担真实性、重要性或当前激活职责；
- `memory_edge_relation_utility_state`：同一条关系边在不同查询意图下的独立使用价值；不覆盖基础边权；
- `memory_plasticity_shadow_runs` / `memory_plasticity_shadow_changes`：可塑性影子运行及候选变化审计；当前只记录建议，不应用状态；
- `memory_plasticity_applications` / `memory_plasticity_application_changes`：显式人工应用、逐项前值和回滚状态；不属于人格记忆；
- `memory_structure_proposals`：事件簇与主题的待审提议；原提议、成员、理由、处理结果和最终节点分别保留；
- `memory_relation_proposals` / `memory_relation_proposal_evidence`：因果关系的待审提议及其原始来源引用；模型不能直接写边；
- `memory_preference_state_proposals` / `memory_preference_proposal_evidence`：偏好状态升级、降级、范围收缩、补强和反证挑战的待审提议；提案固定表示层和范围身份，证据保存审核时指纹，与正式人格记忆分开；
- `memory_state_promotion_proposals`：`inferred → established` 的独立跨层晋升提案；保存源状态指纹、显式策略版本、目标层、人工决议与安全撤销审计，不复用同层偏好升级；
- `memory_subject_attribution_proposals` / `memory_subject_attribution_proposal_evidence`：旧导入具体记忆的主体归属待审提案与直接来源；说话者不会自动成为事件主人；
- `memory_reported_state_proposals` / `memory_reported_state_proposal_observations`：十二个状态家族的本人明确表达层待审提案及其不可变证据快照；统一决议按动作执行，并分别保存审查目标范围与结果范围；
- `memory_state_analysis_runs` 及其记忆/来源关联表：专职语义分析调用的独立审计，保存角色、模型、提示词与 Schema 版本、输入哈希、结构化输出、拒绝项、用量和费用；
- `memory_state_evidence_observations` 及其来源/调用关联表：偏好、习惯、观念等人物状态共用的证据账本；有效、排除、待定和重分析换代分别保存，不属于人格记忆；
- `memory_consolidation_runs`：新记忆触发的有界回顾计划、候选旧节点、所用既有边、运行状态和生成提案 ID；与人格记忆隔离；
- `memory_edges`：节点之间有方向、有类型、有权重的关系；
- `entities`：人物、地点、物品、项目等稳定对象；
- `memory_embeddings`：可删除并重建的向量索引；
- `import_runs`：每次迁移的来源、版本和结果。

SQLite 数据库位于软件自己的 Agent 数据目录，不写回 Agent 工作空间。旧 `history.jsonl` 和 `events.jsonl` 在迁移阶段只读，确认新链路稳定前仍是回退依据。

## 记忆理解层

记忆不再只是一段没有归属的文本。每个节点必须分别记录：

- `kind`：原话、具体事件、事件簇、主题、事实、观念状态、偏好、关系、计划、承诺、未完成事项、反思或推导假设；
- `subject_role` / `subject_key`：这是用户、Agent、双方、其他人还是外部世界的记忆；
- `memory_actor_roles`：同一事件中谁是经历者、说话者、观察者或参与者；`subject_role` / `subject_key` 暂时保留为主主体兼容字段；
- `reality`：现实、假设、虚构、角色扮演或仍不明确；
- `evidence_mode`：明确说过、实际观察、推断、人工写入或旧库导入；
- `representation_layer`：`reported` 表示主体明确表达的当前主张，`inferred` / `established` 表示证据聚合层，`unspecified` 只兼容尚未迁移的旧节点；
- `state_family`：身份、观念、偏好、习惯、行为倾向、价值、目标、能力、关系、情绪联结、自我认识或现实条件；它不再从宽泛的 `kind` 或正文反推。非状态节点固定为 `not_applicable`，旧状态节点在没有可靠依据时保持 `unspecified`；
- `state_phase`：领域状态自身的活跃、暂停、中断、完成、取消、结束或退役阶段；它与时间语义和数据库生命周期分开保存；
- `state_scope_key`：同一语义状态内的当前槽身份；宽泛状态固定为 `root`，局部例外使用代码从家族专用结构化范围生成的 `scope:<sha256>`，非状态节点为 `not_applicable`；
- `temporal_state`：当前、历史、计划中、进行中、已完成或已取消；
- `canonical_key`：同一项可变化事实的稳定键，用于更新而不是堆叠冲突文本。

时间被拆成三个互不替代的字段：

- `event_start` / `event_end`：事情实际发生的时间；
- `known_at`：Agent 得知这件事的时间；
- `recorded_at`：长期记忆节点写入数据库的时间。

可变化状态另外使用 `valid_from` / `valid_to` 表示有效期。记忆节点自己的 `confidence` 与证据链接上的 `source_trust`、`evidence_strength` 分开保存，避免把“来源可靠”误当成“结论一定正确”。

系统不会仅因为两段文字谈论同一主题，就把用户经历改写成 Agent 经历。主体不同的节点拥有不同更新链。

## 人物实体与关系层

`subject_role` 和 `memory_actor_roles` 仍然是记忆归属的事实来源，但人物不再只是字符串。`ensureActorEntity` 为稳定 Actor 键建立人物实体，`listMemoryActorEntities` 通过已存角色确定性返回记忆所属的人物，不另外复制一份人物真值。

关系容器是一级结构对象，不是 `memory_nodes` 中的一条摘要，也不是 `kind=relationship` 关系状态的替代品。当前自动维护的根容器只表示“主用户与当前 Agent 之间这段持续关系及其共同历史”；双方如何理解这段关系、如何称呼对方、信任、边界和共识，仍由带方向、时间和证据的关系状态记录。

`ensureCompanionRelationshipStructure` 幂等建立“主用户”“当前 Agent”以及两者唯一的主关系根。`syncMemoryRelationshipMemberships` 只向这个带有 `primary-user-agent` 作用域的双人根写入自动归属：明确同时包含双方的长期记忆，或默认关系世界中明确标记为 `shared` 的记忆，才会确定性进入。原话不会进入；只有用户经历而 Agent 是观察者的事件不会进入；其他人物或其他关系容器不会被这条自动链路吸收；人工归属也不会被覆盖。

因此底层层级是允许重叠的图：一条记忆可以同时属于用户、Agent、两者的关系、某个事件簇和多个主题，不使用单父节点树。

## 大神经元与多重归属

事件簇与主题使用同一张 `memory_nodes` 表，但语义不同：

- `episode` 是有现实时间边界的事件簇，至少需要 `event_date` 或 `event_start`；
- `topic` 是可跨越多个事件的长期语义主题，自身不填写事件发生时间；
- `part_of_episode` 把具体记忆连接到事件簇；
- `supports_topic` 把具体记忆或事件簇连接到主题；
- 同一条记忆可以同时属于多个事件簇并支持多个主题，不存在单父节点限制。

`upsertEpisode`、`upsertTopic`、`linkMemoryToEpisode`、`linkMemoryToTopic`、`listEpisodeMembers` 和 `listTopicMembers` 提供受控手工接口。`proposeMemoryStructure` 只把候选写入审计队列：`create` 表示建立新节点，`attach` 表示把新成员挂到已有节点。`resolveMemoryStructureProposal` 只有在明确接受时才会事务化创建或挂接；任意一步失败都会回滚。`attach` 不接受模型对目标正文的改写，事件簇扩展后的时间范围由成员时间确定。自动关联构建器不会为这些结构节点猜测普通语义边；压缩模型也不能直接生成它们。旧 `topic_or_episode` 只保留读取兼容，新数据必须明确选择 `episode` 或 `topic`。

对同一主体和同一 `canonical_key`：

- 内容相同会补强已有记忆；
- 明确 `update` / `correct` 会保留旧节点并建立更新边；
- 明确 `contradict` 会把两边标为待判定并保留冲突边；
- 没有明确变化动作但内容不同，会进入复核，不自动覆盖。

## 当前 Core 能力

- 自动执行带版本号的数据库迁移；
- 原始证据、记忆节点和关系的事务写入；
- 中文全文检索，优先使用 SQLite FTS5 `trigram`；
- 从一个或多个记忆节点按关系向外扩散；
- 幂等导入旧版 `history.jsonl` 与 `events.jsonl`；
- 事件节点保留到具体历史原文的证据链。
- 记忆候选的主体、现实性、证据和生命周期校验；
- 谨慎的重复、纠正、冲突、完成与取消规则。
- 三重时间、结构化人物角色和逐条证据可信度的持久化；
- 对旧版确定性信息的安全迁移：已知主主体、原话说话者和逐字证据会回填，未知事件主体保持未知。
- 不确定候选进入独立 `pending` 复核记录，不会为了满足结构化输出而强行写入正式记忆。证据来源存在可解释偏差、但主体和世界边界仍完整的候选，会额外保存一条 `layer=provisional` 的隔离节点；它表示 Agent 对相处经历的未审核个人印象，而不是主体确认事实。
- `pending` 临时印象可以参与受限召回并始终携带“Agent 推断、尚未审核、允许纠正”的认知标签，但不进入正式状态换代、关系图传播、巩固、自然衰退、回忆再激活或反馈学习。世界混杂、主体不完整和持有者冲突不会生成临时印象。
- `pending` 候选可以人工接受、修正后接受或驳回；原候选、临时印象、修正结果、操作者、时间和说明分别留在输入审计中，修正不会覆盖原始证据。决议完成后，临时印象立即退出召回，节点本身只作为隔离审计记录保留。
- 旧导入事件若主体仍为 `unknown`，只能通过 `buildSubjectAttributionSnapshot` 建立有界证据快照，再由 `proposeMemorySubjectAttribution` 保存待审提案。`resolveMemorySubjectAttribution` 只在人工接受时修改主体和人物角色；接受前证据或既有角色发生变化会拒绝旧提案。
- 偏好和观念节点会从已校验的主主体确定性补全持有者；人物角色与主体冲突、非法日期、倒置时间区间和进行中却已有结束时间的候选不会静默写入。
- 明确的 `update`、`complete` 和 `cancel` 会关闭上一状态的有效期并保留状态边；较旧批次不能覆盖得知时间更晚的当前状态。
- `findCanonicalMemories`、`getCurrentCanonicalMemory` 与 `listCanonicalStateHistory` 都可显式指定 `representationLayer`、`stateFamily` 和精确 `stateScopeKey`，避免主体自述、聚合结论、不同家族及局部例外互相抢占同一当前槽。普通当前状态查询默认读取 `root`；人工编辑保留范围身份且不能把既有节点改到另一个范围槽。
- 实体存储已经具备按Agent隔离的规范名称、别名解析、别名冲突拒绝和记忆关联；当前不写死实体类型枚举，也不让模型自动生成地点、物品或人物实体，等待输入评测后再接提取层。
- 检索轨迹和反馈已经有独立持久化接口。召回器默认只返回可保存的轨迹对象，不自行写库，也不会根据一次使用结果自动修改记忆节点或边权。`listMemoryRetrievalStats` 只读聚合每个同 Agent 节点成为种子、进入最终注入及收到人工反馈的次数和最近时间；`listEdgeRetrievalStats` 按轨迹去重统计实际经过的边，并只把有明确目标节点的反馈归因给通往该节点的路径。统计值不回写节点或边，不提高事实置信度，也不参与当前召回排序。
- 回复后的第一条真实用户输入可以先写入奖励观察队列，随后等待独立的最终回复采用分析。奖励链只允许在 `used` 记忆边界内分别判断结果、反馈指向和贡献份额，并生成有界影子信用；一般积极语气、继续聊天和没有纠正默认不构成记忆奖励。当前没有自动应用或跨天自动归因；正式的巩固强度、节点情境效用和关系情境效用状态已经存在，但只能通过带策略版本、边界校验和回滚审计的显式应用入口改变。
- `previewMemoryPlasticity` 与 `previewEdgePlasticity` 只做可塑性资格分类，不直接写入数值。内容错误、已纠正和正负反馈冲突会阻断学习；节点候选与 `accessibility` 分开建模，边候选按查询意图与基础 `weight` 分开指向 `relation-utility`，当前始终禁止自动调整。
- 节点、边和“边 × 查询意图”统计支持半开时间窗口 `[windowStart, windowEnd)`。影子运行可以要求完整结果；候选超过调用方上限时会直接拒绝，不会用被截断的统计生成学习建议。
- 正式学习状态表与影子审计表按 Agent 隔离。相同策略版本和观察窗口的影子结果只能幂等重放；输入变化时拒绝覆盖。召回器默认忽略正式学习状态，只有调用方显式启用可塑性并提供允许的策略版本、中性值和最大影响幅度时，才读取已经正式应用的节点可访问性和关系情境效用。影子记录永远不会改变节点内容、事实置信度、重要性、基础边权或排序。
- `applyPlasticityShadowRun` 要求影子运行 ID、预期输入哈希和显式操作者。目标状态与影子快照不一致时整批拒绝；阻断项不会生效。`rollbackPlasticityApplication` 要求操作者和原因，只能从目标的最新应用状态开始撤销，并恢复前一值或删除原本不存在的状态。两者都不改记忆正文和基础边权。
- `episode` 与 `topic` 已有独立类型、时间约束、多重归属和按Agent隔离的手工接口；它们会参与受预算约束的联想传播，但不会由普通压缩输出或自动关联器直接创建。
- 自动 `same_thread` 只为带明确事件时间、共享 `canonical_key` 的非状态节点建立“旧事件 → 新事件”相邻链；状态节点只依赖正式生命周期边。增量插入会局部重建整条受影响链并移除跨越新节点的旧边，结果与全量重建一致。共享实体邻接排序对状态使用 `valid_from`，不会把较晚补录误认为较晚发生。
- 自动 `associated_with` 的节点上限是双端真实度数预算，不是“每个节点各提若干条后取并集”；增量更新也会清理旧版超额边。结构化状态不参加文本相似度生成的普通语义边或时间边，只走受控证据和生命周期关系。自动 `shares_entity` 在增量写入后按实体链接完整重建相邻链，避免补录中间事件后残留伪三角。
- 结构候选已有独立待审表、`create/attach` 分型、语义去重、接受/驳回审计和原子落库。`memory-structurer` 只读取本批长期记忆与有界附近容器，使用可插拔生成器提出 `pending` 候选；候选成员、挂接目标、episode 时间和新 topic 的跨日期证据均由代码复核，模型无权直接改图。
- 因果关系也已有独立待审表和证据关联表。当前只允许 `causes`，方向固定为“原因 → 结果”；每个证据来源必须属于同一 Agent、已经支持至少一个端点，并且候选证据合计覆盖两个端点。接受候选才会原子创建边，已存在的边不会被候选覆盖；驳回只留审计，未被后续修改的已接受边可以安全撤销。`supported_by` 和状态换代边仍由代码维护。召回器只在明确询问原因时沿已接受的 `causes` 反向寻找原因；普通、时间线、联想和原话查询都不会经过因果边。
- 回顾性巩固已有独立运行记录。规划器只沿既有安全关系，从本批新记忆选择有上限的旧节点；相同输入幂等复用同一次运行。执行器只允许生成“新记忆 + 旧记忆”的结构或因果待审候选，不自动接受、不修改节点正文、不直接写边。空候选不会调用模型；模型失败默认最多重试三次并逐次保存原因和部分提案，最后一次失败或租约崩溃后进入统一人工审核。人工只决定保留已有部分提案还是放弃本次高层升级，不会重跑模型，也不会撤销底层事件和原话证据。
- 偏好状态已有独立待审队列。情境容忍、选择倾向、稳定偏好、明确喜好、明确厌恶和“暂无结论”使用同一 `canonical_key`，但按 `reported/inferred` 分离为不同当前链；待审阶段不写正式节点。局部反证只能挑战同一身份槽，完整同键证据复核才允许降级或缩小范围。接受后，新状态关闭同层旧状态有效期并用 `supersedes` 保留历史，支持与反证分别建立 `supported_by` / `challenged_by`；推断状态保持 `inferred`，不会因人工审核伪装成用户明确表达或验证层事实。审查后证据正文、来源或观察版本发生变化，旧提案会拒绝接受并保持待审。
- 偏好家族已有独立跨层晋升纵切。`proposePreferenceEstablishedPromotion` 只接受当前 `inferred/preference/root` 的 `stable_preference`，要求它来自已经接受的完整同键双重审查，并要求调用方给出不带默认值的版本化阈值。达标后仍只保存 `pending`；`resolveStatePromotionProposal` 接受时重新核对完整证据指纹，才会创建 `established`、复制来源与支持/挑战边、建立 `established_from` 并历史化原推断。同键 `reported` 保持活跃。`revokeStatePromotionProposal` 只有在两层都没有后续状态时才恢复原推断，不能越过后来变化强制回滚。
- Schema v18 新增统一的 `reported` 状态待审队列；Schema v19 为正式节点和本人报告提案增加范围身份；Schema v20 把偏好提案的表示层、范围槽和证据快照哈希提升为一等审计字段；Schema v21 新增跨层状态晋升提案及决议/撤销审计。桥接层只接受明确禁止模型直接写入且通过家族复核的结果，并再次核对 Agent、主体、状态家族、`canonical_key`、表达层、旧状态 ID 和每条证据观察。入队时保存选中正文快照及观察、记忆和来源指纹；审核后证据发生变化会拒绝旧提案。调度重试即使更换批次编号，只要审核输入没有变化仍幂等复用首次提案；`pending` 提案不会创建或关闭正式节点，也不会进入召回。`resolveReportedStateProposal` 只在统一决议入口明确 `accept` 后按动作执行：创建、补证据、换代、暂停/恢复、终结与归属纠错保留不同生命周期语义，任一步失败整笔回滚。产品层只对本轮产生、请求和说话者边界完全一致的本人明确自述开放 `create/reinforce` 自动决议；其他动作仍需人工。`add_scoped_exception` 只接受偏好和行为倾向的家族专用结构化范围：它创建独立当前槽，以 `scoped_exception_to` 连接宽泛根状态，并保持根状态活跃；同一范围已有当前例外时必须重建提案而不能重复写入。在例外继承与失效审计尚未实现前，带活跃例外的根状态不能直接换代或终结，相关提案继续保持 `pending`，避免例外被静默孤立。
- 人物高层状态已实现身份、观念、偏好、习惯、行为倾向、价值、目标、能力、关系、情绪联结、自我认识和现实条件十二个家族的专职分析与明确表达复核。`condition` 不是人格标签，而是防止把工作、健康、资源等约束误写成偏好或性格的解释层。每个家族拥有独立目标字段、Schema、证据边界和变化动作；完整的 `explicit/reported` 请求可以生成统一的 `pending reported-state` 提案。产品层只对本轮产生、说话者与主体一致、证据完整且动作仅为 `create/reinforce` 的本人明确自述开放确定性自动接受。状态变化、冲突、行为推断和来源不完整的结果仍需审阅。关系证据不等于程序运行权限；情绪联结只有经过独立人工授权和本轮显式配置才可形成有界排序偏置。
- 通用状态证据账本使用规范化来源和分析调用关联，保持 Agent、主体与 `canonical_key` 隔离。一次语义重放不会重复制造证据；新的不同判断会把旧观察标记为 `superseded`，而不是删除历史。被外部约束或其他门控排除的证据保留原始声称方向，但有效方向固定为 `neutral`。

Core 与具体聊天平台、RAG Hook 和模型厂商无关；宿主通过标准事件、Service、SDK、CLI 或 HTTP API 接入。旧 `history.jsonl` 与 `events.jsonl` 只由可选迁移接口读取，不是正式运行依赖。数据库已经能表达完整人物角色，但自动提取器只写入能够从消息方向或明确字段确定的角色，不会凭正文猜测未知事件主体。
