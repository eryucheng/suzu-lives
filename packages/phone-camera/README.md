# 手机拍照式生图

软件拥有的 Agent 调用核心，保留 rear、selfie、mirror 三种拍摄规则、参考 asset/set 展开、dry-run、明确后端与结构化结果。图片和运行记录只写入当前 Agent 的 Suzu Lives 数据目录。

稳定薄入口：`suzu-lives phone-camera --shot rear --scene "..." --dry-run`。入口需要用 `SUZU_LIVES_DATA_ROOT` 与 `SUZU_LIVES_AGENT_ID`（或 `--data-root` / `--agent-id`）定位软件数据。

视觉参考必须明确归属：重复使用 `--ref shared:<asset-or-set-id>` 读取用户共享资料，或 `--ref contact:<asset-or-set-id>` 读取当前联系人的专属资料。不得使用未带归属的参考 ID，也不能读取其他联系人的专属资料。

API 由“设置 → API”中为“生图”选择的连接提供；地址、Key、模型和协议都由该连接统一管理，Electron 加密保存的 Key 不会暴露给命令行。生成后的图片通过当前 Suzu 会话的附件交付命令发送：它会保存在会话缓存中，并在该会话已绑定微信时自动发送。
