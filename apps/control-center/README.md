# Suzu Lives

Suzu Lives 的本地桌面端。它管理每位联系人的受管资料目录、Agent Core 会话、会话设置、软件能力、连接配置和本地用量记录。

## 当前功能

- 在桌面端创建、选择联系人；每位联系人都有独立的受管资料和会话工作区；
- 读取并驱动当前联系人的 Agent Core 会话，支持普通消息、排队消息、停止与引导；
- 配置软件能力、模型/API 连接、微信会话绑定和本地媒体交付；
- 查看软件与 Agent Core 会话的用量和价格历史。

## 本地开发

请在仓库根目录执行 workspace 命令：

```powershell
cd <Suzu-Lives-仓库根目录>
npm install
npm run start --workspace=suzu-lives-console
```

Agent Core 由桌面端随软件管理。联系人资料默认保存在软件数据目录的 `contacts` 子目录；更换软件数据目录时，联系人资料与 Agent Core 会话历史会一起迁移。

## 验证与打包

```powershell
npm test
npm run dist
```

构建目标是 Windows ZIP，输出在 `apps/control-center/dist/`。解压 ZIP 后运行其中的 `Suzu Lives.exe`；目标电脑无需另装 Node.js 或 Electron。
