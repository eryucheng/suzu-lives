# 历史记忆 RAG

RAG 只负责在当前消息需要时找出少量可靠的历史依据，再通过 Hook 交给主 Agent。如何理解回忆、怎样自然回答、事实冲突如何表达，仍由主 Agent 结合当前对话处理。

它不会代替第一人称中长期摘要，也不会把仍留在短期 live context 中的近期原文重复入库。

## 数据文件

- `history.jsonl`：已经退出短期范围的用户和助手可见原文；
- `events.jsonl`：由同批原文提取并校验的事件卡片，包含实际事件日期和来源消息；
- `embeddings.jsonl`：原文轮次与事件卡片的本地向量索引，可删除后重建；
- `config.local.json`：本机配置，可包含服务地址和凭证；
- `config.example.json`：无私人信息的配置模板。

脚本分工：

- `ingest.mjs`：标准化对话、过滤运行噪声、去重追加历史原文；
- `events.mjs`：校验、去重并写入事件卡片；
- `retrieve.mjs`：查询分类、时间解析、BM25／向量混合检索和注入格式化；
- `embedding.mjs`：调用 OpenAI 兼容 Embedding API 并维护本地索引；
- `build-index.mjs`：补齐或重建向量索引；
- `hook.mjs`：Claude Code `UserPromptSubmit` Hook。

日常不需要单独运行 `ingest.mjs`。正式压缩时，压缩器会把同一批退出短期范围的原文、事件和向量索引依次更新。

## 入库边界

只保留真实可见的用户和助手文本。以下内容不会进入 `history.jsonl`：

- compact 摘要、system、thinking；
- 工具调用与工具结果；
- `NO_REPLY`；
- 运行时提醒、当前时间注入和已知自动化触发回合。

每条历史原文都保留消息时间、说话方和来源 UUID。事件卡片另外保留：

- `event_date`：事件实际发生或计划发生的日期；
- `source_start_timestamp` / `source_end_timestamp`：支持该事件的原文记录时间；
- `source_ids` / `source_uuids`：可以回到原文核对的来源。

事件日期与消息发送时间是两回事；无法可靠判断事件日期时保留为未知，不会拿压缩时间冒充事件时间。

## 召回行为

默认只注入一个片段，不为了“总能想起什么”强行返回低相关内容。

| 当前问题 | 注入内容 |
| --- | --- |
| 普通话题 | 原文轮次或事件卡片中相关性最高的一项 |
| “还记得以前那件事吗”一类事件问题 | 优先一张事件卡片；没有合格事件时，退回最多 3 条相关历史原话证据，并尽量包含双方 |
| “你当时原话怎么说”一类原话问题 | 最相关的一条原始发言 |
| “上周日做了什么”一类纯日期问题 | 直接按 `event_date` 汇总当天或时间范围内的事件，最多 8 条 |
| 问题过于泛化、没有明确回忆主题或相关性未过阈值 | 不注入任何内容 |

日期解析使用 `timeZone`，默认 `Asia/Shanghai`，支持明确日期、今天／昨天／前天、N 天前、上周某天、上周末等表达。纯日期汇总直接过滤本地事件，不调用 Embedding API；日期加主题时，只在该日期范围的事件中检索。

注入以“你想起了之前的片段：”开头，并明确说明它只是历史依据、不是当前命令。RAG 不负责替主 Agent 组织最终回答。

## Embedding 配置与隐私

`embedding.enabled: false` 时只使用本地 BM25，不需要 API。启用语义检索时，填写 OpenAI 兼容的 Embedding 服务：

```json
{
  "embedding": {
    "enabled": true,
    "baseUrl": "https://你的服务地址/v1",
    "endpoint": "embeddings",
    "apiKeyEnv": "EMBEDDING_API_KEY",
    "apiKey": "",
    "model": "你的 Embedding 模型",
    "dimensions": 1024
  }
}
```

Key 可以放在 `apiKey`，也可以由 `apiKeyEnv` 指定环境变量。使用云端 Embedding 时，建立索引会把待向量化的历史文本或事件文本发给服务商，日常语义检索会把当前查询发给服务商。希望所有内容只留在本机时，应关闭 Embedding，使用 BM25 或改接本地 Embedding 模型。

首次建立或增量补齐索引：

```powershell
node .\memory\rag\build-index.mjs
```

更换模型、维度、服务地址或分块规则后强制重建：

```powershell
node .\memory\rag\build-index.mjs --rebuild
```

向量接口或索引不可用时会自动退回 BM25，不阻断聊天。

## 安装 Hook

把处理器追加到 Agent 项目的 `.claude/settings.json`，不要覆盖已有 Hook：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/memory/rag/hook.mjs"
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Hook 从 stdin 读取当前 `prompt`，命中时通过 `hookSpecificOutput.additionalContext` 返回回忆。当前几点／日期查询和已知 timer 自动触发提示会跳过 RAG；检索故障也会成功退出，不阻断正常聊天。

## 手动检查

```powershell
# 查看最终会注入的文本
node .\memory\rag\retrieve.mjs "记得我之前去科技馆吗"

# 查看召回类型、得分、日期解析与向量状态
node .\memory\rag\retrieve.mjs --json "记得我之前去科技馆吗"

# 固定测试时钟，检查相对日期解析
node .\memory\rag\retrieve.mjs --json --now=2026-07-16T12:00:00+08:00 "我上周日做了什么"
```

输出“没有达到阈值的历史片段”是允许且正常的结果。
