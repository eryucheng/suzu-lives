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

如果 `.claude/settings.json` 已经存在，不要直接覆盖文件。把示例中的两个 `UserPromptSubmit` 条目和一个 `MessageDisplay` 条目合并到现有 `hooks` 对象中。

所有脚本路径都使用 `${CLAUDE_PROJECT_DIR}`，仓库移动到其他用户或其他目录后不需要修改。

只安装单个模块时，继续使用对应模块目录中的说明和示例即可。

压缩器和会话查看器不属于 Hook：压缩器按需手动或定时运行，会话查看器需要查看记录时再启动，因此不会出现在这份 Claude Code 配置中。

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
