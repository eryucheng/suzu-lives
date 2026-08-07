# Shared packages

这里保存 Suzu Lives 软件内部实际运行的通用能力代码。

记忆、自动化、媒体、设备连接、网页操作和计费能力都在这里由 Suzu Lives 自己运行。桌面端与 Claude 接入层调用同一份实现，不需要复制或维护另一套脚本。

每个模块都把运行数据写入 Suzu Lives 的数据目录，并具有自己的测试和升级路径。Claude 项目中的 `CLAUDE.md` 和 `SKILL.md` 只登记如何调用软件，不能成为模块代码或设置的第二个存放位置。

当前能力迁移的基础模块：

- `capability-registry`：软件拥有的能力清单、依赖与真实状态判定；
- `claude-integration`：经用户明确操作后生成轻量 Claude 注册文件和稳定 CLI 合约；
- `capability-runtime`：所有执行器共用的“已启用 + 已配置 + 依赖可用”调用门禁；
- `media-understanding`：图像与视频理解的受控模型/FFmpeg 执行器；
- `device-bridge`：电脑摄像头 worker 和 iPhone HTTP bridge 执行器；
- `browser-automation`：专用浏览器启动和显式允许的只读站点执行器；
- `voice-message`：生成 MP3 并通过当前会话附件链交付的受控 TTS 执行器。
- `proactive-contact`：由 Suzu 调度器创建一次性任务、在指定会话中主动联系的软件拥有 Skill。
- `traveling-merchant`：由 Suzu 调度器按计划抓取网页、保存状态并投递到指定会话的软件拥有执行器。

这些模块不会自行触发模型、设备、浏览器或站点。只有稳定入口的 `ability invoke` 通过门禁，并消费软件控制面签发的短时、单次、能力/动作/作用域绑定凭证后，才会调用配置后的软件执行器；CLI 不能自行签发凭证。当前缺少安全凭据来源或已验证 bridge 协议的能力会保持不可启用；测试始终使用临时目录与 fake adapter。
