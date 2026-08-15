# 最小宿主示例

这个示例只演示最小的完整宿主流程：

1. 写入虚构的用户与 Agent 对话事件；
2. 执行语义整理和 Embedding 整理；
3. 用一条查询召回可注入的记忆上下文。

它不包含聊天模型、Hook、Worker、界面或任何宿主专属会话逻辑。

## 运行

在仓库根目录复制配置模板，然后填写生成模型和 Embedding 模型连接：

```powershell
Copy-Item .\suzu-memory.example.json .\suzu-memory.local.json
```

根据 `providers.generation.apiKeyEnv` 和 `providers.embedding.apiKeyEnv`
设置对应环境变量，再运行：

```powershell
node .\examples\basic-host\basic-host.mjs --config .\suzu-memory.local.json
```

命令会输出事件导入数量、整理状态、结构化记忆数量、召回状态、可注入上下文和检索轨迹 ID。
在同一数据库上重复运行时，四个稳定事件 ID 会被复用，不会重复写入。

也可以换成其他事件流或查询：

```powershell
node .\examples\basic-host\basic-host.mjs `
  --config .\suzu-memory.local.json `
  --events D:\path\to\conversation.jsonl `
  --query "What did the user do on 2026-08-01?"
```

`conversation.jsonl` 只包含虚构演示数据，事件结构遵循
[`docs/companion-event-protocol.md`](../../docs/companion-event-protocol.md)。
