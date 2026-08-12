# 网页自动化

此包提供软件拥有的网页自动化运行逻辑。Agent 的稳定入口为同一棵 `site` 命令：

- `suzu-lives site browser start|check`
- `suzu-lives site list|describe <site>|<site> <action>`

同一份软件拥有的 `site.mjs` 也保留 `node site.mjs <site> <action>` 的命令语义。专用 Chrome 的 CDP 端点仍是 `http://127.0.0.1:9222`，可用原有 `playwright-cli attach --cdp=...` 连接。

Chrome profile、站点诊断、幂等操作日志、媒体缓存及群聊短窗口状态都写入 Suzu Lives 统一的软件数据目录。浏览器 profile 作为网页自动化的内部运行数据保留在 `capabilities/web-browser`，站点设置与诊断位于 `capabilities/site-automation`；运行时不会从项目目录或联系人目录读取配置或状态。

当前只登记 Douyin，且 `registry.json` / manifest 完整保留原有 28 项动作及其适配器内建保护。私信、群聊与媒体理解仍须由用户在软件数据目录下配置已存在的服务；本迁移不会读取、复制或展示旧配置、登录态或凭据。
