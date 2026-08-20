# Mail Bridge

软件拥有的 SMTP 发信和 IMAP 收信通道。稳定入口为 `suzu-lives mail-bridge send`；收件监听由正在运行的 Suzu 管理，命令行仅保留 `receive --preview` 用于检查主题路由。

它只负责投递邮件、接收允许发件人的回信、保存附件并把结果交给 Suzu。收件方可以是快捷指令、另一台设备、服务器脚本或人工邮箱；这些外部自动化都不属于软件本身。运行时从 Suzu Lives 统一软件数据目录读取配置，私密授权码不会展示到 renderer。

收件游标和附件写入 `Suzu Lives/automation/mail-bridge` 数据目录。邮件接收器以本地 stdin/stdout 事件交给 Suzu，再分别排进能力设置中勾选的会话；不会调用远程转发。
