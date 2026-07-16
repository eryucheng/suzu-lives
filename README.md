# Suzu Lives

这是我持续完善长期 AI Agent Suzu 的源码公开项目，目标是让 Agent 在长期运行中保持记忆和行为的连续性。

当前先发布已经完成并验证的记忆系统，运行核心为 Claude Code，也可以通过 cc-connect 接入微信。

## 当前可用功能

目前包括：

- 定向压缩 Claude Code JSONL，而不是把整段会话完全替换成官方摘要；
- 用独立的一次性 LLM 生成第一人称中长期记忆；
- 完整保留最近 24 小时，或在提前压缩时保留末尾约 5k tokens 原文；
- 把退出短期上下文的双方真实对话同步归档到 RAG；
- 支持本地 BM25，以及可选的 OpenAI 兼容 Embedding API；
- 从事件卡片、历史原话或日期汇总中只选择一个小而准确的回忆片段；
- 支持“上周日做了什么”等相对日期查询，没有可靠命中时不强行注入。

微信消息分条、时间感知和主动关心将在后续模块中加入。它们不会和记忆代码混在一个不可拆分的脚本里。

## 记忆结构

```text
当前上下文
├─ 第一人称中长期摘要
├─ 最近一段完整原始对话
└─ 当前消息需要时注入的一段事件、原话或日期记忆
```

详细设计见 [记忆架构](docs/memory-architecture.md)。

## 环境要求

- Windows、macOS 或 Linux；
- Node.js 18 或更高版本；
- Claude Code 命令行可以运行 `claude`；
- 使用 Hook 时，需要支持 `UserPromptSubmit` 的 Claude Code；
- Embedding 可选，不配置时使用本地 BM25。

本模块没有 npm 运行依赖，不需要执行 `npm install`。

## 快速开始

先生成不会被 Git 跟踪的本地配置：

```powershell
npm run setup
```

如果 PowerShell 的执行策略阻止 `npm.ps1`，把命令中的 `npm` 换成 `npm.cmd`。

然后编辑：

```text
memory/manual_compactor/config.local.json
memory/rag/config.local.json
```

至少需要在压缩器配置中填写：

- `transcriptPath`：目标 Claude Code 会话 JSONL 的完整路径；
- `memoryOwner`：以第一人称拥有记忆的 Agent 名字；
- `userName`：对方的名字。

先运行检查和测试：

```powershell
npm run check
npm test
```

首次使用必须先在停止写入的会话副本上预览：

```powershell
node .\memory\manual_compactor\compact-jsonl.mjs --dry-run
```

确认切点无误后，再正式运行：

```powershell
node .\memory\manual_compactor\compact-jsonl.mjs
```

压缩器会先备份，再写入自定义 compact，并把同一批历史原文送入 RAG。详细操作见：

- [手动定向压缩器](memory/manual_compactor/README.md)
- [历史原文 RAG](memory/rag/README.md)

## 安装 RAG Hook

把下面的处理器追加到 Agent 项目的 `.claude/settings.json`，不要覆盖已有 Hook：

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

Hook 失败时会安静跳过，不会阻断正常聊天。

## 开发状态

- [x] 自定义短期、中期、长期记忆链路
- [x] 双方对话 RAG 与可选 Embedding
- [x] 本地配置隔离、语法检查和自动测试
- [ ] 时间感知 Hook
- [ ] 微信消息分条与额度续发
- [ ] 主动关心和定时任务
- [ ] 视觉、画图、摄像头与网页自动化适配器

## 许可

Copyright © 2026 儿玉诚也。

本仓库使用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)：

- 允许个人学习、研究、实验、自用，以及其他非商业用途；
- 允许在许可规定的非商业范围内修改和分享；
- 禁止将本仓库代码、修改版本或衍生作品用于任何预期的商业应用；
- 任何商业使用都必须事先取得版权所有者的单独书面授权。

本项目属于非商业源码可用项目，不是 OSI 定义下允许商业使用的开源软件。
