# 整套安装配置

这里提供同时启用多个 Suzu Lives 模块时使用的配置入口，避免分别复制 Hook 时覆盖已有数组。

## Claude Code

如果项目还没有 `.claude/settings.json`，可以把：

```text
integrations/claude-code/settings.example.json
```

复制为：

```text
项目目录/.claude/settings.json
```

这份配置同时启用：

- 时间感知 `UserPromptSubmit` Hook；
- RAG 召回 `UserPromptSubmit` Hook；
- 微信分条 `MessageDisplay` Hook。

它还为以下 Agent 主动能力提供命令权限：

- iPhone 快捷指令请求；
- 手机拍照式生图；
- 云端 API 与本地 ComfyUI 的统一生图入口；
- 视觉参考库的批量维护；
- 登录态网页浏览；
- cc-connect 主动关心与临时回访 Timer。

如果 `.claude/settings.json` 已经存在，不要直接覆盖文件。把示例中的两个 `UserPromptSubmit` 条目和一个 `MessageDisplay` 条目合并到现有 `hooks` 对象中。

所有脚本路径都使用 `${CLAUDE_PROJECT_DIR}`，仓库移动到其他用户或其他目录后不需要修改。

只安装单个模块时，继续使用对应模块目录中的说明和示例即可。

压缩器、两种查看器和网页浏览器启动器不属于 Hook：它们按需运行，因此不会出现在 `hooks` 对象中。

## Claude Code Skills

仓库自带五个项目级 Skill：

- `.claude/skills/iphone-bridge`：调用已经配置的手机能力，缺失时指导新增快捷指令；
- `.claude/skills/phone-camera`：在后摄、前摄自拍和镜面自拍之间选择，并调用图像适配器；
- `.claude/skills/image-generation`：默认调用 API，并在用户明确指定时选择已注册的本地 ComfyUI 工作流；
- `.claude/skills/visual-reference-manager`：仅在用户明确要求时登记、修改、删除或校验人物与空间参考图；
- `.claude/skills/proactive-contact`：管理链式主动关心和一次性临时回访。

如果只把部分模块复制进已有 Agent 项目，同时复制对应 Skill 目录。网页浏览使用微软官方 `playwright-cli` Skill，由 `scripts/abilities/web-browser/setup.cmd` 安装，不在本仓库重复保存其源码。

## cc-connect

只有启用微信分条时才需要修改 cc-connect。把：

```text
scripts/hooks/wechat-splitter/cc-connect-hook.example.toml
```

中的 `[[hooks]]` 合并到 `~/.cc-connect/config.toml`，并把 `<PROJECT_DIR>` 换成 Agent 项目的绝对路径。该配置属于微信分条模块，因此不在这里重复保存第二份副本。

## 安装后检查

```powershell
npm run check
npm test
python .\scripts\hooks\wechat-splitter\md_send.py --check
```

前两条检查整个仓库。最后一条只在启用微信分条时运行。
