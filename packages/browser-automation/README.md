# Web Browser 与站点自动化

此包提供软件拥有的 `web-browser` 和 `site-automation` 运行逻辑。Agent 的稳定入口为：

- `suzu-lives web-browser [--check]`
- `suzu-lives site list|describe <site>|<site> <action>`

同一份软件拥有的 `site.mjs` 也保留 `node site.mjs <site> <action>` 的命令语义。专用 Chrome 的 CDP 端点仍是 `http://127.0.0.1:9222`，可用原有 `playwright-cli attach --cdp=...` 连接。

Chrome profile、站点诊断、幂等操作日志、媒体缓存及群聊短窗口状态都写入当前 Agent 的 Suzu Lives 数据目录，默认位于 `agents/<agentId>/web-browser` 与 `agents/<agentId>/site-automation`。运行时不会从项目目录读取配置或状态。

当前只登记 Douyin，且 `registry.json` / manifest 完整保留原有 28 项动作及其适配器内建保护。私信、群聊与媒体理解仍须由用户在软件数据目录下配置已存在的服务；本迁移不会读取、复制或展示旧配置、登录态或凭据。
