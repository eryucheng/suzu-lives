# Shared packages

这里保存 Suzu Lives 软件内部实际运行的通用能力代码。

记忆、自动化、媒体、设备连接、网页操作和计费能力都在这里由 Suzu Lives 自己运行。桌面端与 Suzu Agent Core 调用同一份实现，不需要复制或维护另一套脚本。

每个模块都把运行数据写入 Suzu Lives 的数据目录，并具有自己的测试和升级路径。Agent Core 的 Skill 与 MCP 只描述如何调用软件，不能成为模块代码或设置的第二个存放位置。

当前能力迁移的基础模块：

- `capability-runtime`：所有执行器共用的“已启用 + 已配置 + 依赖可用”调用门禁；
- `media-understanding`：图像与视频理解的受控模型/FFmpeg 执行器；
- `web-browser`：专用浏览器启动与通用网页读写、上传下载执行器；
- `voice-message`：生成 MP3 并通过当前会话附件链交付的受控 TTS 执行器。

这些模块不会自行触发模型、设备、浏览器或站点。Agent Core 从桌面端注册表取得当前联系人可用的产品 Skill，按需加载动作说明后通过 `suzu_capability` 回到同一套产品适配器执行；桌面端统一管理配置、联系人范围和实际可用状态。
