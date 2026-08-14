---
name: iphone-bridge
description: 通过用户已配置并测试的 iPhone 邮件快捷指令发送请求；反馈由正在运行的 Suzu 直接接收。
---

# iPhone Bridge

只使用已经登记的 iPhone 操作：`闹钟`（正文 `HH:MM 名称`）和 `查岗`（正文留空）。未知主题不是已配置能力，不要发送。

稳定软件入口：

`suzu-lives iphone-bridge send '闹钟' '08:30 起床'`

`suzu-lives iphone-bridge send '查岗' ''`

`已发送` 只表示请求邮件交给邮箱服务器，不代表手机完成。发送后等待正在运行的 Suzu 反馈接收器；不要重复发送、不要编造手机状态。收到图片路径后，使用现有图像理解能力。

反馈监听由 Suzu 软件启动，并直接排入能力设置中勾选的一个或多个会话。不要从 Claude 终端执行或停止监听；命令行只可预览主题映射：

`suzu-lives iphone-bridge receive --preview '<主题>' '<内容>'`

软件代码、配置、反馈状态和附件目录都在 Suzu Lives 统一软件数据根；运行时不会使用远程转发，也不会把私密内容展示到界面。
