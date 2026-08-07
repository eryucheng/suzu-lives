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

`npm run dist` 生成 Windows ZIP 发布包，输出位于 `apps/control-center/dist/`。解压 ZIP 后运行其中的 `Suzu Lives Console.exe`；目标电脑不需要另装 Node.js 或 Electron。
