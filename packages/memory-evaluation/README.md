# Memory Evaluation

## 身份与生平事实

`evaluateIdentityEvidence` 让调用方固定个人主体、`canonicalKey`、`identityField`、可读标签、字段基数策略和有界记忆，再把字段与值、主体与来源、相邻家族边界与敏感性、时间变化、和只读当前身份的关系拆成五个专职调用。字段基数只能由代码指定为 `single`、`multi_item` 或 `sequence`；模型不能决定一个新值应覆盖旧值，也不能自行创造身份键。

代码只允许姓名、生日、职业、单位、教育、长期居住地、籍贯和明确生平节点等进入身份证据。临时位置与短期状态回到 `condition/event`，关系称呼回到 `relationship`，自我评价回到 `self_concept`，偏好、能力和价值继续由各自家族处理。密码、验证码、Token、API Key 和私钥等凭证会被确定性门禁排除，任何来源都不能生成身份候选。

`reviewReportedIdentityState` 只读取明确以 `reported` 层为当前比较目标的证据，为主体本人直接报告的当前或恒定身份事实生成 `fact` 影子候选。候选只证明主体当前这样报告，外部验证固定为 `unverified`；官方记录和系统记录可以进入独立证据层，但不能冒充主体亲口报告，第三方转述和 Agent 推测也不能建立身份。

单值和序列字段只有出现明确 `changed/ended/clarified/denies_prior_state` 线索时才预览换代、结束、收窄或归属纠正。多值字段的每个项目必须使用值级 `canonicalKey`，发现另一个值时进入复核而不是关闭旧值。所有输出固定禁止自动状态写入、外部账户同步、已验证身份写入和凭证写入，也不会传播成关系、自我认识或实时位置。

## 偏好形成模拟

`simulatePreferenceFormation` 用于在不写入人格记忆的前提下，离线比较“哪些证据只能说明行为、哪些证据可以提出偏好候选”。它没有默认阈值，调用方必须显式提供带版本号的策略、行为信号权重、机会成本倍率、最低置信度、稳定偏好门槛、独立证据数、跨日期与跨情境数、选择证据数、单日贡献上限和反证比例上限。

行为证据先经过硬门控，再参与计分：主动选择必须确认主体具有主动性、没有生存/工作/制度等约束、不是为了收入或完成任务，并且当时存在真实替代项；主动分享还必须由主体主动发起或主动回到话题，并有可追溯的积极表达；情境容忍只接受“可以拒绝但仍自愿接受”的证据。机会成本只放大已经通过门控的自由选择，不能替被迫行为抵消约束。

硬边界不由策略放松：一次性行为、被动曝光和 Agent 猜测始终不能作为支持偏好的证据；不同主体不能混合；同一证据组只保留最强贡献，同一天的总贡献有上限。明确喜欢和明确否定同时出现时，模拟器要求先按时间处理状态换代，不擅自选择哪一条代表当前。

模拟结果分为四层：`behavior-only`、`situational-tolerance`、`selection-tendency` 和 `stable-preference-review`。前三层不能被包装成稳定偏好；行为推断达到稳定门槛时也只建议创建 `derived_hypothesis` 待审。主体明确表达的当前偏好返回 `direct-preference` 和正式 `preference` 候选，但仍不自动写库；明确支持与否定并存时返回 `state-change-review-required`。

所有结果固定返回：

- `automaticMemoryWriteAllowed: false`；
- `automaticPreferencePromotionAllowed: false`。

这个模拟器不负责从文本猜测主动性、约束、替代项、工具性目标、机会成本或情感表达，也不连接正式写入链路。调用方必须提交有原始证据引用的可审计标注。它的用途是先用脱敏案例和真实私有评测窗口比较参数，再决定候选生成器、人工审核和状态换代产品规则。

### 有界偏好证据标注

`evaluatePreferenceEvidenceTarget` 是模拟器前面的第一条安全输入纵切。调用方先固定 Agent、偏好持有者、`canonicalKey`、本次允许检查的记忆 ID 和策略；生成器只能在这批有界记忆中提出证据标注，不能自己决定偏好属于谁，也不能扫描全库发现主题。

输入快照只包含活跃、现实、具有直接原始来源的长期记忆，以及结构化人物角色、事件时间、已审核事件簇和有字符上限的来源正文。文件路径、来源元数据、检索轨迹和数据库写接口不会进入快照。生成结果必须引用所选记忆自己的来源 ID；越界记忆、引用别条记忆的来源、主体角色不符、同一记忆重复标注都会被代码拒绝。

证据组和情境不由模型填写：同一已审核事件簇使用同一组；没有事件簇时，相同直接来源集合使用同一证据组；无法证明更细情境时，同一自然日按同一情境处理。这样会保守地低估独立选择，但不会让一次谈话拆成多条记忆后伪造“多次证据”。

生成器可以返回空数组。通过边界策略的标注先进入 `simulatePreferenceFormation` 预览，整个流程固定返回 `automaticMemoryWriteAllowed: false`，不会直接写正式记忆、不建主题、不接受候选。调用方可以在固定主体、固定目标名称和适用范围后，显式调用 `proposePreferenceStateFromEvaluation` 把可持久化结果写成 `pending` 偏好状态提案；这一步仍不改变当前偏好。

评估默认把本次模型调用写入 `memory_state_analysis_runs`，并把通过边界检查的有效或被门控排除的标注写入通用状态证据账本。它们是审计数据，不会被普通记忆召回，也不会增加 `memory_nodes`。工作约束下的高频加班等标注会保留“模型曾声称支持偏好”，但代码将其 `effective_direction` 设为 `neutral` 并记录排除原因；相同语义重放复用证据观察，同时保留每次模型调用记录。纯构造或兼容调用可以显式设置 `recordEvidenceLedger: false`，正式影子运行不应关闭审计。若配置用量流水路径，真实生成调用还会以 `memory-preference-evidence` 记录统一 token 用量；测试使用固定生成结果，不调用外部 API。

偏好状态提案区分 `situational_tolerance`、`selection_tendency`、`stable_preference`、`direct_preference`、`explicit_rejection` 和 `no_conclusion`，并把 `reported` 与 `inferred` 固定为不同当前槽。行为形成的前三类和“暂无结论”只能进入 `inferred`；明确喜好与厌恶只能进入 `reported`。局部窗口内的反证只能挑战同一表示层的当前状态；只有调用方明确声明并承担“完整同键证据复核”责任时，代码才允许生成降级或缩小范围候选。正式接受由 `memory-core` 处理，旧状态、有效期、支持证据和反证都保留；人工接受本身不会把推断升级为 `established`。

### 专职偏好分析与反证匹配

`evaluatePreferenceEvidenceSpecialists` 把单模型标注拆成五个可并行、各自有独立 Schema 和提示词的调用：对象归属、明确表达、行为条件、分享与情感投入、时间与范围。`mergePreferenceSpecialistEvidence` 只用代码合并这些结构化结果；对象不匹配、约束行为、历史表达和跨角色冲突保持排除或未决，不采用多数投票，也不写正式人格节点。

如果同一主体与 `canonicalKey` 已有当前偏好，新的 `explicit_rejection` 或 `counter_behavior` 会先以 `counter-match-required` 写入证据账本，生效方向保持 `neutral`。`evaluatePreferenceCounterEvidence` 只读取该当前状态和调用方显式指定的待匹配观察，区分同范围冲突、子类例外、情境例外、暂时条件、历史证据、非冲突与未知。只有范围精确重叠且时间覆盖当前状态的 `same_scope_conflict` 才会生成有效反证；其余结果保留审计和适用范围，但不会拉低当前偏好。

每个专职调用与反证匹配调用都独立保存模型、提示词版本、输入哈希、来源、结构化输出、拒绝项、用量和费用。当前这条链路仍是有界影子纵切：它会版本化状态证据观察，但不会自动创建、升级、降级或接受偏好状态。

`reviewReportedPreferenceState` 单独整理主体本人直接表达的当前喜欢、偏爱或厌恶，只读取 `reported` 层当前状态。它记录的是“主体目前这样说”，跨情境稳定性固定为未验证；主动选择、重复投入和自发分享继续留在行为聚合层，不能反向伪造成主体亲口说过的话。被迫加班、单位反复提供某种食物等约束行为也不会进入明确表达层。

偏好改口由时间与范围专职分析器显式区分普通表达、改变喜恶、范围澄清和否认旧归属；不能因为两句话表面冲突就猜测主体改观。明确改变只预览 `reported` 层换代，稳定偏好与 `selection_tendency` 保持不变；“喜欢鱼，但不吃生鱼”这类相反的局部澄清只生成保留宽泛历史的 `add_scoped_exception` 预览，不把整个类别偏好覆盖掉。没有变化线索的相反表达、范围扩大和同一时刻冲突进入复核。接口固定禁止任何自动状态写入。

`processStateAnalysisRequest` 已把压缩器保存的状态分析请求接到明确表达链。当前领取 `reported/explicit` 下参数已经完整的十二个家族：偏好、目标、价值、能力、自我认识、现实条件、习惯、行为倾向、身份、观念、关系和情绪联结。身份、观念、关系和情绪联结必须分别携带由压缩时固定的身份字段与基数、命题对象、关系对方、触发对象；执行器不会把可读标签再次拆猜成这些关键字段。执行前重新核对请求固定的记忆与来源边界，只在该请求内临时允许读取 `utterance` 的 `verbatim` 原文；随后按家族运行各自的专职分析器、代码门禁和确定性声明层复核。

完整分析没有合格结论时，请求可以以“无提案”完成；有结论时只生成独立的 `pending reported` 提案。任一专职调用失败会返回 `retryable-failure` 并保留请求为 `pending`，固定目标或证据边界损坏才会进入 `blocked`。原始 `utterance` 的 `evidenceMode` 不会被改写；只有本次请求明确列出的观察在审查快照中获得临时声明通道资格。执行器不扫描请求之外的对话、不处理行为推断、不自动接受提案，也不会直接新增正式 `memory_nodes`。

没有完整结构目标的四类请求继续保持 `pending`，不会被批处理额度吞掉。所有 `inferred` 请求也保持待处理。

`processPendingStateAnalysisRequests` 是调用方显式触发的有界单 Worker 批处理。调用方必须提供 `maxRequests`；处理顺序稳定，一条可重试失败不会阻断后续请求，未支持家族不会被领取。它不是后台调度器，也没有多进程领取租约；在实现原子抢占前，不应由多个 Worker 并发调用。

### 最终回复中的记忆采用判定

`UserPromptSubmit` 只记录本轮向 Agent 暴露了哪些长期记忆。主 Agent 正常结束后，非阻塞 `Stop` Hook 把同一运行会话中尚未绑定的最新召回轨迹与最终可见回复固化为 `pending` 使用判定请求；Hook 本身不调用模型、不修改回复，也不会把“注入过”直接当成“采用过”。用户中断导致没有正常 Stop 时不会伪造判定；下一次用户输入会替换当前会话指针，避免把旧轨迹绑定到错误回复。

`processRetrievalUsageRequest` 让独立模型只依据最终可见回复，对原轨迹中每条已选记忆返回 `used`、`not_used` 或 `uncertain`。代码要求所有原节点恰好出现一次，拒绝缺项、越界节点、跨 Agent 节点和变化后的回复正文。只有 `used` 会追加一条 `used` 反馈；`not_used` 不代表记忆无关，`uncertain` 不产生反馈，正确性、帮助性、错误与纠正仍不能由这条链推断。

`reviewPreferenceCanonicalState` 负责固定主体与 `canonicalKey` 下的完整证据影子复核。它不静默截断观察；已有当前状态时，还会核对该状态所有 `supported_by/challenged_by` 证据记忆是否已经出现在当前证据账本。旧状态缺少证据边或账本覆盖不完整时直接停止，避免只看到后来反证就错误降级。

完整快照把有效、排除和未决观察全部展示给两个独立调用，并把当前状态固定在 `inferred/preference/root` 槽。代码先用显式策略计算确定性预览；状态综合器必须逐条覆盖全部有效观察，并且只能从代码给定的层级和动作中选择。独立质疑器只读取同一快照、确定性预览和综合器最终结构化方案，不读取隐藏推理。主体串位、范围泛化、时态错误、遗漏反证、无依据升级，以及“报告关键问题却同时批准”等结果会被代码拒绝。质疑器通过后仍只返回 `approved-shadow`；调用方必须再显式调用 `proposePreferenceStateFromCanonicalReview` 才会产生 `pending inferred` 提案，且该步骤仍不写正式节点。

桥接层会重新核对当前推断状态、完整观察集合、观察哈希和两个审查调用，并把证据记忆及直接来源的指纹固化进提案。审查后新增、撤回或重分析证据，或者人工修改证据正文与来源，都会让旧提案在接受时失败并保持 `pending`。同键的 `reported` 当前偏好可以与这条行为推断链并存，不会抢占其前态。

`established` 不由本包的状态综合器直接输出。人工接受后的当前 `inferred` 稳定偏好还要由 `memory-core` 的 `proposePreferenceEstablishedPromotion` 经过另一份显式版本化门槛生成独立 `pending` 提案；接受时会再次验证完整来源、关系和观察快照。该纵切没有产品默认阈值，也没有自动接受或自动调度，不能通过提高模型置信度绕过。

### 现实条件、习惯与行为倾向分流

`evaluateBehaviorStateEvidence` 让调用方为 `condition`、`habit`、`disposition` 中任意一个或多个家族分别固定主体、`canonicalKey`、可读目标名和有界记忆 ID。每个已选择家族使用独立提示词、JSON Schema、模型调用、调用审计和用量功能名；调用可以并行，一条链路失败时整批标为 `incomplete`，但其他家族已经完成的证据观察仍会保存，不会被失败调用抹掉。

`reviewReportedDispositionState` 只把主体本人直接作出的当前行为倾向自我描述整理成 `reported` 层影子候选。候选证明主体当前这样理解自己的应对规律，客观倾向与跨情境状态保持未验证；一次行为、跨情境聚合结果、第三方评价和 Agent 总结都不能冒充主体的自我描述。第三方对主体的倾向判断应留在判断者的 `reported belief`，不能写进被判断者的 `reported disposition`。

自我判断的明确改观、范围澄清和否认旧归属只影响 `reported` 层；相反的局部情境使用保留宽泛历史的 `add_scoped_exception`，没有变化线索的冲突和范围扩大进入复核。接口不自动建立人格结论、不写行为证据，也不改变跨情境聚合层。

`reviewReportedConditionState` 与 `reviewReportedHabitState` 分别整理主体本人报告的当前现实条件和重复生活规律。条件报告可以立即形成带时间、作用和范围的 `reported` 候选；习惯报告必须明确为重复或稳定规律，一次行为不能创建习惯。直接观察、第三方转述和 Agent 推断不会冒充本人报告，条件或习惯也不会被借用来推断喜欢、价值或人格。

明确条件结束只预览 `end`，明确习惯中断或停止只预览 `interrupt/stop`；状态改变、范围澄清和否认旧归属保持独立动作。所有动作只影响相应表达层并固定不自动写入，直接观察聚合层与历史事件保持不变。

三个家族的代码门禁彼此独立：

- `condition` 只接受主体本人明确报告或直接观察到的现实条件，并保留条件类型、作用、时间和范围；推测、第三方转述、未来条件和时间不明保持未决。
- `habit` 接受直接证据支持的重复或稳定行为，也保留工作、制度、健康等约束；约束不取消生活规律，但单次行为不能成为习惯，停止或中断形成反证。
- `disposition` 接受主体明确的自我描述，或至少两个由代码确认的不同证据情境和不同情境标签中的同类反应。单次反应、同一情境重复、第三方标签、推测，以及共同外部约束可以解释的行为都不能形成有效倾向证据。

分析器不能自行发现主题、创造 `canonicalKey`、改变主体或引用其他记忆的来源。通过、排除和未决结果都写入通用状态证据账本；它们不会新增 `memory_nodes`，也不会自动生成或接受状态提案。当前纵切只完成证据分流与审计，条件、习惯和行为倾向的完整同键聚合、换代与正式召回仍需后续实现。

### 观念证据与变化预览

`evaluateBeliefEvidence` 在调用方固定观念持有者、`canonicalKey`、主题名和有界记忆后，并行运行命题范围、持有者归属、时间变化、与只读当前状态关系四个专职分析器。命题分析不会认证客观事实；持有者分析要求结构化说话者和固定主体一致；时间分析区分当前、历史、未来、改观、范围修正和“从未持有”；关系分析区分等价、补强、扩大、缩小、局部例外、同范围冲突和撤回。

代码只在四类结果通过来源、主体、时间和范围门禁后写入 `belief` 证据观察，并生成逐条影子动作：`create`、`reinforce`、`supersede`、`narrow_scope`、`contradict`、`correct_attribution` 或 `no_conclusion`。一次局部反例只能提出范围收缩，不能把旧普遍结论翻成相反的普遍结论；后来改观使用 `supersede` 保留旧历史，只有主体明确否认曾持有旧观念时才允许提出 `correct_attribution`。

当前状态只作为有界只读比较基准；分析器伪造或漏报其存在会被拒绝。任何影子动作都固定返回 `automaticStateWriteAllowed: false`，不会调用正式状态写入、关闭旧节点或创建换代边。任一必要分析器失败时只保留调用审计，不写不完整的合并观察。

### 目标、承诺与未完事项

`evaluateGoalEvidence` 把固定目标拆成目标与意图层级、持有者与责任、生命周期与闭合依据、与只读当前目标关系四个专职调用。代码区分愿望、考虑、决定、计划、承诺、未完事项和外部要求；愿望不会成为计划，尚在考虑保持未决，未接受的工作或制度要求回到 `condition`，不会伪装成自主目标。

完成和取消需要主体明确报告或直接结果/解除记录；模型推测、预计时间已到、等待、阻塞和暂时无消息都不能闭合目标。候选只是旧目标的一个步骤时只允许 `progress_update`，不能替换整体；较大的上位目标和冲突状态进入复核。输出只给出 `plan/commitment/open_loop` 建议类型和不生效的 `create/reinforce/progress_update/pause/resume/complete/cancel/supersede/review_required/no_conclusion` 预览，不执行状态变化。

当前纵切只接受固定的个人主体。`shared` 目标和双方承诺会直接拒绝，因为单方一句“我们”不足以证明共同责任；它们需要后续关系模块的双边证据复核。

`reviewReportedGoalState` 把主体本人直接表达的决定、计划、单方承诺或未完事项整理成 `reported` 层影子候选。候选只证明主体作出了该目标声明，不证明已经执行、具备完成能力或必然完成；愿望、仍在考虑、Agent 推测、第三方安排和单方“我们一起做”不能进入该层。证据还必须明确以 `reported` 当前层为比较目标，不能拿执行聚合层的关系结果换代目标声明。

主体直接报告开始、暂停、恢复、完成或取消时，可以只预览声明层的生命周期动作。工具产物或外部结果属于独立执行证据，不会被伪装成主体亲口报告；`complete/cancel/progress_update` 也不会创建新的目标候选。所有结果固定禁止自动写入、客观完成事实、能力状态、共享承诺、提醒或任务创建。

### 关系、角色、边界与许可

`evaluateRelationshipEvidence` 只评估调用方固定的“个人主体 → 固定对象”关系键，并把关系命题、观点与方向、范围与时间、和只读当前关系的比较拆成四个独立调用。关系命题保留角色、称呼、信任、边界、许可、期待、亲近、约定和支持等类型；许可与边界必须保留具体范围，条件许可必须保留条件，不能从“可以查看位置”扩大成“可以查看全部设备”。

代码只接受固定主体本人的直接表态作为个人关系证据。对方指向主体的关系是反方向；Agent 对用户的推测仍是 Agent 的观念；单方一句“我们很亲密”只是对双方的声称，不能证明双方独立确认。共享关系与双方约定在双边复核实现前直接拒绝，一次争吵、冷淡或情绪变化也不会自动改写长期关系。

现有关系只能作为只读比较基准。撤回必须同时具备明确撤回用语、同一当前关系和精确范围重叠，局部权限变化不能撤销其他权限。输出只写通用关系证据账本并给出 `create/reinforce/narrow_scope/supersede/revoke/contradict/review_required/no_conclusion` 影子预览，固定禁止正式状态写入，也不会授予、撤销或执行任何程序运行权限。

`reviewReportedRelationshipState` 进一步把主体本人直接表达的当前单方关系观点整理成 `reported` 层影子候选。候选的状态主体始终是观点持有者，对方只保存在 `counterpart`；`truthStatus` 固定为 `unverified`，`sharedConfirmation` 固定为 `unconfirmed`。因此“甲觉得乙不在乎自己”可以记录为甲的关系理解，但不会成为乙的动机、人格或双方共同关系。

该复核只接受明确以 `reported` 层为当前比较目标的关系证据，避免拿与聚合层比较的结果换代单方观点。甲乙相反的观点可以分别存在；单方“我们”声称、第三方评价和 Agent 推测不能进入该层。明确替换或精确撤回只影响同一持有者的 `reported` 状态，另一方观点、共享关系、聚合结论和软件运行权限均保持不变。

### 价值与优先级

`evaluateValueEvidence` 让调用方固定个人主体、`canonicalKey`、价值标签和有界记忆，再并行运行价值目标与立场、持有者归因、证据基础、时间变化、与只读当前价值关系五个专职调用。价值证据明确区分原则表达、有理由的优先级、真实代价取舍、普通选择、受约束行为、工具性行为、口号愿望和没有取舍。

代码只把主体本人直接表达的原则或直接讲述的取舍作为候选。`costly_choice` 还必须同时具备真实替代项、主动选择、可识别代价和被保护对象匹配；工作、生存、制度、惩罚等约束以及为了其他目标而执行的工具步骤会被排除，普通低代价选择保持未决。第三方标签、Agent 人格概括、历史原则和未来愿望都不能冒充当前稳定价值。

单条合格原则或代价取舍也不会直接创建价值状态；没有当前状态时只返回 `accumulate_evidence`，等待后续完整同键聚合检查独立证据、跨情境一致性和反例。已有只读状态时才可能预览 `reinforce/narrow_scope/contradict/supersede/review_required`，其中替换必须有主体明确改观。所有结果只写通用证据账本，固定禁止自动状态写入。

`reviewReportedValueState` 只读取 `reported` 当前状态，并为主体本人直接表达的当前原则或有理由优先级生成价值主张候选。候选证明“主体目前这样声明”，不证明其跨情境稳定践行；真实代价取舍继续作为聚合层表现证据，不会被伪装成主体说过的原则。第三方判断、Agent 总结、口号和未来愿望不能进入该层。

明确改观只预览主张层换代，明确范围澄清只预览收窄；稳定价值层保持不变。不同主张没有变化线索、同一时刻冲突或范围扩大时进入复核。接口固定禁止自动写入稳定价值、行为倾向和行为证据。

### 能力与熟练度

`evaluateCapabilityEvidence` 固定个人主体、`canonicalKey`、能力标签和有界记忆，再拆分技能任务范围、主体归因、表现结果、独立程度与依赖、时间变化与只读当前状态关系五个专职调用。能力证据保留实际任务、难度、成功/部分成功/失败、熟练度声称、独立/协助/工具依赖、一次性或重复声称及适用条件。

代码不会把兴趣、目标、安装了工具、读过教程或只有指导过程写成稳定能力。本人自述可以形成能力声称；结构化 `observed` 记忆可以形成直接表现证据。单次成功即使可核对也只累计该任务范围的证据，不能直接建立稳定熟练度；借助工具或他人完成不会被抹掉，但依赖必须保留。

失败会先区分技能缺口、环境故障、工具故障和外部限制。后三者不成为能力反证；同范围技能缺口可以进入反证账本，但单次失败只返回复核预览，不能自动降级。只有主体明确表示能力已经丧失且范围精确匹配时才可能预览 `retire`。所有动作都固定不生效，不创建、升级或关闭正式能力节点。

`reviewReportedCapabilityState` 只读取 `reported` 层的当前状态，为主体本人直接、当前的能力自述生成独立影子候选。候选保存具体技能、任务范围、自述熟练度、独立程度和依赖条件，并把 `verificationStatus` 固定为 `unverified`。实际成功、失败和工具输出仍属于表现证据，不能冒充主体说过的话；第三方评价和 Agent 夸奖也不能变成主体的能力声称。

自述熟练度明确提高或降低时只预览声称层换代，明确丧失时只预览关闭声称层；已验证能力层保持不变。没有变化线索的不同熟练度、范围扩大和同一时刻冲突进入复核。接口固定禁止自动写入、已验证能力写入、熟练度晋升和表现证据写入。

### 自我认识与人生叙事

`evaluateSelfConceptEvidence` 固定个人主体、`canonicalKey`、自我认识标签和有界记忆，并把自我概念目标、持有者归因、稳定性语境、时间变化、与只读当前认识关系拆成五个专职调用。自我描述、自我角色、人生叙事、个人标准和自我效能保留各自范围，不与客观身份事实、行为倾向或能力状态混写。

代码只接受主体本人的直接自我定义或反思。职业、居住地等事实回到 `identity/fact`；争吵、失败、疲惫或兴奋中的临时自责/自夸被排除；第三方标签和 Agent 人格总结保持未决。转折事件可以成为反思语境，但没有主体自己的反思时不能替主体生成“因此我成为某种人”。

单条合格的当前自我定义可以生成 `reported` 层的主观自我认识候选，但不能自动变成客观人格。已有只读状态时，明确改观、局部澄清和“从未这样理解过自己”分别只能预览 `supersede`、`narrow_scope` 和 `correct_attribution`；所有结果固定不生效，也不会写入 `disposition` 或客观身份。

### 情绪联结与触发

`evaluateAffectiveAssociationEvidence` 固定个人体验主体、触发对象、`canonicalKey`、联结标签和有界记忆，再把触发对象与情绪、体验主体归因、关联依据、时间变化、与只读当前联结的关系拆成五个专职调用。触发对象可以是人物、地点、事件、话题、感官线索或其他实体；情绪类型、正负性和强度分别保留，不能用单一正负标签覆盖混合感受。

代码只接受主体本人直接报告的情绪触发。对象与情绪在同一场景出现只是共现，当前心情、一般偏好、第三方判断和 Agent 语气推测不会变成长期情绪联结。一次明确触发只累计一条具体证据；反复模式也必须来自主体明确的重复声称，当前不会从沉默或一次不同反应推断联结已经消退。

已有当前联结只作为只读比较基准。增强、减弱、情绪改变和消退必须分别具有匹配的明确变化线索；输出只给出 `accumulate_evidence/reinforce/narrow_scope/review_required/contradict/supersede/retire/no_conclusion` 影子预览。所有结果固定 `automaticStateWriteAllowed: false` 和 `activationBiasAllowed: false`，既不创建正式情绪节点，也不改变召回排序。

`reviewReportedAffectiveAssociationState` 进一步只读取明确以 `reported` 层为当前比较目标的证据，为主体本人直接报告的当前“触发对象 → 情绪”联结生成表达层影子候选。该候选只证明主体当前这样报告，`crossTimeStability` 固定为 `unverified`，`activationBiasStatus` 固定为 `disabled`；已聚合验证的情绪联结不能占用本人自述层，单次共现、当前心情、一般偏好、第三方解释和 Agent 推断也不能进入。

明确增强、减弱、情绪改变、消退、范围澄清和否认旧归属只预览 `reported` 层的强化、换代、收窄、关闭或归属纠正。没有匹配变化线索的不同报告、范围扩大和同一时刻冲突进入复核。接口固定禁止自动状态写入、稳定情绪联结写入和激活偏置写入；偏好、关系与聚合层保持不变。

### 通用同键证据快照

`buildCanonicalStateEvidenceSnapshot` 为各状态家族建立一致的完整复核输入。调用方必须固定 Agent、状态家族、主体、`canonicalKey` 和可读标签；代码只读取该目标全部 `current` 证据观察，并同时保留 `qualified`、`excluded` 和 `unresolved`。证据按 `evidenceGroupId` 与 `contextId` 整理，但分组只表示可能共享一次独立证据，不参与投票或跨家族通用计分。

快照不会裁掉观察、记忆正文或原始来源后继续声称“完整”。任一显式数量或字符预算超限会直接停止。已有当前状态时，全部 `supported_by/challenged_by` 证据记忆必须已经进入同家族、同主体、同键的当前证据账本，否则拒绝复核。该接口不调用模型、不写数据库、不创建提案，也不决定状态动作；偏好、能力、价值等家族仍须使用各自的确定性策略、综合器和质疑器。

凡专职模型需要判断新证据与当前状态的关系，调用方还必须固定 `currentRepresentationLayer`。该层会进入批次标识、快照目标、模型输入策略、证据观察范围和调用审计；`reported` 复核只消费明确标记为 `reported` 的关系分析。缺失标记或针对 `established/inferred` 层生成的分析不会被拿来换代本人自述。偏好、条件、习惯和行为倾向的明确表达复核使用确定性代码比较完整快照，不依赖这类模型关系结论。

### 明确表达型观念状态

`reviewReportedBeliefState` 使用通用完整快照，为主体本人直接表达的当前观念生成 `reported` 层影子候选。调用方除固定观念持有者和 `canonicalKey` 外，还必须固定命题对象；输出始终把持有者放在状态主体位置，把被评价的人或事放在 `propositionTarget`，并把 `proposition.truthStatus` 固定为 `unverified`。

因此“甲认为乙自私”可以成为甲的 `belief_state` 候选，但不会成为乙的 `fact` 或 `disposition`。多条内容不同的直接判断若没有明确改观线索会进入复核；同一时间的冲突表达也不会由代码任选一条。已有当前观念时，补强、收窄、明确改观和纠正错误归因分别只生成影子动作。该接口固定禁止状态自动写入，也禁止把判断传播成命题对象的人格或事实。

### 明确表达型自我认识状态

`reviewReportedSelfConceptState` 使用同一完整快照，为主体本人稳定、直接且指向当前的自我定义生成 `reported` 层影子候选。候选记录的是“主体目前怎样理解自己”，不是系统对其人格的诊断。急性情绪中的自责或自夸、第三方标签、Agent 总结、客观身份事实和没有主体反思的转折事件都不能进入该候选。

没有当前状态时，单条合格定义可以预览 `create`；已有状态时，补强、范围收窄、明确改观和纠正错误归因只生成对应影子动作。多条不同自我定义若缺少明确变化线索必须进入复核。接口固定禁止自动写入、客观身份写入、行为倾向写入和人格诊断，复核前后的正式状态均保持不变。

## 可塑性参数模拟

`simulatePlasticityTransition` 用于离线比较长期可访问性或关系效用参数。它没有默认策略，调用方必须显式提供策略版本、上下限、半衰期、各类增益/惩罚、单次最大变化量和观察窗口 ID。缺少窗口 ID 会直接拒绝；纯模拟器不保存窗口使用状态，调用它的评测流程仍必须保证输入是该窗口内的增量统计，并负责防止同一窗口被重复应用。

模拟结果始终包含 `automaticAdjustmentAllowed: false`。它不会打开数据库、写入记忆或参与召回；内容错误、已纠正和正负反馈冲突还会阻断衰减与学习，等待人工处理。

## 可塑性影子运行

`runPlasticityShadow` 用真实数据库中一个已关闭增量窗口的检索轨迹和人工反馈生成候选变化，并写入独立审计表。它要求显式提供：

- Agent ID；
- 唯一观察窗口 ID 与 `[windowStart, windowEnd)`；
- 节点和关系两套带版本号的完整策略；
- 节点可访问性与关系效用的初始值。

同一个 Agent、组合策略版本和观察窗口只能有一份输入。完全相同的重放返回原记录；同窗输入发生变化会直接拒绝，避免一天被重复学习或覆盖。节点统计与“关系边 × 查询意图”统计必须完整，达到结果上限时也会拒绝，而不是静默漏掉候选。

影子运行只写 `memory_plasticity_shadow_runs` 与 `memory_plasticity_shadow_changes`。它不会写 `memory_accessibility_state` 或 `memory_edge_relation_utility_state`，不会修改基础边权，也不会参与当前召回排序。`memory-core` 另有需要显式操作者、预期输入哈希和回滚审计的人工应用接口，但本评测包不会自动调用它。影子的用途是先用多个真实窗口校准参数并检查错误强化风险，不是偷偷开启在线学习。

```js
import { runPlasticityShadow } from "@suzu-lives/memory-evaluation";

const result = runPlasticityShadow({
  databasePath,
  agentId,
  observationWindowId: "2026-08-01-day",
  windowStart: "2026-08-01T00:00:00.000Z",
  windowEnd: "2026-08-02T00:00:00.000Z",
  policies: {
    memory: memoryPolicy,
    edge: edgePolicy,
  },
  initialMemoryAccessibility: 0.5,
  initialEdgeRelationUtility: 0.5,
});
```

`@suzu-lives/memory-evaluation` 是长期记忆重构前后的固定评测层。它既可以只读评测召回结果，也可以评测“原始对话能否被正确提取为长期记忆候选”。评测器本身不修改节点、关系、Hook或Agent工作目录。

## 为什么先做它

没有基线时，增加图传播、权重学习或主题节点后，很难判断记忆是真的变好了，还是只变得更容易强行召回。评测包把每个真实问题拆成可检查的预期：

- 应该返回或跳过的状态；
- 正确的种子和必须/禁止出现的节点；
- 主体归属；
- 主体不一致候选与过期状态是否由对应门禁明确拒绝或抑制，而非仅仅碰巧没有排到第一；
- 时间链与关系方向；
- 注入文本必须包含或不能包含的内容；
- 最终上下文长度；
- 历史状态被直接命中时，当前替代状态必须同时出现。

评测失败会被记录在报告中，默认不会让命令报错。这样可以如实保存“改造前是什么样”，而不是为了测试全绿去修改召回逻辑。需要在持续集成中阻止退化时再使用 `--strict`。

## 数据边界

- `fixtures/example-cases.json` 只有脱敏构造案例，可以进入仓库。
- 真实聊天案例应放在软件的 `runtime/memory-evaluation/<agent-id>/cases.json`。
- 本机报告应放在同一运行目录下。根目录 `.gitignore` 已忽略整个 `runtime/`。
- 报告默认只保存上下文长度和SHA-256，不保存实际注入文本。
- 只有显式使用 `--include-context` 时才把注入文本写入本机报告，该报告不得上传仓库。
- 输入评测报告默认也只保存摘要长度、候选字段和正文SHA-256；只有JavaScript调用显式设置 `includeContent: true` 才保存候选正文与摘要。

## 明确表达层待审桥接

`proposeReportedStateFromReview` 把家族专用审查器的 `ready` 结果转换为统一 `pending` 提案。它只处理 `reported` 表达层，要求审查器明确返回 `automaticStateWriteAllowed: false`，并保存审查版本、输入哈希、规范化状态草稿、旧状态 ID、选中证据及全部考虑过的证据观察。跨家族、跨主体、跨 `canonicalKey`、跨表达层、证据越界和旧状态漂移都会拒绝；`skipped` 与 `review_required` 不会入队。

桥接只写审计队列，不写 `memory_nodes`。完全相同的审查输入在不同调度批次重放仍复用同一提案；批次编号只记录首次生成来源，不参与提案身份。入队时由 `memory-core` 固化选中正文和证据指纹，审核后证据变化会要求重建提案。正式状态只有调用方随后显式执行人工接受才会变化；不存在自动接受。人工驳回只改变提案审核状态。偏好与行为倾向的 `add_scoped_exception` 在接受时由 `memory-core` 从家族专用结构化范围生成独立范围槽，保留宽泛根状态并建立显式范围关系；桥接层和模型都不能自行指定范围键。

## JavaScript API

```js
import {
  createCurrentRetrieverExecutor,
  loadEvaluationCases,
  runMemoryEvaluation,
} from "@suzu-lives/memory-evaluation";

const loaded = loadEvaluationCases(casesPath);
const report = await runMemoryEvaluation({
  cases: loaded.cases,
  execute: createCurrentRetrieverExecutor({
    databasePath,
    agentId,
    embeddingProvider,
  }),
});
```

案例格式以 `fixtures/example-cases.json` 为准。评测器与当前数据库字段解耦；将来更换召回实现时，只需提供一个返回同类观察结果的执行器，原有案例仍可继续使用。

## 长期记忆输入评测

`fixtures/ingestion-cases.json` 是不调用外部模型也能运行的脱敏输入基线，当前覆盖：

- 一次性日常行为不能被推导为稳定偏好；
- 用户明确偏好可以进入长期记忆；
- Agent猜测不能转写成用户事实；
- 用户经历不能转移给Agent；
- 角色扮演不能成为现实经历；
- 切点处未完成事件必须保持进行中；
- 双方共同约定必须保留共同主体。

评测器复用 `@suzu-lives/memory-compactor` 的正式结构化输出解析器，因此字段不完整、枚举无效、证据引用格式错误都会直接成为失败。边界消息会出现在模型输入中，但没有可引用的 `M0001` 编号，不能被当作归档证据。

```js
import {
  createCompactionIngestionExecutor,
  loadIngestionEvaluationCases,
  runMemoryIngestionEvaluation,
} from "@suzu-lives/memory-evaluation";

const loaded = loadIngestionEvaluationCases(ingestionCasesPath);
const report = await runMemoryIngestionEvaluation({
  cases: loaded.cases,
  execute: createCompactionIngestionExecutor({
    systemPrompt,
    generate,
  }),
});
```

仓库测试使用固定构造输出，不消耗API。需要评测真实模型时，调用方显式提供 `generate`，并把包含真实对话的案例与报告保存在已忽略的 `runtime/` 目录。
