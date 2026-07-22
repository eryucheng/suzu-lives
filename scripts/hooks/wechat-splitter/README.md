# 微信分条

把 Claude Code 的一段长回复拆成更接近微信聊天习惯的多条消息。

## 工作方式

```text
Claude 生成回复
    ↓
MessageDisplay Hook
    ├─ 第一段：立即作为 displayContent 返回
    └─ 剩余段：写入本地持久队列
                    ↓
              后台 Worker 逐条调用 cc-connect send

微信消息到达
    ↓
context_tokens.json 出现新 token
    ├─ 活跃 Worker 在下一次发送前立即开启新额度
    └─ 稍后的 message.received Hook 确认同一 token
                                  ↓
                         必要时唤醒旧队列
```

第一段先走 Claude Code 原生显示通道，Hook 随即结束。后台发送剩余段落时，用户可以继续发消息，不必等待上一轮的同步发送脚本退出。

用户在回复中途插话时，刚到达的微信消息立即刷新发送额度。旧回复未发送的内容仍排在前面；Agent 针对插话生成的新回复追加到队尾，等旧回复说完后再发送。

脚本按以下顺序分段：

1. 回复中有空行时，按空行分段；
2. 没有空行时，按普通换行分段；
3. 空段自动丢弃，正文和标点保持原样。

脚本不会生成空的 `displayContent`。精确的 `NO_REPLY` 会保持为 `NO_REPLY`。某一轮刷新提醒已经发出或被 Worker 预定后，新生成的回复只追加到队列，`displayContent` 返回 `NO_REPLY`，不会重复提醒。

## 环境要求

- 当前版本只在 Windows 环境验证；记忆、时间感知和会话查看器的跨平台支持不代表本模块已验证 macOS/Linux 后台续发；
- Python 3.10 或更高版本；
- cc-connect 1.3.0 或更高版本（需要 `message.received` 生命周期 Hook）；
- 已完成微信个人号配置；
- 微信用户至少主动发过一条消息，使 cc-connect 生成 `context_tokens.json`；
- Claude Code 环境能够触发 `MessageDisplay` Hook。

本模块以 Claude Code 2.1.175 与 cc-connect 微信个人号通道的实际运行行为为基线。`MessageDisplay` 当前没有出现在 Claude Code 公开 Hook 参考的事件列表中，因此升级 Claude Code 后应先运行下文的检查并做一次人工分段测试。

## 配置

一般情况下不需要填写微信 ID。只有一个微信会话时，脚本会从 cc-connect 的 `context_tokens.json` 自动识别接收方。

需要自定义时，把 `config.example.json` 复制为同目录的 `config.json`：

```json
{
  "totalBudget": 10,
  "reservedMessages": 2,
  "refreshMessage": "你咋一直不说话",
  "displayDelayMs": 0,
  "sendIntervalMs": 120,
  "tokenPollMs": 300,
  "sendTimeoutSeconds": 20,
  "maxLogBytes": 1048576,
  "ccConnectProject": "",
  "peer": "",
  "contextTokensPath": "",
  "ccConnectCommand": "cc-connect"
}
```

- `totalBudget`：按一枚 `context_token` 最多可用 10 次计算；
- `reservedMessages`：默认保留 2 次发送机会；
- `displayDelayMs`：第一段 display 后，后台开始发送前的等待时间；
- `sendIntervalMs`：后台两次成功发送之间的最小间隔；
- `tokenPollMs`：有待发送队列时检查新微信 token 的间隔；
- `ccConnectProject`：同时运行多个 cc-connect 项目时填写当前项目的 `name`，单项目可留空；
- `peer`：多微信会话时填写目标会话 ID，单会话留空；
- `contextTokensPath`：无法自动发现时填写 `context_tokens.json` 的绝对路径；
- `ccConnectCommand`：无法从 PATH 找到时填写 cc-connect 可执行文件的绝对路径。

## 安装两个 Hook

如果还要同时启用时间感知和 RAG，可以先使用仓库的[整套 Claude Code 配置](../../../integrations/README.md)，再按本节第二步合并 cc-connect Hook。以下配置仍可用于单独安装微信分条。

### 1. Claude Code 的 MessageDisplay Hook

把 `settings.example.json` 中的 `MessageDisplay` 配置合并到项目的：

```text
项目目录/.claude/settings.json
```

推荐使用 `${CLAUDE_PROJECT_DIR}`，避免把某一台电脑的用户名和项目绝对路径写进配置。系统级 `~/.claude/settings.json` 不需要添加微信分条 Hook。

### 2. cc-connect 的 message.received Hook

把 `cc-connect-hook.example.toml` 中的顶层 `[[hooks]]` 配置合并到：

```text
~/.cc-connect/config.toml
```

将其中的 `<PROJECT_DIR>` 换成 Agent 项目的绝对路径。Windows 示例：

```toml
[[hooks]]
event = "message.received"
type = "command"
command = 'python "C:/Users/yourname/path/to/agent-project/scripts/hooks/wechat-splitter/md_send.py" --inbound'
async = false
timeout = 5
```

这里必须使用 `async = false`。Hook 用来确认入站事件并在后台 Worker 已退出时唤醒队列；如果消息先在 cc-connect 内部排队，活跃 Worker 会更早通过新 token 开启额度。两条路径使用 token 哈希去重，不会把同一条入站消息重置两次。该命令不调用 Agent 或 LLM，只更新本模块 `runtime/` 下的状态文件。

合并后运行：

```powershell
python .\scripts\hooks\wechat-splitter\md_send.py --check
```

正常结果中以下三项应为 `true`：

```json
{
  "ccConnectFound": true,
  "contextTokenFound": true,
  "peerResolved": true
}
```

然后重启对应的 Claude Code / cc-connect Agent 会话，使项目级 Hook 配置生效。

重启 cc-connect 后，从微信发送一条消息，再运行 `--status`。`lastInboundAt` 应大于 `0`，表示入站 Hook 已经生效。

## 发送额度与刷新

脚本本地记录当前入站消息之后已使用的发送次数。余额大于保留量时继续发送；触及保留量后发送刷新提醒并暂停队列。

微信平台先写入新的 `context_token`，排队消息稍后才可能进入 `message.received` 生命周期。为避免旧队列在这段时间误判额度，活跃 Worker 会在每次发送前检查 token 哈希：新哈希立即开启一轮额度；稍后的 `message.received` 只确认同一哈希，不会再次清零计数。

普通插话同样会刷新额度，也会正常生成新回复。例如旧回复发送到第 4 段时用户插话，系统先用新额度继续发送旧回复的剩余段落；剩余额度足够时再发送针对插话的新回复，不足时把新回复留在队列，等用户刷新后继续。所有实际发出的内容都计入对应 token 的额度。

只有系统已经发出刷新提醒时，才建议用户回复“刷新”。Agent 按项目约定只回复精确的 `NO_REPLY`，新 token 与入站 Hook 会共同恢复队列。等待期间不会留下一个永久轮询 token 文件的后台进程。

建议在 `CLAUDE.md` 中写明：

```md
当用户发送的完整内容恰好为“刷新”时，只回复 `NO_REPLY`，不要解释或添加其他文字。
```

## 队列状态与故障恢复

查看状态：

```powershell
python .\scripts\hooks\wechat-splitter\md_send.py --status
```

普通发送错误只尝试一次，随后暂停并保留未发送内容，不会每隔几百毫秒无限重试。修正 cc-connect 路径或其他环境问题后运行：

```powershell
python .\scripts\hooks\wechat-splitter\md_send.py --resume
```

运行状态和日志保存在：

```text
scripts/hooks/wechat-splitter/runtime/message_sender/
```

日志超过 1 MiB 后只保留一份轮换文件。`runtime/` 和本机 `config.json` 已由模块内的 `.gitignore` 排除。

## 旧版 `send_lines.py`

`send_lines.py` 属于早期“让 Agent 主动调用脚本发送全部消息”的机制。当前 Hook 不依赖它，也不需要把它复制到本模块。

## 参考

- [Claude Code Hooks 参考](https://code.claude.com/docs/zh-CN/hooks)
- [cc-connect 使用指南](https://github.com/chenhg5/cc-connect/blob/main/docs/usage.zh-CN.md)
- [cc-connect 微信个人号说明](https://github.com/chenhg5/cc-connect/blob/main/docs/weixin.md)
