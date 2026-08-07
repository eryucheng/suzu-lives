# 手机拍照式生图

软件拥有的 Agent 调用核心，保留 rear、selfie、mirror 三种拍摄规则、参考 asset/set 展开、dry-run、明确后端与结构化结果。图片和运行记录只写入当前 Agent 的 Suzu Lives 数据目录。

稳定薄入口：`suzu-lives phone-camera --shot rear --scene "..." --dry-run`。入口需要用 `SUZU_LIVES_DATA_ROOT` 与 `SUZU_LIVES_AGENT_ID`（或 `--data-root` / `--agent-id`）定位软件数据。

API 使用软件保存的阿里百炼连接（或 `DASHSCOPE_API_KEY` 环境覆盖）；Electron 已加密保存的 Key 不会暴露给命令行。无参考图使用 `z-image-turbo`，带参考图使用 `wan2.7-image`。生成后的图片通过当前 Suzu 会话的附件交付命令发送：它会保存在会话缓存中，并在该会话已绑定微信时自动发送。
