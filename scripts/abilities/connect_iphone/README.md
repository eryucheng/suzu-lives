# iPhone 快捷指令连接

这个模块通过电子邮件和 cc-connect Webhook，让 Agent 与 iPhone 快捷指令双向通信：

```text
Agent
  └─ send_to_iphone.py → SMTP 邮件 → iPhone 快捷指令

iPhone 快捷指令
  └─ 反馈邮件 → receive_from_iphone.py → cc-connect Webhook → Agent 会话
```

发送端和接收端共用一份本地配置。脚本只使用 Python 标准库，不需要安装第三方依赖。

## 环境要求

- Windows；
- Python 3.10 或更高版本；
- 一个已经开启 SMTP 和 IMAP 的邮箱；
- 已启用 Webhook 的 cc-connect；
- 能够收发指定主题邮件的 iPhone 快捷指令。

## 创建本地配置

在仓库根目录运行：

```powershell
npm run setup
```

也可以手动复制 `feedback_config.example.json`，并将副本命名为 `feedback_config.json`。真实配置和运行状态已经被 `.gitignore` 排除，不会进入 Git。

在 `mail` 中填写：

- `imapHost`、`imapPort`：接收反馈邮件使用的 IMAP SSL 地址和端口；
- `smtpHost`、`smtpPort`：发送快捷指令邮件使用的 SMTP SSL 地址和端口；
- `username`：邮箱账号；
- `password`：邮箱客户端授权码，不是网页登录密码；
- `allowedSenders`：允许触发 Agent 的发件地址；
- `commandRecipient`：Agent 发出的快捷指令邮件收件地址。

也可以不填写 `password`，改在 `passwordEnv` 中填写保存授权码的环境变量名称。

163 邮箱需要在网页版开启 SMTP 和 IMAP，并生成客户端授权码。接收脚本会在登录后发送网易要求的 IMAP ID，再重新读取服务器能力。

在 `webhook` 中填写：

- `url`：cc-connect Webhook 地址；
- `token`：与 cc-connect `[webhook]` 配置一致的 Token；
- `project`：目标项目名称；
- `sessionKey`：目标会话的完整 `session_key`；
- `silent`：是否隐藏 Webhook 到达提示；
- `deliveryDelaySeconds`：收到反馈后等待多久再交给 Webhook。Agent 自己发起手机操作时，延迟可以避开仍被当前对话占用的会话，默认 10 秒。

## Agent 主动操作 iPhone

主题和正文由你自己的快捷指令决定。例如：

```powershell
python ".\scripts\abilities\connect_iphone\send_to_iphone.py" "闹钟" "08:30 起床"
python ".\scripts\abilities\connect_iphone\send_to_iphone.py" "查岗" ""
```

发送失败时脚本返回非零退出码；只有输出“已发送”才表示邮件已经交给邮箱服务器。

供 Agent 阅读的简短操作规范见 [AGENT_USAGE.md](AGENT_USAGE.md)。

## 手机反馈进入 Agent

`routes` 根据邮件主题选择提示词模板。默认示例为：

```json
{
  "enabled": true,
  "subject": "反馈",
  "promptTemplate": "{{content}}"
}
```

这表示主题为“反馈”时，手机邮件正文会原样送入 Agent。比如正文是：

```text
他现在在上海科技馆
```

Agent 收到的也是同一句话。

模板还支持：

- `{{content}}`：邮件正文；
- `{{subject}}`：邮件主题；
- `{{from}}`：发件地址；
- `{{receivedAt}}`：邮件时间。

主题采用精确匹配。没有配置的主题，以及不在 `allowedSenders` 中的发件人，都会被忽略。

## 启动反馈监听器

双击：

```text
run_feedback_listener.cmd
```

第一次启动会把邮箱当前最新 UID 写入 `feedback_state.json`，旧邮件不会进入 Agent。之后收到的新邮件会继续处理；脚本关闭期间到达的邮件会在下次启动时补上。

服务器支持标准 IMAP IDLE 时，脚本会等待新邮件通知；不支持时，按 `fallbackPollSeconds` 的间隔检查。连接失效后会自动重连。

关闭终端窗口或按 `Ctrl+C` 即可停止。

## 重新建立邮件基线

如果需要忽略当前已有邮件、从下一封新邮件开始：

```powershell
python ".\scripts\abilities\connect_iphone\receive_from_iphone.py" --reset
```
