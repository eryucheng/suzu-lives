# Suzu Lives

Suzu Lives 是独立桌面软件。默认 Claude Code 已由用户自行安装；用户在软件中选择联系人 Agent 的工作目录，记忆、自动化、媒体处理、设备连接、网页操作和用量统计等能力均由软件管理。

最终用户的使用边界是：软件安装在用户选择的位置，功能代码由软件执行，设置和运行数据由软件统一管理；Claude 项目中只登记 Suzu Lives 生成的 `CLAUDE.md` 与 `SKILL.md` 等轻量接入文件。项目目录不保存功能脚本、缓存、索引或复杂设置。

## 当前目录

- `apps/control-center/`：桌面端界面，承载联系人、Claude 会话、能力设置、连接配置与用量查看。
- `packages/`：软件实际运行的共享能力代码。
- `docs/`：软件架构和模块边界。

软件把运行日志、API 流水、缓存、索引和备份保存在自己的数据目录中。Claude 项目路径只用于登记接入和识别用户要连接的本地会话，不用于运行能力或保存设置。

模型价格通过软件设置保存为带生效时间的价格历史。API 流水只记录原始 usage，查看费用时再按调用时间匹配对应价格。

## 开发

请在仓库根目录执行，不要在单个 workspace 内单独安装依赖：

```powershell
cd <Suzu-Lives-仓库根目录>
npm install
npm start
```

测试和打包：

```powershell
npm test
npm run dist
```

`npm run dist` 生成 Windows ZIP 测试包，输出位于 `apps/control-center/dist/`。ZIP 包不能自动覆盖安装，不用于正式更新发布。

正式发布请构建 NSIS 安装包：

```powershell
npm run dist:installer
```

首次使用者手动安装 NSIS 包后，后续正式版本可在软件的“设置 → 软件更新”中检查、下载并重启安装。

## 官方发布签名

官方发布包会同时提供同名的 `.sig` 文件。它是由 Ed25519 私钥签发的可验证发布声明，而不是 Windows 代码签名证书。

- Key ID：`eryuchengye`
- 公钥：`release-keys/eryuchengye.ed25519.pub`
- 公钥指纹（SHA-256）：`c64c364830cebaa7e605f2fb5097296dca54076d3eef0a704301cebed6c982e7`

首次在可信的发布电脑上生成密钥：

```powershell
npm run generate:release-key
```

私钥默认仅保存于 `%USERPROFILE%\.suzu-lives\release-signing\eryuchengye.ed25519.private.pem`，不在仓库中。打包后对具体发布包签名并校验：

```powershell
npm run dist:installer
npm run sign:release -- --artifact "apps/control-center/dist/Suzu-Lives-Console-0.1.1-win-x64.exe"
npm run verify:release -- --artifact "apps/control-center/dist/Suzu-Lives-Console-0.1.1-win-x64.exe"
```

需要换电脑发布时，可以通过加密 U 盘、密码管理器等可信方式复制这一个私钥文件到新电脑的相同位置；或者先设置 `SUZU_RELEASE_SIGNING_KEY` 指向其受保护的本地副本。任何拿到私钥的人都能伪装成官方发布者，因此不要提交、上传或发到聊天记录中。

公开仓库的 `v<版本号>` tag 会触发 Windows Release 工作流，自动上传 NSIS 安装程序、`latest.yml`、blockmap 和安装程序签名。首次触发前，维护者需要在 `eryucheng/suzu-lives` 的 Actions Secrets 中设置 `SUZU_RELEASE_SIGNING_PRIVATE_KEY`；值为私钥 PEM 文件的完整内容。
