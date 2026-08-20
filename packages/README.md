# Shared packages

这里保存 Suzu Lives 软件内部实际运行的通用能力代码。

记忆、自动化、媒体、设备连接、网页操作和计费能力都在这里由 Suzu Lives 自己运行。桌面端与 Suzu Agent Core 调用同一份实现，不需要复制或维护另一套脚本。

每个模块都把运行数据写入 Suzu Lives 的数据目录，并具有自己的测试和升级路径。Agent Core 的 Skill 与 MCP 只描述如何调用软件，不能成为模块代码或设置的第二个存放位置。

当前能力迁移的基础模块：

- `capability-registry`：Agent 可调用能力的中立 `capability` CLI 输入/输出合约；
- `capability-runtime`：所有执行器共用的“已启用 + 已配置 + 依赖可用”调用门禁；
- `media-understanding`：图像与视频理解的受控模型/FFmpeg 执行器；
- `device-bridge`：电脑摄像头 worker；
- `web-browser`：专用浏览器启动与通用网页读写、上传下载执行器；
- `voice-message`：生成 MP3 并通过当前会话附件链交付的受控 TTS 执行器。
- `proactive-contact`：由 Suzu 调度器创建一次性任务、在指定会话中主动联系的软件拥有 Skill。

这些模块不会自行触发模型、设备、浏览器或站点。每项能力只通过当前软件拥有的稳定入口执行：Agent 可调用的媒体能力使用 `suzu-lives capability …`，浏览器、邮箱通道和自动化能力使用各自的专用命令；桌面端统一管理配置、联系人范围和实际可用状态。
