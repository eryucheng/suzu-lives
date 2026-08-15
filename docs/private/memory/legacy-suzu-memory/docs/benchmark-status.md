# 评测

## ZH-4O

| 数据集 | 结果 | 模型 |
| --- | --- | --- |
| MOOM ZH-4O | **86.52%**（924 / 1,068） | DeepSeek V4 Flash + DashScope `text-embedding-v4` |

评测会走完整的记忆写入、维护、检索和多选作答流程。

## 运行

复制示例配置，填入本地 API Key：

```powershell
Copy-Item .\suzu-memory.deepseek-v4-flash.example.json .\suzu-memory.deepseek-v4-flash.local.json
$env:SUZU_MEMORY_GENERATION_API_KEY = "..."
$env:SUZU_MEMORY_EMBEDDING_API_KEY = "..."
```

然后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-zh4o.ps1
```

数据集、临时数据库和报告保存在 `runtime/`。
