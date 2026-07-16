# 定向压缩器

这个工具为 Claude Code 的同一个长期会话建立新的逻辑上下文：旧内容由第一人称摘要承接，切点后的近期原文保持完整。它同时把退出短期范围的双方原文归档到 RAG，并生成可按事件检索的记忆卡片。

它不会删除或缩小主会话 JSONL。脚本只在文件末尾追加 Claude Code 能识别的 compact 边界和摘要，因此物理文件与 `backups/` 会继续增长，但下一轮模型使用的是新的逻辑上下文，不再把旧链全部作为 live context。

## 配置

正式配置是本目录下的 `config.local.json`。首次安装时，可以在完整仓库根目录运行 `npm run setup`，也可以手动把 `config.example.json` 复制为 `config.local.json`。

至少确认三项：

```json
{
  "transcriptPath": "C:/Users/你的用户名/.claude/projects/项目目录/会话ID.jsonl",
  "memoryOwner": "Agent 的名字",
  "userName": "用户的名字"
}
```

- `transcriptPath` 必须指向持续聊天的主会话 JSONL；
- `memoryOwner` 是摘要中“我”的身份；
- `userName` 是摘要中对方的称呼。

相对路径以本目录为基准。配置选择顺序为：`--config`、环境变量 `MEMORY_COMPACTOR_CONFIG`、`config.local.json`、`config.example.json`。

## 两条处理规则

1. 距离上次 compact 至少 24 小时：在当前时间往前 24 小时的位置切分，最近 24 小时原文完整保留；
2. 24 小时内已经 compact 过：只有当前有效上下文超过 15k tokens 才处理，并从末尾向前保留约 5k tokens 原文。

没有满足条件时会返回 `status: "skipped"`，这是正常结果。切点会落在完整用户消息的边界，不会截断单条消息。`boundaryContextMessages` 只让摘要 LLM 查看切点后的少量衔接内容，用于识别切点处尚未完成的事情；这些衔接内容本身不会被提前写进摘要或事件。

## 一次执行会做什么

```text
重建当前逻辑上下文
  → 按两条规则选择切点
  → 标准化即将退出短期范围的双方原文
  → 一次性 LLM 生成更新后的第一人称摘要和事件候选
  → 备份主 JSONL
  → 追加 compact 边界与摘要
  → 原文去重写入 history.jsonl
  → 事件校验后写入 events.jsonl
  → 启用 Embedding 时补齐 embeddings.jsonl
```

事件候选必须引用本批真实原文，代码会校验来源编号、字段、日期和长度。事件层失败不会破坏已经完成的摘要和原文归档；Embedding 失败会退回 BM25。主 JSONL 或历史库发生并发变化时，脚本会拒绝覆盖或自动回滚。

## 运行

从 Agent 项目根目录执行：

```powershell
# 只看计划，不调用 LLM、不写主会话
node .\memory\manual_compactor\compact-jsonl.mjs --dry-run

# 正式处理
node .\memory\manual_compactor\compact-jsonl.mjs
```

也可以双击本目录的 `run.cmd` 正式运行。首次换机或修改配置后，先运行一次 `--dry-run`。

日常可以让 cc-connect cron 在每天固定时间用 `exec` 直接运行正式命令。它不会向主 Agent 发送一轮对话；未满足规则时脚本自行跳过，满足规则时只启动独立的一次性摘要 LLM。定时执行时应选通常不聊天的时段，避免主 JSONL 正在写入。

## 一次性摘要 LLM

默认命令等价于：

```text
claude -p --bare --tools "" --max-turns 1 --no-session-persistence --output-format json
```

它不 resume 主会话、不保留自己的会话、不能调用工具。LLM 只生成严格 JSON 中的 `summary` 和 `events`；UUID、父链、compact 包装、校验和写入都由代码完成。默认从 `~/.claude/settings.json` 继承 `env`，`llmEnv` 可以覆盖继承值。

## 运行产物

- `backups/`：每次正式写入前的完整主 JSONL 备份；
- `work/latest-summary.md`：最近一次摘要正文，供人工检查；
- `work/last-run.json`：最近一次执行或跳过报告；
- `../rag/history.jsonl`：退出短期范围的标准化双方原文；
- `../rag/events.jsonl`：有真实来源和事件日期的事件记忆；
- `../rag/embeddings.jsonl`：可删除重建的向量索引。

## 调试参数

```powershell
# 临时指定主会话
node .\memory\manual_compactor\compact-jsonl.mjs --transcript=C:/完整路径/会话.jsonl --dry-run

# 固定当前时间，验证切点
node .\memory\manual_compactor\compact-jsonl.mjs --now=2026-07-16T12:00:00+08:00 --dry-run

# 使用准备好的摘要正文测试写入；此模式不生成新的事件候选
node .\memory\manual_compactor\compact-jsonl.mjs --summary-file=memory/manual_compactor/work/my-summary.txt
```
