# 记忆模块

这个 `memory` 文件夹可以整体放到 Agent 项目根目录。它把同一个 Claude Code 长期会话组织成：

```text
每轮稳定上下文
├─ 第一人称中长期摘要
├─ 最近 24 小时完整原文，或紧急处理时末尾约 5k tokens 原文
└─ 当前问题确实需要时，临时注入的一段历史依据
```

主会话 JSONL、历史原文库和备份可以持续保存；它们的物理大小不等于每轮输入模型的 live context 大小。

## 两个子模块

- [`manual_compactor`](manual_compactor/README.md)：选择切点、调用一次性 LLM、写入第一人称摘要，并把退出短期范围的内容交给 RAG；
- [`rag`](rag/README.md)：保存双方历史原文与事件卡片，在当前消息需要时召回一个小而准确的片段。

RAG 只提供证据。主 Agent 仍负责理解关系、判断玩笑与现实、处理冲突、组织自然回答以及调用提醒或其他工具。

## 整包替换到另一台电脑

1. 暂停另一台电脑上的 cc-connect 和正在使用该项目的 Claude Code，避免替换时 Hook 或压缩器同时读写；
2. 把原来的 `memory` 文件夹改名留作临时备份；
3. 把新的整个 `memory` 文件夹复制到 Agent 项目根目录，最终路径应是 `项目目录\memory`；
4. 打开 `manual_compactor/config.local.json`，确认 `transcriptPath`、`memoryOwner`、`userName`；
5. 打开 `rag/config.local.json`，确认 Embedding 的开关、服务地址、模型、维度和 API Key；
6. 如果 `.claude/settings.json` 已经指向 `${CLAUDE_PROJECT_DIR}/memory/rag/hook.mjs`，Hook 不需要修改；原有 cc-connect cron 也不需要修改，只要运行路径仍是项目下的同一脚本；
7. 在项目根目录完成下面的只读验证，再重启 cc-connect。

```powershell
# RAG 本地日期查询验证；纯日期查询不会调用 Embedding API
node .\memory\rag\retrieve.mjs --json "2026年7月12日做了什么"

# 压缩计划验证；不会调用摘要 LLM，也不会写主会话
node .\memory\manual_compactor\compact-jsonl.mjs --dry-run
```

确认聊天、Hook 和定时压缩正常后，再自行删除改名保留的旧 `memory`。不要只复制 `.mjs`：`history.jsonl`、`events.jsonl`、`embeddings.jsonl` 和两份 `config.local.json` 也是当前这套记忆的组成部分。

## 日常使用

- RAG Hook 在每条用户消息提交时自动判断是否需要回忆；
- 压缩器可以手动运行，也可以由 cc-connect cron 每天固定时间用 `exec` 运行；
- 不满足 24 小时／15k token 规则时，压缩器会正常跳过；
- 最新摘要看 `manual_compactor/work/latest-summary.md`；
- 最近执行结果看 `manual_compactor/work/last-run.json`；
- 每次正式 compact 前的主会话备份在 `manual_compactor/backups/`。
