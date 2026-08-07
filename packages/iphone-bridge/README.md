# iPhone Bridge

软件拥有的 iPhone 邮件请求和反馈监听代码。稳定入口为 `suzu-lives iphone-bridge send`；反馈监听由正在运行的 Suzu 管理，命令行仅保留 `receive --preview` 用于检查主题映射。

它使用已配置 iPhone 快捷指令的 SMTP/IMAP 调用与参数。运行时从当前 Agent 的 Suzu Lives 数据目录读取软件配置；软件不把私密内容展示到 renderer。

反馈 state 和附件写入当前 Agent 的 `Suzu Lives/agents/<agentId>/iphone-bridge` 数据目录。邮件接收器以本地 stdin/stdout 事件交给 Suzu，再分别排进能力设置中勾选的会话；不会调用远程转发。
