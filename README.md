# Suzu Lives

这是我持续完善长期 AI Agent Suzu 的源码公开项目，目标是让 Agent 在长期运行中保持记忆和行为的连续性。

当前发布包括记忆系统、时间感知 Hook、微信消息分条、两种本地查看器、iPhone 快捷指令连接、主动联系、登录态网页浏览、外部模型识图和手机拍照式生图。运行核心为 Claude Code，也可以通过 cc-connect 接入微信。

## 当前可用功能

目前包括：

- 定向压缩 Claude Code JSONL，而不是把整段会话完全替换成官方摘要；摘要结果优先用 JSON Schema 约束，并保留兼容回退、失败重试和原始输出留档；
- 用独立的一次性 LLM 生成第一人称中长期记忆；
- 完整保留最近 24 小时，或在提前压缩时保留末尾约 5k tokens 原文；
- 把退出短期上下文的双方真实对话同步归档到 RAG；
- 支持本地 BM25，以及可选的 OpenAI 兼容 Embedding API；
- 从事件卡片、历史原话或日期汇总中只选择一个小而准确的回忆片段；
- 支持“上周日做了什么”等相对日期查询，没有可靠命中时不强行注入。
- 提供只在本机运行的会话查看器，阅读用户、助手、系统、上下文注入、思考和工具记录，并能从全量搜索结果定位到原始聊天位置；
- 提供记忆查看器，可直接搜索 `history.jsonl`、`events.jsonl`，也能用真实召回链路预览最终注入内容；
- 在每次用户提示前注入电脑当前本地时间，让 Agent 直接感知日期、星期、分钟以及当天的法定节假日或私人纪念日；
- 把长回复拆成微信短消息，并在个人微信单 token 发送额度不足时保存队列、提醒刷新和可靠续发；
- 通过 SMTP、IMAP 和 cc-connect Webhook，让 Agent 请求 iPhone 快捷指令执行操作，并接收手机返回的文字或图片；
- 使用 cc-connect Timer 实现一条可持续的主动联系链，以及针对具体未完成事情的一次性回访；
- 通过微软官方 `playwright-cli` Skill 连接保留登录状态的专用 Chrome，让 Agent 操作登录网站和动态网页。
- 为没有原生视觉能力的主模型提供独立识图通道，按具体问题读取本地图片，并在人物图片被上游误拒时进行一次中性描述重试；
- 提供统一图像生成引擎：日常默认使用云端 Images API，用户明确指定时才调用已注册的本地 ComfyUI 工作流，且不会静默切换后端；
- 让 Agent 在后置摄像头、前置自拍和镜面自拍之间选择，用固定的拍摄几何生成自然的手机随手拍，并可按需组合人物、房间、物品或风格参考图后发进聊天。

各功能保持为独立模块。记忆位于 `memory/`，自动注入类功能位于 `scripts/hooks/`，Agent 可调用能力位于 `scripts/abilities/`，手动使用的本地工具位于 `tools/`，不需要把整套系统作为一个不可拆分脚本使用。

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
- 时间感知需要项目级 `UserPromptSubmit` Hook；
- 微信分条目前只验证 Windows，需要 Python 3.10 或更高版本、cc-connect 1.3.0 或更高版本，以及当前环境可用的 `MessageDisplay` Hook；
- iPhone 快捷指令连接目前只验证 Windows，需要 Python 3.10 或更高版本、支持 SMTP/IMAP 的邮箱和已启用 Webhook 的 cc-connect；
- 登录态网页浏览目前只验证 Windows，需要 Google Chrome、Node.js 和 npm；
- 手机拍照式生图需要 Python 3.10 或更高版本，以及一个 OpenAI Images API 兼容服务；只有使用 `--send` 时才需要 cc-connect；
- 外部模型识图需要 Python 3.10 或更高版本，以及一个支持图片输入的 OpenAI Chat Completions 兼容服务；Pillow 为可选的自动缩放与格式转换依赖；
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
scripts/abilities/connect_iphone/feedback_config.json
scripts/abilities/image-generation/config.local.json
scripts/abilities/image-generation/workflows/registry.local.json
scripts/abilities/image-vision/config.local.json
scripts/abilities/phone-camera/config.local.json
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

## 安装整套 Hook

同时启用时间感知、RAG 和微信分条时，使用[整套安装配置](integrations/README.md)。其中已经正确合并两个 `UserPromptSubmit` 条目和一个 `MessageDisplay` 条目，不需要再从三个模块的文档里分别拼接 Claude Code 配置。

压缩器是手动或定时运行的脚本，会话查看器是本地只读工具，二者不需要注册 Claude Code Hook。

## 只安装 RAG Hook

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

## 时间感知 Hook

时间感知模块在每次 `UserPromptSubmit` 时读取电脑当前本地时间，自动匹配仓库自带的法定节假日，并合并可选且不会被 Git 跟踪的私人纪念日列表，不需要 API 或常驻进程。把它的示例配置追加到项目 `.claude/settings.json` 即可：

- [时间感知安装与原理](scripts/hooks/time-awareness/README.md)

## 会话查看器

会话查看器把 Claude Code JSONL 还原为可读的本地网页，保留上下文附件、思考和工具记录。它首次流式扫描文件，之后只读取新增部分，不会反复加载越来越大的完整 JSONL：

- [会话查看器安装与使用](tools/session-viewer/README.md)

## 记忆查看器

记忆查看器一边提供不会调用 API 的纯文本搜索，一边直接复用当前 RAG 的时间解析、BM25、可选向量和注入阈值，方便检查一段话最终会让 Agent 想起什么：

- [记忆查看器安装与使用](tools/memory-viewer/README.md)

## 微信消息分条

微信分条使用 Claude Code `MessageDisplay` 发送第一段，后台 Worker 续发其余段落；新微信 token 与 cc-connect `message.received` Hook 共同处理发送额度刷新。安装时需要分别合并 Claude Code 和 cc-connect 的 Hook 配置：

- [微信分条安装、额度与故障恢复](scripts/hooks/wechat-splitter/README.md)

## iPhone 快捷指令连接

这个模块通过邮件让 Agent 主动请求 iPhone 快捷指令执行操作，也可以监听手机反馈邮件，再通过 cc-connect Webhook 把正文送回指定 Agent 会话。发送端和接收端共用一份本地配置：

- [iPhone 快捷指令连接安装与使用](scripts/abilities/connect_iphone/README.md)
- [供 Agent 使用的 iphone-bridge Skill](.claude/skills/iphone-bridge/SKILL.md)

## 主动联系与临时回访

`proactive-contact` Skill 让 Agent 在 cc-connect Timer 触发时自行判断是否联系用户，并保证链式主动关心只续接一条；普通对话里出现稍后会有结果的具体事情时，也可以建立一次性回访：

- [proactive-contact Skill](.claude/skills/proactive-contact/SKILL.md)

## 登录态网页浏览

网页浏览模块启动一个只监听本机调试端口、长期保留登录状态的专用 Chrome，再由微软官方 `playwright-cli` Skill 连接。它适合登录网站、动态页面和普通网页读取无法处理的交互：

- [登录态网页浏览安装与使用](scripts/abilities/web-browser/README.md)

## 手机拍照式生图

统一图像引擎把云端 API 和本地 ComfyUI 分成两个后端：默认只使用 API，本地后端必须由用户明确指定并选择已注册工作流。`phone-camera` Skill 在它上面负责判断后摄、前置自拍或镜面自拍，并补全稳定的手机拍摄几何。视觉参考库可以按当前场景组合人物、房间、物品或风格参考：

- [统一图像生成引擎](scripts/abilities/image-generation/README.md)
- [供 Agent 使用的 image-generation Skill](.claude/skills/image-generation/SKILL.md)
- [手机拍照式生图安装与使用](scripts/abilities/phone-camera/README.md)
- [供 Agent 使用的 phone-camera Skill](.claude/skills/phone-camera/SKILL.md)
- [视觉参考库维护 Skill](.claude/skills/visual-reference-manager/SKILL.md)

## 外部模型识图

当 Claude Code 当前使用的主模型不能直接读取图片时，`image-vision` 可以把一张本地图片连同
用户的具体问题送给 OpenAI Chat Completions 兼容视觉模型。它只把模型确认看到的内容作为
观察结果，不会把上下文猜测伪装成图中事实：

- [识图脚本安装与使用](scripts/abilities/image-vision/README.md)
- [供 Agent 使用的 image-vision Skill](.claude/skills/image-vision/SKILL.md)

## 开发状态

- [x] 自定义短期、中期、长期记忆链路
- [x] 双方对话 RAG 与可选 Embedding
- [x] 本地配置隔离、语法检查和自动测试
- [x] 本地增量会话查看器
- [x] 时间感知 Hook
- [x] 微信消息分条与额度续发
- [x] iPhone 快捷指令双向连接
- [x] 主动关心和一次性回访
- [x] 登录态网页自动化适配器
- [x] 手机拍照式生图适配器
- [x] API 默认、本地 ComfyUI 按需启用的统一生图框架
- [x] 可维护的视觉参考库与多图参考生成
- [x] 无视觉主模型的外部识图通道
- [ ] 进一步提高固定人物一致性

## 许可

Copyright © 2026 儿玉诚也。

本仓库使用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)：

- 允许个人学习、研究、实验、自用，以及其他非商业用途；
- 允许在许可规定的非商业范围内修改和分享；
- 禁止将本仓库代码、修改版本或衍生作品用于任何预期的商业应用；
- 任何商业使用都必须事先取得版权所有者的单独书面授权。

本项目属于非商业源码可用项目，不是 OSI 定义下允许商业使用的开源软件。
